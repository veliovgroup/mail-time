import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { MailTime, mailTimePreset } from '../../index.js';
import { createQueue, createSchedulerAdapter, createTransport } from './helpers.js';

const instances = [];

const createMailTime = (opts = {}) => {
  const mailTime = new MailTime({
    queue: createQueue(),
    transports: [createTransport()],
    josk: {
      adapter: createSchedulerAdapter(),
      minRevolvingDelay: 60000,
      maxRevolvingDelay: 60000,
      ...opts.josk
    },
    ...opts
  });
  instances.push(mailTime);
  return mailTime;
};

/** Transport whose `sendMail` resolves only when the returned `finish` is called. */
const createHeldTransport = () => {
  const state = { started: null, finish: null };
  const started = new Promise((resolve) => {
    state.started = resolve;
  });
  const transport = {
    options: { from: 'no-reply@example.com' },
    sendMail(mail, done) {
      state.finish = (error, info) => done(error, info || { accepted: [].concat(mail.to), response: 'OK' });
      state.started();
    }
  };
  return { transport, started, finish: (...args) => state.finish(...args) };
};

afterEach(() => {
  for (const instance of instances.splice(0)) {
    instance.destroy?.();
    instance.scheduler?.destroy?.();
  }
});

describe('claim renewal', () => {
  it('re-stamps sendingAt while a send is in flight so a peer cannot re-claim it', async () => {
    const { transport, started, finish } = createHeldTransport();
    const mailTime = createMailTime({
      transports: [transport],
      sendingTimeout: 200,
      renewClaim: 40
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    const stored = mailTime.queue.records.get(uuid);
    const send = mailTime.___send({ ...stored });

    await started;
    const claimedAt = mailTime.queue.records.get(uuid).sendingAt;
    await new Promise((resolve) => setTimeout(resolve, 260));
    const renewedAt = mailTime.queue.records.get(uuid).sendingAt;

    expect(renewedAt).toBeGreaterThan(claimedAt);
    // Still inside its lease from the storage's point of view, so a peer's
    // claim guard refuses — no duplicate submission.
    expect(renewedAt).toBeGreaterThan(Date.now() - 200);

    finish(null);
    await send;
  });

  it('completes normally after renewals, using the renewed lease', async () => {
    const { transport, started, finish } = createHeldTransport();
    const onSent = jest.fn();
    const mailTime = createMailTime({
      transports: [transport],
      sendingTimeout: 200,
      renewClaim: 40,
      onSent
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    const send = mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    await started;
    await new Promise((resolve) => setTimeout(resolve, 150));
    finish(null);
    await send;

    expect(onSent).toHaveBeenCalledTimes(1);
    expect(mailTime.queue.records.has(uuid)).toBe(false);
  });

  it('waits for an in-flight renewal before completing the send', async () => {
    const { transport, started, finish } = createHeldTransport();
    const onSent = jest.fn();
    const mailTime = createMailTime({
      transports: [transport],
      sendingTimeout: 200,
      renewClaim: 20,
      onSent
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    const realUpdate = mailTime.queue.update;
    const realRemove = mailTime.queue.remove;
    let releaseRenewal;
    let releaseCompletion;
    let completionHasStarted = false;
    const renewalStarted = new Promise((resolve) => {
      mailTime.queue.update = async (task, updateObj) => {
        if (updateObj.isSending === true && updateObj.tries === void 0) {
          resolve();
          await new Promise((release) => {
            releaseRenewal = release;
          });
        }
        return realUpdate(task, updateObj);
      };
    });
    const completionStarted = new Promise((resolve) => {
      mailTime.queue.remove = async (...args) => {
        completionHasStarted = true;
        resolve();
        await new Promise((release) => {
          releaseCompletion = release;
        });
        return realRemove(...args);
      };
    });

    const send = mailTime.___send({ ...mailTime.queue.records.get(uuid) });
    await started;
    await renewalStarted;
    finish(null);
    expect(completionHasStarted).toBe(false);
    releaseRenewal();
    await completionStarted;
    releaseCompletion();
    await send;

    expect(onSent).toHaveBeenCalledTimes(1);
    expect(mailTime.queue.records.has(uuid)).toBe(false);
  });

  it('stops renewing after maxRenewals so a wedged send is still recoverable', async () => {
    const { transport, started, finish } = createHeldTransport();
    const mailTime = createMailTime({
      transports: [transport],
      sendingTimeout: 200,
      renewClaim: 20,
      maxRenewals: 2
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    const send = mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    await started;
    await new Promise((resolve) => setTimeout(resolve, 200));
    const settledAt = mailTime.queue.records.get(uuid).sendingAt;
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(mailTime.queue.records.get(uuid).sendingAt).toBe(settledAt);

    finish(null);
    await send;
  });

  it('does not renew when renewClaim is false', async () => {
    const { transport, started, finish } = createHeldTransport();
    const mailTime = createMailTime({
      transports: [transport],
      sendingTimeout: 200,
      renewClaim: false
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    const send = mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    await started;
    const claimedAt = mailTime.queue.records.get(uuid).sendingAt;
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(mailTime.queue.records.get(uuid).sendingAt).toBe(claimedAt);

    finish(null);
    await send;
  });

  it('stops renewing once the lease is lost to a peer', async () => {
    const { transport, started, finish } = createHeldTransport();
    const mailTime = createMailTime({
      transports: [transport],
      sendingTimeout: 200,
      renewClaim: 30
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    const send = mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    await started;
    // A peer re-claims: bump `tries`, which breaks this worker's lease guard.
    const record = mailTime.queue.records.get(uuid);
    record.tries += 1;
    record.sendingAt = Date.now();
    const stolenAt = record.sendingAt;

    await new Promise((resolve) => setTimeout(resolve, 120));
    expect(mailTime.queue.records.get(uuid).sendingAt).toBe(stolenAt);

    finish(null);
    await send;
  });

  it('stops renewing when the instance is destroyed mid-send', async () => {
    const { transport, started, finish } = createHeldTransport();
    const mailTime = createMailTime({
      transports: [transport],
      sendingTimeout: 200,
      renewClaim: 30
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    const send = mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    await started;
    mailTime.destroy();
    const atDestroy = mailTime.queue.records.get(uuid).sendingAt;
    await new Promise((resolve) => setTimeout(resolve, 120));

    expect(mailTime.queue.records.get(uuid).sendingAt).toBe(atDestroy);

    finish(null);
    await send;
  });

  it('stops renewing and reports a storage failure', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const { transport, started, finish } = createHeldTransport();
    const mailTime = createMailTime({
      transports: [transport],
      sendingTimeout: 200,
      renewClaim: 30
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    const send = mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    await started;
    const realUpdate = mailTime.queue.update;
    let renewAttempts = 0;
    mailTime.queue.update = async (task, updateObj) => {
      if (updateObj.isSending === true && updateObj.tries === void 0) {
        renewAttempts += 1;
        throw new Error('storage unavailable');
      }
      return realUpdate(task, updateObj);
    };

    await new Promise((resolve) => setTimeout(resolve, 130));
    expect(renewAttempts).toBe(1);
    expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/claim renewal/);

    mailTime.queue.update = realUpdate;
    finish(null);
    await send;
    errorSpy.mockRestore();
  });

  it('is enabled by default at a fraction of sendingTimeout', () => {
    const mailTime = createMailTime({ sendingTimeout: 300000 });
    expect(mailTime.renewClaim).toBe(100000);
    expect(mailTime.maxRenewals).toBeGreaterThan(0);
  });

  it('rejects non-finite lease timing values', () => {
    const mailTime = createMailTime({
      sendingTimeout: Infinity,
      renewClaim: Infinity,
      maxRenewals: Infinity
    });

    expect(mailTime.sendingTimeout).toBe(300000);
    expect(mailTime.renewClaim).toBe(100000);
    expect(mailTime.maxRenewals).toBe(10);
  });
});

describe('transport fail-over policy', () => {
  const twoTransports = () => [
    createTransport((mail, done) => done(new Error('primary down'))),
    createTransport((mail, done) => done(null, { accepted: [].concat(mail.to), response: 'OK' }))
  ];

  it('rotates transports on error by default', async () => {
    const mailTime = createMailTime({
      transports: twoTransports(),
      failsToNext: 1,
      retryDelay: 0
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    await mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    expect(mailTime.queue.records.get(uuid).transport).toBe(1);
  });

  it('keeps the transport when the error says it must not fail over', async () => {
    const transports = [
      createTransport((mail, done) => {
        const error = new Error('MX went silent after DATA');
        error.mayFailOver = false;
        done(error);
      }),
      createTransport((mail, done) => done(null, { accepted: [].concat(mail.to), response: 'OK' }))
    ];
    const mailTime = createMailTime({ transports, failsToNext: 1, retryDelay: 0 });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    await mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    expect(mailTime.queue.records.get(uuid).transport).toBe(0);
  });

  it('honours a shouldFailOver hook and passes it the failure context', async () => {
    const shouldFailOver = jest.fn(() => false);
    const mailTime = createMailTime({
      transports: twoTransports(),
      failsToNext: 1,
      retryDelay: 0,
      shouldFailOver
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    await mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    expect(mailTime.queue.records.get(uuid).transport).toBe(0);
    expect(shouldFailOver).toHaveBeenCalledTimes(1);
    const [error, , task] = shouldFailOver.mock.calls[0];
    expect(error).toBeInstanceOf(Error);
    expect(task.uuid).toBe(uuid);
  });

  it('still rotates when the hook allows it', async () => {
    const mailTime = createMailTime({
      transports: twoTransports(),
      failsToNext: 1,
      retryDelay: 0,
      shouldFailOver: () => true
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    await mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    expect(mailTime.queue.records.get(uuid).transport).toBe(1);
  });

  it('keeps the current transport when shouldFailOver throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mailTime = createMailTime({
      transports: twoTransports(),
      failsToNext: 1,
      retryDelay: 0,
      shouldFailOver() {
        throw new Error('policy unavailable');
      }
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    await mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    expect(mailTime.queue.records.get(uuid)).toMatchObject({
      isSending: false,
      transport: 0
    });
    expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/shouldFailOver/);
    errorSpy.mockRestore();
  });
});

describe('from() resolution for class-instance transports', () => {
  /** nodemailer sets `Mail.options = {}` for any transporter with its own `send()`. */
  const classInstanceTransport = () => ({
    options: {},
    transporter: { options: { from: 'direct@example.com' } },
    sendMail(mail, done) {
      done(null, { accepted: [].concat(mail.to), response: 'OK', envelopeFrom: mail.from });
    }
  });

  it('resolves the transport from even when options.from is unreachable', async () => {
    const seen = [];
    const mailTime = createMailTime({
      transports: [classInstanceTransport()],
      from: (transport, details) => {
        seen.push(details);
        return `"App" <${details.from}>`;
      }
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], mailTime.queue.records.get(uuid));

    expect(compiled.from).toBe('"App" <direct@example.com>');
    expect(seen[0]).toMatchObject({ index: 0, from: 'direct@example.com' });
  });

  it('keeps single-argument callbacks working', async () => {
    const mailTime = createMailTime({
      from: (transport) => `"App" <${transport.options.from}>`
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], mailTime.queue.records.get(uuid));

    expect(compiled.from).toBe('"App" <no-reply@example.com>');
  });

  it('normalizes an address object to its sender address', () => {
    expect(MailTime.transportFrom({
      options: {
        from: { name: 'App', address: 'no-reply@example.com' }
      }
    })).toBe('no-reply@example.com');
  });
});

describe('lifecycle callback isolation', () => {
  it('does not turn a delivered message into an unhandled rejection when onSent throws', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mailTime = createMailTime({
      onSent() {
        throw new Error('observer unavailable');
      }
    });

    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    await mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    expect(mailTime.queue.records.has(uuid)).toBe(false);
    expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/onSent/);
    errorSpy.mockRestore();
  });

  it('contains a storage error raised after SMTP accepts the message', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const mailTime = createMailTime();
    const uuid = await mailTime.sendMail({ to: 'a@example.com', text: 'hi' });
    mailTime.queue.remove = async () => {
      throw new Error('storage unavailable');
    };

    await mailTime.___send({ ...mailTime.queue.records.get(uuid) });

    expect(mailTime.queue.records.get(uuid).isSending).toBe(true);
    expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/completion/);
    errorSpy.mockRestore();
  });
});

describe('queued payload policy', () => {
  it('refuses a raw MIME override at enqueue', async () => {
    const mailTime = createMailTime();

    await expect(mailTime.sendMail({
      to: 'a@example.com',
      text: 'hi',
      raw: 'From: evil@example.com\r\n\r\nbody'
    })).rejects.toThrow(/raw/);
  });

  it('strips raw from a task that reached storage anyway', () => {
    const mailTime = createMailTime();
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], {
      uuid: 'forged',
      mailOptions: [{ to: 'a@example.com', text: 'hi', raw: 'From: evil@example.com\r\n\r\nbody' }]
    });

    expect(compiled.raw).toBeUndefined();
  });

  it('passes attachments through by default (documented behaviour)', () => {
    const mailTime = createMailTime();
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], {
      uuid: 'ok',
      mailOptions: [{ to: 'a@example.com', text: 'hi', attachments: [{ filename: 'a.txt', content: 'x' }] }]
    });

    expect(compiled.attachments).toHaveLength(1);
    expect(compiled.disableFileAccess).toBeUndefined();
  });

  it('locks the payload down under strictPayload', () => {
    const mailTime = createMailTime({ strictPayload: true });
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], {
      uuid: 'strict',
      mailOptions: [{
        to: 'a@example.com',
        text: 'hi',
        attachments: [{ path: '/etc/passwd' }],
        envelope: { from: 'evil@example.com' }
      }]
    });

    expect(compiled.disableFileAccess).toBe(true);
    expect(compiled.disableUrlAccess).toBe(true);
    expect(compiled.attachments).toBeUndefined();
    expect(compiled.envelope).toBeUndefined();
    expect(compiled.to).toBe('a@example.com');
  });

  it('lets allowedMailFields widen the strict allowlist', () => {
    const mailTime = createMailTime({ strictPayload: true, allowedMailFields: ['attachments'] });
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], {
      uuid: 'strict-plus',
      mailOptions: [{ to: 'a@example.com', text: 'hi', attachments: [{ filename: 'a.txt', content: 'x' }] }]
    });

    expect(compiled.attachments).toHaveLength(1);
  });

  it('keeps MailTime-owned fields under strictPayload', () => {
    const mailTime = createMailTime({ strictPayload: true, template: '<div>{{{html}}}</div>' });
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], {
      uuid: 'strict-owned',
      mailOptions: [{ to: 'a@example.com', html: '<p>hi</p>', subject: 'S', cc: 'c@example.com' }]
    });

    expect(compiled.subject).toBe('S');
    expect(compiled.cc).toBe('c@example.com');
    expect(compiled.html).toContain('<p>hi</p>');
  });
});

describe('template rendering escapes double-brace values', () => {
  it('escapes an unterminated tag instead of stripping it', () => {
    const mailTime = createMailTime({ template: '<h1>{{subject}}</h1>{{{html}}}' });
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], {
      uuid: 'xss',
      mailOptions: [{ to: 'a@example.com', html: '<p>body</p>', subject: '<a href="https://evil.example"' }]
    });

    expect(compiled.html).not.toContain('<a href="https://evil.example"');
    expect(compiled.html).toContain('&lt;a href=&quot;https://evil.example&quot;');
    expect(compiled.html).toContain('<p>body</p>');
  });

  it('escapes the five significant HTML characters', () => {
    const mailTime = createMailTime({ template: '{{subject}}' });
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], {
      uuid: 'esc',
      mailOptions: [{ to: 'a@example.com', html: 'x', subject: `<&>"'` }]
    });

    expect(compiled.html).toBe('&lt;&amp;&gt;&quot;&#39;');
  });

  it('does not escape a text/plain body — there is no markup to escape', () => {
    const mailTime = createMailTime();
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], {
      uuid: 'text-ctx',
      mailOptions: [{ to: 'a@example.com', text: 'reply to {{contact}} if x < y', contact: '<ops@example.com>' }]
    });

    expect(compiled.text).toBe('reply to <ops@example.com> if x < y');
  });

  it('does not escape a concatenated subject — a header is not HTML', () => {
    const mailTime = createMailTime({ concatEmails: true, concatSubject: 'You have {{count}} & more' });
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], {
      uuid: 'subject-ctx',
      mailOptions: [
        { to: 'a@example.com', html: '<p>one</p>' },
        { to: 'a@example.com', html: '<p>two</p>' }
      ]
    });

    expect(compiled.subject).toBe('You have 2 & more');
  });

  it('leaves triple-brace values verbatim', () => {
    const mailTime = createMailTime({ template: '{{{html}}}' });
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], {
      uuid: 'raw-html',
      mailOptions: [{ to: 'a@example.com', html: '<p><a href="https://ok.example">ok</a></p>' }]
    });

    expect(compiled.html).toBe('<p><a href="https://ok.example">ok</a></p>');
  });

  it('does not inject a queued subject raw into the shipped default template', () => {
    const mailTime = createMailTime({ template: MailTime.Template });
    const compiled = mailTime.___compileMailOpts(mailTime.transports[0], {
      uuid: 'default-template',
      mailOptions: [{ to: 'a@example.com', html: '<p>body</p>', subject: '<img src=x onerror=alert(1)>' }]
    });

    expect(compiled.html).not.toContain('<img src=x onerror=alert(1)>');
    expect(compiled.html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
});

describe('preset lease floors', () => {
  it('every preset leaves room for a real SMTP roundtrip', () => {
    for (const name of ['transactional', 'otp', 'newsletter', 'marketing', 'notifications', 'alerts']) {
      const preset = mailTimePreset(name);
      const sendingTimeout = preset.sendingTimeout ?? 300000;
      expect(sendingTimeout).toBeGreaterThanOrEqual(120000);
    }
  });

  it('warns when sendingTimeout is below the safe floor', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    createMailTime({ sendingTimeout: 5000 });

    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.flat().join(' ')).toMatch(/sendingTimeout/);
    errorSpy.mockRestore();
  });

  it('does not warn at or above the floor', () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    createMailTime({ sendingTimeout: 120000 });

    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});

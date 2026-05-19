import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { MailTime, PostgresQueue } from '../../index.js';
import { createPostgresClient, createQueue, createSchedulerAdapter, createTransport } from './helpers.js';

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

afterEach(() => {
  for (const instance of instances.splice(0)) {
    instance.destroy?.();
    instance.scheduler?.destroy?.();
  }
});

describe('MailTime core options', () => {
  it('validates constructor input and required queue methods', () => {
    expect(() => new MailTime()).toThrow('[mail-time] Configuration object must be passed');
    expect(() => new MailTime({})).toThrow('[mail-time] {queue} option is required');
    expect(() => new MailTime({
      queue: {
        ping() {}
      }
    })).toThrow('{queue} instance is missing');
  });

  it('validates server scheduler and transport options', () => {
    expect(() => new MailTime({
      queue: createQueue(),
      transports: []
    })).toThrow('[mail-time] {transports} is required');

    expect(() => new MailTime({
      queue: createQueue(),
      transports: [createTransport()]
    })).toThrow('[mail-time] {josk} option is required');

    expect(() => new MailTime({
      queue: createQueue(),
      transports: [createTransport()],
      josk: {}
    })).toThrow('[mail-time] {josk.adapter} option is required');

    expect(() => new MailTime({
      queue: createQueue(),
      transports: [createTransport()],
      josk: {
        adapter: {
          type: 'mongo'
        }
      }
    })).toThrow('[mail-time] {josk.adapter.db} option required');

    expect(() => new MailTime({
      queue: createQueue(),
      transports: [createTransport()],
      josk: {
        adapter: {
          type: 'redis'
        }
      }
    })).toThrow('[mail-time] {josk.adapter.client} option required');

    expect(() => new MailTime({
      queue: createQueue(),
      transports: [createTransport()],
      josk: {
        adapter: {
          type: 'postgres'
        }
      }
    })).toThrow('[mail-time] {josk.adapter.client} option required');
  });

  it('rejects negative retries', () => {
    expect(() => createMailTime({ retries: -1 })).toThrow('[mail-time] {retries} must be a non-negative number');
  });

  it('normalizes legacy aliases and defaults', () => {
    const mailTime = createMailTime({
      type: 'unknown',
      maxTries: 0,
      interval: 3,
      concatThrottling: 2,
      strategy: 'wrong',
      from: 'sender@example.com'
    });

    expect(mailTime.type).toBe('server');
    expect(mailTime.maxTries).toBe(1);
    expect(mailTime.retryDelay).toBe(3000);
    expect(mailTime.concatDelay).toBe(2000);
    expect(mailTime.strategy).toBe('backup');
    expect(mailTime.from()).toBe('sender@example.com');
  });

  it('exports PostgresQueue', () => {
    expect(PostgresQueue).toEqual(expect.any(Function));
  });

  it('pings client queue without scheduler', async () => {
    const queue = createQueue();
    const mailTime = new MailTime({
      type: 'client',
      queue
    });
    instances.push(mailTime);

    await expect(mailTime.ping()).resolves.toMatchObject({
      status: 'OK',
      code: 200,
      statusCode: 200
    });
  });

  it('keeps startup failures on ready without unhandled rejection', async () => {
    const queue = createQueue();
    queue.ping = jest.fn(async () => ({
      status: 'FAIL',
      code: 503,
      statusCode: 503
    }));
    const unhandled = jest.fn();
    process.once('unhandledRejection', unhandled);
    const mailTime = new MailTime({
      type: 'client',
      queue
    });
    instances.push(mailTime);

    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    process.removeListener('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    await expect(mailTime.ready()).rejects.toThrow('[mail-time] [MailTime#ready]');
  });

  it('supports postgres scheduler shortcut', async () => {
    const pgClient = createPostgresClient();
    const mailTime = createMailTime({
      josk: {
        adapter: {
          type: 'postgres',
          client: pgClient
        },
        execute: 'one',
        lockOwnerId: 'mail-time-test-owner',
        resetOnInit: true
      }
    });

    await expect(mailTime.ready()).resolves.toBe(mailTime);
    expect(mailTime.scheduler.adapter.name).toBe('postgres');
    expect(mailTime.scheduler.execute).toBe('one');
    expect(mailTime.scheduler.lockOwnerId).toBe('mail-time-test-owner');
    expect(mailTime.scheduler.adapter.resetOnInit).toBe(true);
  });

  it('destroys scheduler and reports repeated destroy', () => {
    const mailTime = createMailTime();

    expect(mailTime.destroy()).toBe(true);
    expect(mailTime.scheduler.isDestroyed).toBe(true);
    expect(mailTime.destroy()).toBe(false);
  });
});

describe('MailTime send and render behavior', () => {
  it('gets and sets default template', () => {
    const original = MailTime.Template;
    MailTime.Template = '{{{html}}} custom';
    expect(MailTime.Template).toBe('{{{html}}} custom');
    MailTime.Template = original;
  });

  it('renders falsey placeholder values', () => {
    const mailTime = createMailTime();

    expect(mailTime.___render('count={{count}} html={{{html}}} empty={{empty}}', {
      count: 0,
      html: 0,
      empty: ''
    })).toBe('count=0 html=0 empty=');
    expect(mailTime.___render('{{missing}} {{{missingHtml}}}', {})).toBe('{{missing}} {{{missingHtml}}}');
  });

  it('compiles mail options without mutating queued task mailOptions', () => {
    const mailTime = createMailTime();
    const task = {
      uuid: 'compile-test',
      mailOptions: [{
        to: 'user@example.com',
        subject: 'Subject',
        text: 'Plain {{count}}',
        html: '<p>{{count}}</p>',
        count: 0
      }],
      template: '{{{html}}}',
      concatSubject: false
    };

    const before = structuredClone(task.mailOptions);
    const compiled = mailTime.___compileMailOpts(createTransport(), task);

    expect(compiled.html).toBe('<p>0</p>');
    expect(compiled.text).toBe('Plain 0');
    expect(task.mailOptions).toEqual(before);
  });

  it('compiles multiple messages with concat subject and from function', () => {
    const mailTime = createMailTime({
      concatSubject: 'Batch',
      concatDelimiter: '<br>',
      from: (transport) => `from-${transport.options.from}`
    });
    const transport = {
      _options: {
        mailOptions: {
          priority: 'high'
        }
      },
      options: {
        from: 'smtp@example.com'
      }
    };
    const compiled = mailTime.___compileMailOpts(transport, {
      mailOptions: [{
        to: 'user@example.com',
        subject: 'One',
        text: 'One',
        html: '<p>One</p>'
      }, {
        to: 'user@example.com',
        subject: 'Two',
        text: 'Two',
        html: '<p>Two</p>'
      }],
      template: '{{{html}}}',
      concatSubject: false
    });

    expect(compiled.subject).toBe('Batch');
    expect(compiled.from).toBe('from-smtp@example.com');
    expect(compiled.priority).toBe('high');
    expect(compiled.html).toContain('<br><p>One</p>');
    expect(compiled.text).toContain('One');
    expect(() => mailTime.___compileMailOpts(null, { mailOptions: [] })).toThrow('{transport} is not available');
  });

  it('validates sendMail options', async () => {
    const mailTime = createMailTime();

    await expect(mailTime.sendMail({ to: 'user@example.com' })).rejects.toThrow('`html` nor `text` field');
    await expect(mailTime.sendMail({
      text: 'Text'
    })).rejects.toThrow('`mailOptions.to` is required');
  });

  it('supports aliases and cancel promise', async () => {
    const mailTime = createMailTime({
      type: 'client'
    });
    const uuid = await mailTime.send({
      to: 'user@example.com',
      text: 'Text'
    });

    await expect(mailTime.cancel(Promise.resolve(uuid))).resolves.toBe(true);
    expect(mailTime.queue.records.has(uuid)).toBe(false);
  });

  it('concatenates duplicate messages by content', async () => {
    const mailTime = createMailTime({
      concatEmails: true,
      concatDelay: 1000
    });

    const first = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'Hello',
      text: 'Hello',
      html: '<p>Hello</p>'
    });
    const second = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'Hello',
      text: 'Hello',
      html: '<p>Hello</p>'
    });

    expect(second).toBe(first);
    expect(mailTime.queue.records.get(first).mailOptions).toHaveLength(1);
  });

  it('deduplicates concatenated scheduled template messages', async () => {
    const mailTime = createMailTime({
      concatEmails: true,
      concatDelay: 1000
    });
    const sendAt = Date.now() + 5000;
    const first = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'Hello',
      text: 'Hello',
      html: '<p>{{count}}</p>',
      template: '<main>{{{html}}}</main>',
      sendAt,
      count: 1
    });
    const second = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'Other',
      text: 'Other',
      html: '<p>{{count}}</p>',
      template: '<main>{{{html}}}</main>',
      sendAt,
      count: 2
    });
    const third = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'Other',
      text: 'Other',
      html: '<p>{{count}}</p>',
      template: '<main>{{{html}}}</main>',
      sendAt,
      count: 2
    });

    expect(second).toBe(first);
    expect(third).toBe(first);
    expect(mailTime.queue.records.get(first).mailOptions).toHaveLength(2);
  });

  it('concatenates different messages into pending task', async () => {
    const mailTime = createMailTime({
      concatEmails: true,
      concatDelay: 1000,
      keepHistory: true
    });
    const first = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'Hello',
      text: 'Hello',
      html: '<p>Hello</p>',
      vars: [{ a: 1 }, { b: 2 }]
    });
    const second = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'Hello 2',
      text: 'Hello 2',
      html: '<p>Hello 2</p>',
      vars: [{ b: 2 }, { a: 1 }]
    });

    expect(second).toBe(first);
    expect(mailTime.queue.records.get(first).mailOptions).toHaveLength(2);
  });

  it('accepts concatEmails as an object and stores its subject template', () => {
    const mailTime = createMailTime({
      concatEmails: { subject: '{{count}} new notifications' }
    });

    expect(mailTime.concatEmails).toBe(true);
    expect(mailTime.concatSubject).toBe('{{count}} new notifications');
  });

  it('falls back to default concatSubject when concatEmails object lacks a subject', () => {
    const emptyObj = createMailTime({ concatEmails: {} });
    expect(emptyObj.concatEmails).toBe(true);
    expect(emptyObj.concatSubject).toBe('Multiple notifications');

    const withConcatSubject = createMailTime({
      concatEmails: {},
      concatSubject: 'Folded letter'
    });
    expect(withConcatSubject.concatEmails).toBe(true);
    expect(withConcatSubject.concatSubject).toBe('Folded letter');

    const nonStringSubject = createMailTime({
      concatEmails: { subject: 42 }
    });
    expect(nonStringSubject.concatEmails).toBe(true);
    expect(nonStringSubject.concatSubject).toBe('Multiple notifications');
  });

  it('concatEmails object subject overrides standalone concatSubject option', () => {
    const mailTime = createMailTime({
      concatEmails: { subject: 'Inline {{count}}' },
      concatSubject: 'Ignored'
    });

    expect(mailTime.concatSubject).toBe('Inline {{count}}');
  });

  it('treats unknown concatEmails values as disabled', () => {
    const nullish = createMailTime({ concatEmails: null });
    expect(nullish.concatEmails).toBe(false);

    const stringy = createMailTime({ concatEmails: 'yes' });
    expect(stringy.concatEmails).toBe(false);
  });

  it('renders {{count}} placeholder in the concat subject when folding letters', () => {
    const mailTime = createMailTime({
      concatEmails: { subject: '{{count}} new notifications' }
    });

    const compiled = mailTime.___compileMailOpts(createTransport(), {
      mailOptions: [
        { to: 'user@example.com', subject: 'One', text: 'One' },
        { to: 'user@example.com', subject: 'Two', text: 'Two' },
        { to: 'user@example.com', subject: 'Three', text: 'Three' }
      ],
      template: '{{{html}}}',
      concatSubject: false
    });

    expect(compiled.subject).toBe('3 new notifications');
  });

  it('renders {{count}} in per-letter concatSubject override', () => {
    const mailTime = createMailTime({ concatEmails: true });

    const compiled = mailTime.___compileMailOpts(createTransport(), {
      mailOptions: [
        { to: 'user@example.com', subject: 'One', text: 'One' },
        { to: 'user@example.com', subject: 'Two', text: 'Two' }
      ],
      template: '{{{html}}}',
      concatSubject: 'You have {{count}} updates'
    });

    expect(compiled.subject).toBe('You have 2 updates');
  });

  it('leaves single-letter subject untouched even when concat subject template is set', () => {
    const mailTime = createMailTime({
      concatEmails: { subject: '{{count}} new notifications' }
    });

    const compiled = mailTime.___compileMailOpts(createTransport(), {
      mailOptions: [
        { to: 'user@example.com', subject: 'Only one', text: 'Only one' }
      ],
      template: '{{{html}}}',
      concatSubject: false
    });

    expect(compiled.subject).toBe('Only one');
  });

  it('folds emails the same way when concatEmails is given as an object', async () => {
    const mailTime = createMailTime({
      concatEmails: { subject: '{{count}} bundled' },
      concatDelay: 1000
    });

    const first = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'Hello',
      text: 'Hello'
    });
    const second = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'Different',
      text: 'Different body'
    });

    expect(second).toBe(first);
    expect(mailTime.queue.records.get(first).mailOptions).toHaveLength(2);
  });

  it('retries failed mail with updated sendAt and next backup transport', async () => {
    const firstTransport = createTransport((_mail, done) => done(new Error('smtp down'), {
      accepted: []
    }));
    const secondTransport = createTransport();
    const onError = jest.fn();
    const mailTime = createMailTime({
      transports: [firstTransport, secondTransport],
      strategy: 'backup',
      failsToNext: 1,
      retryDelay: 250,
      retries: 2,
      onError
    });
    const uuid = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'Retry',
      text: 'Retry',
      html: '<p>Retry</p>'
    });
    const task = mailTime.queue.records.get(uuid);
    const before = Date.now();

    await mailTime.___send(task);

    expect(onError).not.toHaveBeenCalled();
    expect(task.isSent).toBe(false);
    expect(task.transport).toBe(1);
    expect(task.sendAt).toBeGreaterThanOrEqual(before + 200);
  });

  it('handles final failure by removing or keeping failed task', async () => {
    const failingTransport = createTransport((_mail, done) => done(new Error('smtp down'), {
      accepted: []
    }));
    const onError = jest.fn();
    const mailTime = createMailTime({
      transports: [failingTransport],
      retries: 0,
      onError
    });
    const uuid = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'Fail',
      text: 'Fail'
    });
    const task = mailTime.queue.records.get(uuid);

    await mailTime.___send(task);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(mailTime.queue.records.has(uuid)).toBe(false);

    const keepHistory = createMailTime({
      transports: [failingTransport],
      retries: 0,
      keepHistory: true,
      onError
    });
    const keptUuid = await keepHistory.sendMail({
      to: 'user@example.com',
      subject: 'Fail',
      text: 'Fail'
    });
    const keptTask = keepHistory.queue.records.get(keptUuid);

    await keepHistory.___send(keptTask);

    expect(keptTask.isFailed).toBe(true);
    expect(keepHistory.queue.records.has(keptUuid)).toBe(true);
    await expect(keepHistory.___handleError(null, new Error('ignored'), {})).resolves.toBeUndefined();
  });

  it('sends successfully, balances transports, and skips unavailable updates', async () => {
    const onSent = jest.fn();
    const firstTransport = createTransport();
    const secondTransport = createTransport();
    const mailTime = createMailTime({
      transports: [firstTransport, secondTransport],
      strategy: 'balancer',
      onSent
    });
    const uuid = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'Sent',
      text: 'Sent'
    });
    const task = mailTime.queue.records.get(uuid);

    await mailTime.___send(task);

    expect(onSent).toHaveBeenCalledTimes(1);
    expect(task.isSent).toBe(true);
    expect(mailTime.queue.records.has(uuid)).toBe(false);

    await expect(mailTime.___send({
      uuid: 'skip',
      isSent: true
    })).resolves.toBeUndefined();

    const updateFalse = createMailTime();
    updateFalse.queue.update = jest.fn(async () => false);
    await expect(updateFalse.___send({
      uuid: 'missing',
      tries: 0,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      mailOptions: [{ to: 'user@example.com' }],
      transport: 0
    })).resolves.toBeUndefined();
  });

  it('allows only one server instance to claim and send a shared task', async () => {
    const records = new Map();
    const queue = {
      mailTimeInstance: null,
      records,
      async ready() {},
      async ping() {
        return {
          status: 'OK',
          code: 200,
          statusCode: 200
        };
      },
      async iterate() {},
      async getPendingTo() {
        return null;
      },
      async push(task) {
        records.set(task.uuid, { ...task });
      },
      async cancel() {
        return false;
      },
      async remove(task) {
        return records.delete(task.uuid);
      },
      async update(task, updateObj) {
        const current = records.get(task.uuid);
        if (!current) {
          return false;
        }

        if (updateObj.isSending === true && typeof updateObj.tries === 'number') {
          const now = typeof updateObj.sendingAt === 'number' ? updateObj.sendingAt : Date.now();
          const sendingTimeout = queue.mailTimeInstance?.sendingTimeout || 300000;
          if (current.isSent === true || current.isFailed === true || current.isCancelled === true || current.tries !== task.tries) {
            return false;
          }
          if (current.isSending === true && (typeof current.sendingAt === 'number' ? current.sendingAt : 0) > now - sendingTimeout) {
            return false;
          }
        }

        Object.assign(current, updateObj);
        return true;
      }
    };
    const transport = createTransport(jest.fn((_mail, done) => {
      setImmediate(() => {
        done(null, {
          accepted: [_mail.to],
          rejected: []
        });
      });
    }));
    const firstServer = createMailTime({
      queue,
      transports: [transport]
    });
    const secondServer = createMailTime({
      queue,
      transports: [transport]
    });
    const uuid = await firstServer.sendMail({
      to: 'user@example.com',
      subject: 'Race',
      text: 'Race'
    });
    const snapshot = structuredClone(records.get(uuid));

    await Promise.all([
      firstServer.___send(structuredClone(snapshot)),
      secondServer.___send(structuredClone(snapshot))
    ]);

    expect(transport.sendMail).toHaveBeenCalledTimes(1);
    expect(records.has(uuid)).toBe(false);
  });

  it('retries transport false-positive success without accepted recipients', async () => {
    const transport = createTransport((_mail, done) => done(null, {
      response: 'queued without accepted recipients'
    }));
    const onSent = jest.fn();
    const onError = jest.fn();
    const mailTime = createMailTime({
      transports: [transport],
      retries: 1,
      retryDelay: 250,
      onSent,
      onError
    });
    const uuid = await mailTime.sendMail({
      to: 'user@example.com',
      subject: 'False positive',
      text: 'False positive'
    });
    const task = mailTime.queue.records.get(uuid);
    const before = Date.now();

    await mailTime.___send(task);

    expect(onSent).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    expect(mailTime.queue.records.get(uuid)).toMatchObject({
      tries: 1,
      isSent: false,
      isFailed: false
    });
    expect(mailTime.queue.records.get(uuid).sendAt).toBeGreaterThanOrEqual(before + 200);
  });

  it('handles rejected transport compile path through error handler', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const onError = jest.fn();
    const mailTime = createMailTime({
      retries: 0,
      onError
    });
    const task = {
      uuid: 'bad-transport',
      tries: 0,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      mailOptions: [{
        to: 'user@example.com'
      }],
      transport: 99
    };
    mailTime.queue.records.set(task.uuid, task);

    await mailTime.___send(task);

    expect(onError).toHaveBeenCalledTimes(1);
    expect(mailTime.queue.records.has(task.uuid)).toBe(false);
  });

  it('skips iteration after destroy', async () => {
    const mailTime = createMailTime();
    mailTime.destroy();
    await expect(mailTime.___iterate()).resolves.toBeUndefined();
  });

  it('routes scheduler-side errors through default onError handler', async () => {
    const captured = [];
    const originalLog = console.error;
    console.error = (...args) => captured.push(args);
    try {
      const mailTime = createMailTime({
        josk: {
          adapter: createSchedulerAdapter()
        }
      });
      mailTime.josk.onError('Test scheduler title', { description: 'desc', error: new Error('boom'), uid: 'u' });
      const flat = captured.flat().map(String).join(' ');
      expect(flat).toContain('[scheduler] Test scheduler title');
    } finally {
      console.error = originalLog;
    }
  });

  it('handles scheduler ping failure via MailTime#ping', async () => {
    const mailTime = createMailTime();
    mailTime.scheduler.ping = jest.fn(async () => ({ status: 'Error', code: 500, statusCode: 500 }));
    await expect(mailTime.ping()).resolves.toMatchObject({ status: 'Error' });
  });

  it('coerces Date instance sendAt and falls back to now for NaN', async () => {
    const mailTime = createMailTime({ type: 'client' });
    const sendAtDate = new Date(Date.now() + 5000);
    const uuid = await mailTime.sendMail({
      to: 'user@example.com',
      text: 'hi',
      sendAt: sendAtDate
    });
    expect(typeof mailTime.queue.records.get(uuid).sendAt).toBe('number');

    const uuid2 = await mailTime.sendMail({
      to: 'user@example.com',
      text: 'hi',
      sendAt: Number.NaN
    });
    expect(typeof mailTime.queue.records.get(uuid2).sendAt).toBe('number');
  });

  it('wraps transport index on backup retry', async () => {
    const failing = createTransport((_mail, done) => done(new Error('down'), { accepted: [] }));
    const mailTime = createMailTime({
      transports: [failing, failing],
      strategy: 'backup',
      failsToNext: 1,
      retries: 5
    });
    const uuid = await mailTime.sendMail({ to: 'user@example.com', text: 'hi' });
    const task = mailTime.queue.records.get(uuid);
    task.transport = 1;
    await mailTime.___send(task);
    expect(task.transport).toBe(0);
  });

  it('wraps balancer index after reaching end of transports', async () => {
    const mailTime = createMailTime({
      transports: [createTransport(), createTransport()],
      strategy: 'balancer'
    });
    mailTime.transport = 1;
    const uuid = await mailTime.sendMail({ to: 'user@example.com', text: 'hi' });
    const task = mailTime.queue.records.get(uuid);
    await mailTime.___send(task);
    expect(mailTime.transport).toBe(0);
  });

  it('routes scheduler unable to ping into MailTime#ready rejection cause', async () => {
    const queue = createQueue();
    queue.ping = async () => ({ status: 'FAIL', code: 500, statusCode: 500, error: new Error('storage') });
    const mailTime = new MailTime({ type: 'client', queue });
    instances.push(mailTime);
    await expect(mailTime.ready()).rejects.toMatchObject({ message: expect.stringContaining('can not connect to storage') });
  });

  it('rejects empty array `to` and accepts string `to`', async () => {
    const mailTime = createMailTime({ type: 'client' });
    await expect(mailTime.sendMail({ to: [], text: 'x' })).rejects.toThrow('`mailOptions.to`');
    const uuid = await mailTime.sendMail({ to: ['a@example.com', 'b@example.com'], text: 'x' });
    expect(typeof uuid).toBe('string');
  });

  it('forwards optimal JoSk v6 defaults to the scheduler', () => {
    const mailTime = createMailTime();
    expect(mailTime.scheduler.execute).toBe('batch');
    expect(mailTime.scheduler.concurrency).toBe(Infinity);
    expect(mailTime.scheduler.zombieTime).toBe(60000);
    expect(typeof mailTime.scheduler.lockOwnerId).toBe('string');
    expect(mailTime.scheduler.lockOwnerId.length).toBeGreaterThan(0);
  });

  it('honors explicit JoSk overrides', () => {
    const mailTime = createMailTime({
      josk: {
        adapter: createSchedulerAdapter(),
        execute: 'one',
        concurrency: 8,
        zombieTime: 120000,
        lockOwnerId: 'override-id',
        autoClear: true
      }
    });
    expect(mailTime.scheduler.execute).toBe('one');
    expect(mailTime.scheduler.concurrency).toBe(8);
    expect(mailTime.scheduler.zombieTime).toBe(120000);
    expect(mailTime.scheduler.lockOwnerId).toBe('override-id');
    expect(mailTime.scheduler.autoClear).toBe(true);
  });
});

describe('MailTime per-recipient retry behavior', () => {
  const createPartialTransport = (calls) => {
    return createTransport((mail, done) => {
      const tos = Array.isArray(mail.to) ? [...mail.to] : [mail.to];
      calls.push(tos);
      const accepted = tos.filter((addr) => !addr.startsWith('bad'));
      const rejected = tos.filter((addr) => addr.startsWith('bad'));
      const rejectedErrors = rejected.map((addr) => new Error(`rejected ${addr}`));
      done(null, { accepted, rejected, rejectedErrors, response: 'mixed' });
    });
  };

  it('records accepted recipients and reschedules retry with only rejected pending', async () => {
    const calls = [];
    const onSent = jest.fn();
    const onError = jest.fn();
    const mailTime = createMailTime({
      transports: [createPartialTransport(calls)],
      retries: 3,
      retryDelay: 250,
      onSent,
      onError
    });
    const uuid = await mailTime.sendMail({
      to: ['good-a@example.com', 'good-b@example.com', 'bad-c@example.com'],
      subject: 'Partial',
      text: 'Partial',
      html: '<p>Partial</p>'
    });
    const task = mailTime.queue.records.get(uuid);
    const before = Date.now();

    await mailTime.___send(task);

    expect(task.mailOptions[0].to).toEqual(['good-a@example.com', 'good-b@example.com', 'bad-c@example.com']);
    expect(task.mailOptions[0].accepted).toEqual(expect.arrayContaining(['good-a@example.com', 'good-b@example.com']));
    expect(task.mailOptions[0].accepted).toHaveLength(2);
    expect(task.isSent).toBe(false);
    expect(task.isFailed).toBe(false);
    expect(task.sendAt).toBeGreaterThanOrEqual(before + 200);
    expect(mailTime.queue.records.has(uuid)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });

  it('next attempt sends only to recipients that have not been accepted yet', async () => {
    const calls = [];
    let attempt = 0;
    const transport = createTransport((mail, done) => {
      attempt++;
      const tos = Array.isArray(mail.to) ? [...mail.to] : [mail.to];
      calls.push(tos);
      if (attempt === 1) {
        done(null, {
          accepted: tos.filter((addr) => !addr.startsWith('bad')),
          rejected: tos.filter((addr) => addr.startsWith('bad')),
          response: 'partial'
        });
      } else {
        done(null, { accepted: tos, rejected: [], response: 'ok' });
      }
    });
    const onSent = jest.fn();
    const mailTime = createMailTime({
      transports: [transport],
      retries: 3,
      retryDelay: 25,
      onSent
    });
    const uuid = await mailTime.sendMail({
      to: ['good-a@example.com', 'good-b@example.com', 'bad-c@example.com'],
      subject: 'Partial then full',
      text: 'Partial then full'
    });
    const task = mailTime.queue.records.get(uuid);

    await mailTime.___send(task);
    task.sendAt = Date.now() - 1;
    await mailTime.___send(task);

    expect(calls[0]).toEqual(expect.arrayContaining(['good-a@example.com', 'good-b@example.com', 'bad-c@example.com']));
    expect(calls[1]).toEqual(['bad-c@example.com']);
    expect(mailTime.queue.records.has(uuid)).toBe(false);
    expect(onSent).toHaveBeenCalledTimes(1);
    const sentTask = onSent.mock.calls[0][0];
    expect(sentTask.mailOptions[0].accepted).toEqual(expect.arrayContaining(['good-a@example.com', 'good-b@example.com', 'bad-c@example.com']));
    expect(sentTask.mailOptions[0].accepted).toHaveLength(3);
  });

  it('records unaccepted recipients as rejected after maxTries and fires onError', async () => {
    const calls = [];
    const onError = jest.fn();
    const onSent = jest.fn();
    const mailTime = createMailTime({
      transports: [createPartialTransport(calls)],
      retries: 0,
      retryDelay: 10,
      keepHistory: true,
      onError,
      onSent
    });
    const uuid = await mailTime.sendMail({
      to: ['good-a@example.com', 'bad-b@example.com'],
      subject: 'Permanent rejection',
      text: 'Permanent rejection'
    });
    const task = mailTime.queue.records.get(uuid);

    await mailTime.___send(task);

    expect(task.mailOptions[0].accepted).toEqual(['good-a@example.com']);
    expect(task.mailOptions[0].rejected).toEqual([
      expect.objectContaining({ address: 'bad-b@example.com', error: expect.any(String) })
    ]);
    expect(task.isFailed).toBe(true);
    expect(task.isSent).toBe(false);
    expect(onSent).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, errorTask] = onError.mock.calls[0];
    expect(`${error}`).toMatch(/Recipients rejected/);
    expect(errorTask.mailOptions[0].rejected).toHaveLength(1);
  });

  it('preserves original recipient list on cc and bcc and tracks them with accepted', async () => {
    const calls = [];
    const transport = createTransport((mail, done) => {
      calls.push({
        to: Array.isArray(mail.to) ? [...mail.to] : mail.to,
        cc: Array.isArray(mail.cc) ? [...mail.cc] : mail.cc,
        bcc: Array.isArray(mail.bcc) ? [...mail.bcc] : mail.bcc
      });
      const tos = [].concat(mail.to || [], mail.cc || [], mail.bcc || []);
      done(null, { accepted: tos, rejected: [], response: 'ok' });
    });
    const onSent = jest.fn();
    const mailTime = createMailTime({ transports: [transport], onSent });
    const uuid = await mailTime.sendMail({
      to: 'primary@example.com',
      cc: ['cc-a@example.com', 'cc-b@example.com'],
      bcc: 'bcc-z@example.com',
      text: 'with cc/bcc'
    });
    const task = mailTime.queue.records.get(uuid);

    await mailTime.___send(task);

    expect(onSent).toHaveBeenCalledTimes(1);
    const sentTask = onSent.mock.calls[0][0];
    expect(sentTask.mailOptions[0].accepted).toEqual(expect.arrayContaining([
      'primary@example.com',
      'cc-a@example.com',
      'cc-b@example.com',
      'bcc-z@example.com'
    ]));
    expect(sentTask.mailOptions[0].accepted).toHaveLength(4);
  });

  it('tracks accepted on every concatEmails mailOption entry on full delivery', async () => {
    const transport = createTransport((mail, done) => {
      const tos = Array.isArray(mail.to) ? [...mail.to] : [mail.to];
      done(null, { accepted: tos, rejected: [], response: 'ok' });
    });
    const onSent = jest.fn();
    const mailTime = createMailTime({
      transports: [transport],
      concatEmails: true,
      concatDelay: 5,
      onSent
    });

    const first = await mailTime.sendMail({ to: 'concat@example.com', text: 'First' });
    const second = await mailTime.sendMail({ to: 'concat@example.com', text: 'Second' });
    expect(second).toBe(first);

    const task = mailTime.queue.records.get(first);
    expect(task.mailOptions).toHaveLength(2);
    task.sendAt = Date.now() - 1;

    await mailTime.___send(task);

    expect(onSent).toHaveBeenCalledTimes(1);
    const sentTask = onSent.mock.calls[0][0];
    expect(sentTask.mailOptions[0].accepted).toEqual(['concat@example.com']);
    expect(sentTask.mailOptions[1].accepted).toEqual(['concat@example.com']);
    expect(mailTime.queue.records.has(first)).toBe(false);
  });

  it('removes the task on partial-rejection exhaustion when keepHistory is false', async () => {
    const calls = [];
    const onError = jest.fn();
    const mailTime = createMailTime({
      transports: [createPartialTransport(calls)],
      retries: 0,
      retryDelay: 10,
      onError
    });
    const uuid = await mailTime.sendMail({
      to: ['good-a@example.com', 'bad-b@example.com'],
      text: 'Permanent rejection without history'
    });
    const task = mailTime.queue.records.get(uuid);

    await mailTime.___send(task);

    expect(mailTime.queue.records.has(uuid)).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    const [, errorTask] = onError.mock.calls[0];
    expect(errorTask.mailOptions[0].accepted).toEqual(['good-a@example.com']);
    expect(errorTask.mailOptions[0].rejected).toEqual([
      expect.objectContaining({ address: 'bad-b@example.com' })
    ]);
  });

  it('persists accepted recipients with keepHistory on full delivery', async () => {
    const transport = createTransport((mail, done) => {
      const tos = Array.isArray(mail.to) ? [...mail.to] : [mail.to];
      done(null, { accepted: tos, rejected: [], response: 'ok' });
    });
    const mailTime = createMailTime({
      transports: [transport],
      keepHistory: true
    });
    const uuid = await mailTime.sendMail({
      to: 'history@example.com',
      text: 'history'
    });
    const task = mailTime.queue.records.get(uuid);

    await mailTime.___send(task);

    expect(mailTime.queue.records.has(uuid)).toBe(true);
    const stored = mailTime.queue.records.get(uuid);
    expect(stored.mailOptions[0].accepted).toEqual(['history@example.com']);
  });

  it('treats an empty info.accepted as full failure routed through ___handleError', async () => {
    const transport = createTransport((mail, done) => {
      const tos = Array.isArray(mail.to) ? mail.to : [mail.to];
      done(null, { accepted: [], rejected: tos, response: 'all rejected' });
    });
    const onError = jest.fn();
    const onSent = jest.fn();
    const mailTime = createMailTime({
      transports: [transport],
      retries: 1,
      retryDelay: 25,
      onError,
      onSent
    });
    const uuid = await mailTime.sendMail({
      to: ['bad-a@example.com', 'bad-b@example.com'],
      text: 'all-bad'
    });
    const task = mailTime.queue.records.get(uuid);

    await mailTime.___send(task);

    expect(task.isFailed).toBe(false);
    expect(task.isSent).toBe(false);
    expect(task.tries).toBe(1);
    expect(onError).not.toHaveBeenCalled();
    expect(onSent).not.toHaveBeenCalled();
  });
});

describe('MailTime mode, concurrency, and isSending lifecycle', () => {
  const seedTask = (mailTime, overrides = {}) => {
    const task = {
      uuid: `task-${Math.random().toString(36).slice(2, 8)}`,
      tries: 0,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0,
      sendAt: Date.now() - 1,
      template: false,
      transport: 0,
      concatSubject: false,
      mailOptions: [{ to: 'user@example.com', text: 'hi' }],
      ...overrides
    };
    mailTime.queue.records.set(task.uuid, { ...task });
    return mailTime.queue.records.get(task.uuid);
  };

  it('defaults mode to batch and concurrency to 1', () => {
    const mailTime = createMailTime();
    expect(mailTime.mode).toBe('batch');
    expect(mailTime.concurrency).toBe(1);
    expect(mailTime.sendingTimeout).toBe(300000);
  });

  it('coerces invalid mode/concurrency/sendingTimeout to safe defaults', () => {
    const mailTime = createMailTime({
      mode: 'bogus',
      concurrency: 0,
      sendingTimeout: -5
    });
    expect(mailTime.mode).toBe('batch');
    expect(mailTime.concurrency).toBe(1);
    expect(mailTime.sendingTimeout).toBe(300000);

    const tuned = createMailTime({
      mode: 'one',
      concurrency: 4,
      sendingTimeout: 120000
    });
    expect(tuned.mode).toBe('one');
    expect(tuned.concurrency).toBe(4);
    expect(tuned.sendingTimeout).toBe(120000);
  });

  it('atomically claims and releases isSending across the full lifecycle', async () => {
    const mailTime = createMailTime({ keepHistory: true });
    const task = seedTask(mailTime);

    await mailTime.___send(task);

    const stored = mailTime.queue.records.get(task.uuid);
    expect(stored.isSent).toBe(true);
    expect(stored.isSending).toBe(false);
    expect(stored.sendingAt).toBe(0);
    expect(stored.tries).toBe(1);
  });

  it('mode "one" stops scanning after the first dispatch per tick', async () => {
    const dispatches = [];
    const mailTime = createMailTime({ mode: 'one' });
    mailTime.___dispatch = jest.fn(async (task) => dispatches.push(task.uuid));

    seedTask(mailTime, { uuid: 'a' });
    seedTask(mailTime, { uuid: 'b' });
    seedTask(mailTime, { uuid: 'c' });

    await mailTime.___iterate();

    expect(dispatches).toHaveLength(1);
  });

  it('mode "batch" drains every due, unclaimed row in one tick', async () => {
    const dispatches = [];
    const mailTime = createMailTime({ mode: 'batch' });
    mailTime.___dispatch = jest.fn(async (task) => dispatches.push(task.uuid));

    seedTask(mailTime, { uuid: 'a' });
    seedTask(mailTime, { uuid: 'b' });
    seedTask(mailTime, { uuid: 'c' });

    await mailTime.___iterate();

    expect(dispatches.sort()).toEqual(['a', 'b', 'c']);
  });

  it('iterate skips rows already locked by isSending until sendingTimeout elapses', async () => {
    const dispatches = [];
    const mailTime = createMailTime({ mode: 'batch', sendingTimeout: 1000 });
    mailTime.___dispatch = jest.fn(async (task) => dispatches.push(task.uuid));

    seedTask(mailTime, {
      uuid: 'locked-fresh',
      isSending: true,
      sendingAt: Date.now()
    });
    seedTask(mailTime, {
      uuid: 'locked-stale',
      isSending: true,
      sendingAt: Date.now() - 2000
    });
    seedTask(mailTime, {
      uuid: 'unlocked',
      isSending: false,
      sendingAt: 0
    });

    await mailTime.___iterate();

    expect(dispatches.sort()).toEqual(['locked-stale', 'unlocked']);
  });

  it('claim guard rejects a stale isSending claim within sendingTimeout', async () => {
    const mailTime = createMailTime({ sendingTimeout: 60000 });
    const task = seedTask(mailTime, {
      isSending: true,
      sendingAt: Date.now()
    });

    const claimed = await mailTime.queue.update(task, {
      isSending: true,
      sendingAt: Date.now(),
      tries: task.tries + 1
    });
    expect(claimed).toBe(false);
  });

  it('claim guard accepts recovery of a stale isSending row past sendingTimeout', async () => {
    const mailTime = createMailTime({ sendingTimeout: 1000 });
    const task = seedTask(mailTime, {
      isSending: true,
      sendingAt: Date.now() - 5000
    });

    const claimed = await mailTime.queue.update(task, {
      isSending: true,
      sendingAt: Date.now(),
      tries: task.tries + 1
    });
    expect(claimed).toBe(true);
  });

  it('___dispatch refuses to enqueue an already in-flight task on the same instance', async () => {
    const mailTime = createMailTime({ concurrency: 2 });
    let release;
    const block = new Promise((resolve) => {
      release = resolve;
    });
    mailTime.___send = jest.fn(async () => block);

    const task = seedTask(mailTime);
    await mailTime.___dispatch(task);
    await mailTime.___dispatch(task);
    await mailTime.___dispatch(task);

    expect(mailTime.___send).toHaveBeenCalledTimes(1);
    release();
    await mailTime.drain();
  });

  it('___dispatch is a no-op after destroy and on terminal tasks', async () => {
    const mailTime = createMailTime();
    mailTime.___send = jest.fn();
    mailTime.destroy();
    await mailTime.___dispatch({ uuid: 'after-destroy', isSent: false, isFailed: false, isCancelled: false });
    expect(mailTime.___send).not.toHaveBeenCalled();

    const live = createMailTime();
    live.___send = jest.fn();
    await live.___dispatch({ uuid: 'done', isSent: true });
    await live.___dispatch({ uuid: 'failed', isFailed: true });
    await live.___dispatch({ uuid: 'cancelled', isCancelled: true });
    expect(live.___send).not.toHaveBeenCalled();
  });

  it('concurrency > 1 runs sends in parallel; CAS guard prevents duplicate delivery', async () => {
    const sent = [];
    const release = [];
    const transport = createTransport((mail, done) => {
      release.push(() => done(null, { accepted: [mail.to], rejected: [], response: 'ok' }));
      sent.push(mail.to);
    });

    const mailTime = createMailTime({
      transports: [transport],
      concurrency: 3,
      mode: 'batch'
    });

    seedTask(mailTime, { uuid: 'p1', mailOptions: [{ to: 'p1@example.com', text: 'x' }] });
    seedTask(mailTime, { uuid: 'p2', mailOptions: [{ to: 'p2@example.com', text: 'x' }] });
    seedTask(mailTime, { uuid: 'p3', mailOptions: [{ to: 'p3@example.com', text: 'x' }] });

    await mailTime.___iterate();

    expect(sent).toHaveLength(3);
    while (release.length > 0) {
      release.shift()();
    }
    await mailTime.drain();
    expect(mailTime.queue.records.size).toBe(0);
  });

  it('drain awaits in-flight dispatches before resolving', async () => {
    const mailTime = createMailTime({ concurrency: 2 });
    let released = false;
    const block = new Promise((resolve) => {
      setTimeout(() => {
        released = true;
        resolve();
      }, 30);
    });
    mailTime.___send = jest.fn(async () => block);

    const task = seedTask(mailTime);
    await mailTime.___dispatch(task);
    expect(released).toBe(false);
    await mailTime.drain();
    expect(released).toBe(true);
  });

  it('newly queued tasks carry isSending=false and sendingAt=0', async () => {
    const mailTime = createMailTime();
    const uuid = await mailTime.sendMail({ to: 'user@example.com', text: 'hi' });
    const stored = mailTime.queue.records.get(uuid);
    expect(stored.isSending).toBe(false);
    expect(stored.sendingAt).toBe(0);
  });
});

describe('MailTime transport verification on ready()', () => {
  const withVerify = (transport, verifyImpl) => {
    transport.verify = verifyImpl;
    return transport;
  };

  it('calls verify() on each transport during ready()', async () => {
    const verifyA = jest.fn(async () => true);
    const verifyB = jest.fn(async () => true);
    const a = withVerify(createTransport(), verifyA);
    const b = withVerify(createTransport(), verifyB);
    const mailTime = createMailTime({ transports: [a, b] });

    await expect(mailTime.ready()).resolves.toBe(mailTime);
    expect(verifyA).toHaveBeenCalledTimes(1);
    expect(verifyB).toHaveBeenCalledTimes(1);
    expect(mailTime.__unhealthyTransports.size).toBe(0);
  });

  it('marks a failing transport unusable, fires onError with phase:"verify", and still resolves ready()', async () => {
    const verifyA = jest.fn(async () => { throw new Error('bad creds'); });
    const verifyB = jest.fn(async () => true);
    const onError = jest.fn();
    const mailTime = createMailTime({
      transports: [withVerify(createTransport(), verifyA), withVerify(createTransport(), verifyB)],
      onError
    });

    await expect(mailTime.ready()).resolves.toBe(mailTime);
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, task, details] = onError.mock.calls[0];
    expect(`${error}`).toMatch(/bad creds/);
    expect(task).toBeNull();
    expect(details).toMatchObject({ transportIndex: 0, phase: 'verify' });
    expect(mailTime.__unhealthyTransports.has(0)).toBe(true);
    expect(mailTime.__unhealthyTransports.has(1)).toBe(false);
  });

  it('throws from ready() when all transports fail verification', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const mailTime = createMailTime({
      transports: [
        withVerify(createTransport(), async () => { throw new Error('bad a'); }),
        withVerify(createTransport(), async () => { throw new Error('bad b'); })
      ]
    });

    await expect(mailTime.ready()).rejects.toThrow(/all .*transport/i);
  });

  it('treats transports without a verify() method as healthy', async () => {
    const mailTime = createMailTime();
    await expect(mailTime.ready()).resolves.toBe(mailTime);
    expect(mailTime.__unhealthyTransports.size).toBe(0);
  });

  it('disables verification when verifyTransports: false', async () => {
    const verify = jest.fn();
    const mailTime = createMailTime({
      transports: [withVerify(createTransport(), verify)],
      verifyTransports: false
    });

    await expect(mailTime.ready()).resolves.toBe(mailTime);
    expect(verify).not.toHaveBeenCalled();
  });

  it('backup strategy: reroutes from an unhealthy task.transport at send time without burning a try', async () => {
    const goodSent = [];
    const bad = createTransport(jest.fn((_mail, done) => done(new Error('should not be invoked'), { accepted: [] })));
    const good = createTransport((mail, done) => {
      goodSent.push(mail.to);
      done(null, { accepted: [mail.to], response: 'ok' });
    });
    withVerify(bad, async () => { throw new Error('credentials'); });
    const mailTime = createMailTime({
      transports: [bad, good],
      strategy: 'backup'
    });
    await mailTime.ready();

    const uuid = await mailTime.sendMail({ to: 'user@example.com', text: 'x' });
    const task = mailTime.queue.records.get(uuid);
    expect(task.transport).toBe(1);

    await mailTime.___send(task);

    expect(bad.sendMail).not.toHaveBeenCalled();
    expect(goodSent).toEqual(['user@example.com']);
    expect(task.tries).toBe(1);
    expect(mailTime.queue.records.has(uuid)).toBe(false);
  });

  it('balancer assigns transport per task at enqueue and uses it under parallel concurrency', async () => {
    const transportUsed = [];
    const make = (index) => createTransport((mail, done) => {
      transportUsed.push({ index, to: mail.to });
      setTimeout(() => done(null, { accepted: [mail.to], response: 'ok' }), 5);
    });
    const mailTime = createMailTime({
      transports: [make(0), make(1)],
      strategy: 'balancer',
      concurrency: 2
    });
    await mailTime.ready();

    const uuidA = await mailTime.sendMail({ to: 'a@example.com', text: 'a' });
    const uuidB = await mailTime.sendMail({ to: 'b@example.com', text: 'b' });
    const taskA = mailTime.queue.records.get(uuidA);
    const taskB = mailTime.queue.records.get(uuidB);
    expect(taskA.transport).not.toBe(taskB.transport);

    await Promise.all([
      mailTime.___dispatch(taskA),
      mailTime.___dispatch(taskB),
    ]);
    await mailTime.drain();

    expect(transportUsed).toHaveLength(2);
    expect(transportUsed.find((entry) => entry.to === 'a@example.com').index).toBe(taskA.transport);
    expect(transportUsed.find((entry) => entry.to === 'b@example.com').index).toBe(taskB.transport);
  });

  it('balancer strategy: skips unhealthy transports when picking the next one', async () => {
    const sent = [];
    const make = (label) => createTransport((mail, done) => {
      sent.push({ label, to: mail.to });
      done(null, { accepted: [mail.to], response: 'ok' });
    });
    const a = make('a');
    const b = make('b');
    const c = make('c');
    withVerify(b, async () => { throw new Error('bad b'); });

    const mailTime = createMailTime({
      transports: [a, b, c],
      strategy: 'balancer'
    });
    await mailTime.ready();

    for (const to of ['u1@example.com', 'u2@example.com', 'u3@example.com', 'u4@example.com']) {
      const uuid = await mailTime.sendMail({ to, text: 'x' });
      await mailTime.___send(mailTime.queue.records.get(uuid));
    }

    const labels = sent.map((s) => s.label);
    expect(labels).not.toContain('b');
    expect(new Set(labels)).toEqual(new Set(['a', 'c']));
    expect(sent).toHaveLength(4);
  });

  it('backup strategy: failsToNext rotation skips unhealthy transports', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const bad0 = createTransport((_mail, done) => done(new Error('runtime fail'), { accepted: [] }));
    const bad1 = createTransport(jest.fn());
    const good = createTransport((mail, done) => done(null, { accepted: [mail.to], response: 'ok' }));
    withVerify(bad1, async () => { throw new Error('verify fail'); });

    const mailTime = createMailTime({
      transports: [bad0, bad1, good],
      strategy: 'backup',
      failsToNext: 1,
      retries: 5,
      retryDelay: 10
    });
    await mailTime.ready();

    const uuid = await mailTime.sendMail({ to: 'user@example.com', text: 'x' });
    const task = mailTime.queue.records.get(uuid);
    expect(task.transport).toBe(0);

    await mailTime.___send(task);

    expect(task.transport).toBe(2);
    expect(bad1.sendMail).not.toHaveBeenCalled();
  });

  it('supports a sync verify() that returns true', async () => {
    const verifyA = jest.fn(() => true);
    const mailTime = createMailTime({
      transports: [withVerify(createTransport(), verifyA)]
    });

    await expect(mailTime.ready()).resolves.toBe(mailTime);
    expect(verifyA).toHaveBeenCalledTimes(1);
    expect(mailTime.__unhealthyTransports.size).toBe(0);
  });

  it('skips verification for client-mode instances (no transports)', async () => {
    const queue = createQueue();
    const mailTime = new MailTime({ type: 'client', queue });
    instances.push(mailTime);

    await expect(mailTime.ready()).resolves.toBe(mailTime);
  });
});

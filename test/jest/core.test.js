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

        if (updateObj.isSent === true && typeof updateObj.tries === 'number') {
          if (current.isSent === true || current.isFailed === true || current.isCancelled === true || current.tries !== task.tries) {
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
});

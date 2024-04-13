import { MailTime, RedisQueue } from '../index.js';
import nodemailer from 'nodemailer';
import directTransport from 'nodemailer-direct-transport';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import { assert } from 'chai';
import { it, describe, before } from 'mocha';

if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined! Please run test with MONGO_URL, like `MONGO_URL=mongodb://127.0.0.1:27017/dbname npm test`');
}
if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL env.var is not defined! Please run test with REDIS_URL, like `REDIS_URL=redis://127.0.0.1:6379 npm test`');
}

const wait       = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const mongoAddr  = (process.env.MONGO_URL || '');
const dbName     = mongoAddr.split('/').pop().replace(/\/$/, '');
const transports = [];
const DEBUG      = process.env.DEBUG === 'true' ? true : false;
const domain     = process.env.EMAIL_DOMAIN || 'example.com';
const TEST_TITLE = 'mail-time-test-suite-redis-mongo';

let db;
let client;
let redisClient;
const mailTimes = {};
const callbacks = {};

before(async function () {
  redisClient = await createClient({
    url: process.env.REDIS_URL
  }).connect();

  client = await MongoClient.connect(mongoAddr, {
    writeConcern: {
      j: true,
      w: 'majority',
      wtimeout: 30000
    },
    readConcern: {
      level: 'majority'
    },
    readPreference: 'primary',
    // poolSize: 15,
    // reconnectTries: 60,
    socketTimeoutMS: 720000,
    // useNewUrlParser: true,
    // useUnifiedTopology: true,
    connectTimeoutMS: 120000,
    // reconnectInterval: 3072,
    // connectWithNoPrimary: false,
    appname: TEST_TITLE
  });
  db = client.db(dbName);

  const transportDefaults = {
    pool: false,
    direct: true,
    name: domain,
    debug: DEBUG,
    logger: DEBUG ? console : void 0,
    connectionTimeout: 1000,
    greetingTimeout: 750,
    socketTimeout: 1500,
    dnsTimeout: 1500,
  };

  transports.push(nodemailer.createTransport(directTransport({
    ...transportDefaults,
    from: `no-reply@${domain}`,
  })));

  transports.push(nodemailer.createTransport(directTransport({
    ...transportDefaults,
    from: `no-reply@${domain}`,
  })));

  const defaultQueueOptions = {
    retries: 0,
    retryDelay: 1000,
    josk: {
      adapter: {
        db: db,
        type: 'mongo',
      }
    },
    transports,
    debug: DEBUG,
    type: 'server',
    from: `no-reply@${domain}`,
    strategy: 'balancer',
    failsToNext: 1,
    onError(error, task/*, details */) {
      callbacks[task.uuid] = { task, error };
    },
    onSent(task, details) {
      callbacks[task.uuid] = { task, details };
    }
  };

  mailTimes.WithoutConcatenation = new MailTime({
    ...defaultQueueOptions,
    queue: new RedisQueue({
      client: redisClient,
      prefix: `${TEST_TITLE}WithoutConcatenation`,
    }),
    concatEmails: false,
    prefix: `${TEST_TITLE}WithoutConcatenation`,
  });

  const cursorWithoutConcatenation = mailTimes.WithoutConcatenation.queue.client.scanIterator({
    TYPE: 'string',
    MATCH: `mailtime:${TEST_TITLE}WithoutConcatenation:*`,
    COUNT: 9999,
  });

  for await (const key of cursorWithoutConcatenation) {
    await mailTimes.WithoutConcatenation.queue.client.del(key);
  }

  mailTimes.WithConcatenation = new MailTime({
    ...defaultQueueOptions,
    queue: new RedisQueue({
      client: redisClient,
      prefix: `${TEST_TITLE}WithConcatenation`,
    }),
    concatEmails: true,
    prefix: `${TEST_TITLE}WithConcatenation`,
  });

  const cursorWithConcatenation = mailTimes.WithConcatenation.queue.client.scanIterator({
    TYPE: 'string',
    MATCH: `mailtime:${TEST_TITLE}WithConcatenation:*`,
    COUNT: 9999,
  });

  for await (const key of cursorWithConcatenation) {
    await mailTimes.WithConcatenation.queue.client.del(key);
  }

  mailTimes.WithHistory = new MailTime({
    ...defaultQueueOptions,
    queue: new RedisQueue({
      client: redisClient,
      prefix: `${TEST_TITLE}WithHistory`,
    }),
    keepHistory: true,
    strategy: 'backup',
    concatEmails: false,
    prefix: `${TEST_TITLE}WithHistory`,
  });

  const cursorWithHistory = mailTimes.WithHistory.queue.client.scanIterator({
    TYPE: 'string',
    MATCH: `mailtime:${TEST_TITLE}WithHistory:*`,
    COUNT: 9999,
  });

  for await (const key of cursorWithHistory) {
    await mailTimes.WithHistory.queue.client.del(key);
  }
});


describe('Redis - Mongo', function () {
  this.slow(1000);
  this.timeout(2000);

  describe('Has MailTime Object', function () {
    it('MailTime is Constructor', () => {
      assert.isFunction(MailTime, 'MailTime is Constructor');
      assert.equal(typeof MailTime.Template === 'string', true, 'MailTime# has Template');
    });

    it('Change MailTime.Template', () => {
      const orig = MailTime.Template;
      assert.equal(MailTime.Template === '{{{html}}}', false, 'MailTime#Template has original value');
      MailTime.Template = '{{{html}}}';
      assert.equal(MailTime.Template === '{{{html}}}', true, 'MailTime#Template has new value');
      MailTime.Template = orig;
    });
  });

const runTests = (type, concat, keepHistory) => {
    describe(type, () => {
      describe('MailTime Instance', function () {
        it('Check MailTime instance properties', function () {
          assert.instanceOf(mailTimes[type], MailTime, 'mailTimes[type] is instance of MailTime');
          assert.equal(mailTimes[type].type, 'server', 'mailTimes[type] has type');
          assert.equal(mailTimes[type].prefix, `${TEST_TITLE}${type}`, 'mailTimes[type] has prefix');
          assert.equal(mailTimes[type].debug, DEBUG, 'mailTimes[type] has debug');
          assert.equal(mailTimes[type].maxTries, 1, 'mailTimes[type] has maxTries');
          assert.equal(mailTimes[type].retryDelay, 1000, 'mailTimes[type] has retryDelay');
          assert.equal(mailTimes[type].template, '{{{html}}}', 'mailTimes[type] has template');
          assert.equal(mailTimes[type].strategy, keepHistory ? 'backup' : 'balancer', 'mailTimes[type] has strategy');
          assert.equal(mailTimes[type].failsToNext, 1, 'mailTimes[type] has failsToNext');
          assert.instanceOf(mailTimes[type].transports, Array, 'mailTimes[type] has transports');
          assert.equal(mailTimes[type].transport, 0, 'mailTimes[type] has transport');
          assert.equal(mailTimes[type].from(), `no-reply@${domain}`, 'mailTimes[type] has from');
          assert.equal(mailTimes[type].concatEmails, concat, 'mailTimes[type] has concatEmails');
          assert.equal(mailTimes[type].concatSubject, 'Multiple notifications', 'mailTimes[type] has concatSubject');
          assert.equal(mailTimes[type].concatDelimiter, '<hr>', 'mailTimes[type] has concatDelimiter');
          assert.equal(mailTimes[type].concatDelay, 60000, 'mailTimes[type] has concatDelay');
          assert.equal(mailTimes[type].revolvingInterval, 1536, 'mailTimes[type] has revolvingInterval');
          assert.equal(mailTimes[type].josk.minRevolvingDelay, 512, 'mailTimes[type] has minRevolvingDelay');
          assert.equal(mailTimes[type].josk.maxRevolvingDelay, 2048, 'mailTimes[type] has maxRevolvingDelay');
          assert.equal(mailTimes[type].josk.zombieTime, 32786, 'mailTimes[type] has zombieTime');
        });
      });

      describe('ping', function () {
        this.slow(1000);
        this.timeout(2000);

        it('ping response', async function () {
          const pingRes = await mailTimes[type].ping();
          assert.isObject(pingRes, 'ping response is Object');
          assert.equal(pingRes.status, 'OK', 'ping.status');
          assert.equal(pingRes.code, 200, 'ping.code');
          assert.equal(pingRes.statusCode, 200, 'ping.statusCode');
          assert.isUndefined(pingRes.error, 'ping.error is undefined');
        });
      });

      describe('cancelMail', function () {
        this.slow(750);
        this.timeout(1000);

        it('sendMail then cancelMail', async function () {
          const address = `mail-time-tests-0@${domain}`;
          const uuid = await mailTimes[type].sendMail({
            sendAt: Date.now() + 50000,
            to: address,
            subject: 'You\'ve got an email!',
            text: 'test email',
            html: '<p>test email</p>',
          });

          const isCancelled = await mailTimes[type].cancelMail(uuid);
          assert.isTrue(isCancelled, 'isCancelled true from cancelMail');

          const task = JSON.parse(await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(uuid)));

          if (keepHistory) {
            assert.isObject(task, 'Task saved {keepHistory: true}');
            assert.isTrue(task.isCancelled, 'task.isCancelled');
          } else {
            assert.isNull(task, 'Task removed {keepHistory: false}');
          }
        });

        it('sendMail then cancelMail passing Promise', async function () {
          const address = `mail-time-tests-0@${domain}`;
          const uuid = mailTimes[type].sendMail({
            sendAt: Date.now() + 50000,
            to: address,
            subject: 'You\'ve got an email!',
            text: 'test email',
            html: '<p>test email</p>',
          });

          const isCancelled = await mailTimes[type].cancelMail(uuid);
          assert.isTrue(isCancelled, 'isCancelled true from cancelMail');

          const task = JSON.parse(await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(await uuid)));
          if (keepHistory) {
            assert.isObject(task, 'Task saved {keepHistory: true}');
            assert.isTrue(task.isCancelled, 'task.isCancelled');
          } else {
            assert.isNull(task, 'Task removed {keepHistory: false}');
          }
        });
      });

      describe('sendMail', function () {
        this.slow(1000);
        this.timeout(2000);

        it('sendMail Template placeholders render', async function () {
          const address = `mail-time-tests-1@${domain}`;
          const uuid = await mailTimes[type].sendMail({
            sendAt: Date.now() + 50000,
            to: address,
            subject: 'You\'ve got an email!',
            user: 'John',
            baseUrl: '<b>http://example.com</b>',
            text: '{{user}}, {{ baseUrl }}',
            html: '<p>Hi {{user}}, {{{ baseUrl }}}</p>',
            template: '{{{html}}} {{baseUrl}}',
          });

          const task = JSON.parse(await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(uuid)));
          assert.isObject(task, 'task is Object');
          const rendered = mailTimes[type].___compileMailOpts(transports[0], task);
          assert.equal(rendered.html, '<p>Hi John, <b>http://example.com</b></p> http://example.com', 'HTML template is properly rendered');
          assert.equal(rendered.text, 'John, http://example.com', 'Text template is properly rendered');

          const isCancelled = await mailTimes[type].cancelMail(uuid);
          assert.isTrue(isCancelled, 'isCancelled true from cancelMail');

          const sendTask = await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(uuid, 'sendat'));
          assert.isNull(sendTask, 'sendTask cleared .cancelMail(uuid)');

          const hasRecord = await mailTimes[type].queue.client.exists(mailTimes[type].queue.__getKey(uuid));
          if (keepHistory) {
            assert.equal(hasRecord, 1, 'Task saved {keepHistory: true}');
          } else {
            assert.equal(hasRecord, 0, 'Task removed {keepHistory: false}');
          }
        });

        it('sendMail with no template', async function () {
          const address = `mail-time-tests-2@${domain}`;
          const uuid = await mailTimes[type].sendMail({
            sendAt: Date.now() + 50000,
            to: address,
            subject: 'You\'ve got an email!',
            user: 'John',
            text: 'Plain text',
            html: '<p>Plain text</p>',
          });

          const task = JSON.parse(await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(uuid)));
          assert.isObject(task, 'task is Object');
          const rendered = mailTimes[type].___compileMailOpts(transports[0], task);
          assert.equal(rendered.html, '<p>Plain text</p>', 'HTML template is properly rendered');
          assert.equal(rendered.text, 'Plain text', 'Text template is properly rendered');

          const isCancelled = await mailTimes[type].cancelMail(uuid);
          assert.isTrue(isCancelled, 'isCancelled true from cancelMail');

          const sendTask = await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(uuid, 'sendat'));
          assert.isNull(sendTask, 'sendTask cleared .cancelMail(uuid)');

          const hasRecord = await mailTimes[type].queue.client.exists(mailTimes[type].queue.__getKey(uuid));
          if (keepHistory) {
            assert.equal(hasRecord, 1, 'Task saved {keepHistory: true}');
          } else {
            assert.equal(hasRecord, 0, 'Task removed {keepHistory: false}');
          }
        });

        it('sendMail with simple template', async function () {
          const address = `mail-time-tests-3@${domain}`;
          const uuid = await mailTimes[type].sendMail({
            sendAt: Date.now() + 50000,
            to: address,
            userName: 'Mike',
            subject: 'Sign up confirmation',
            text: 'Hello {{userName}}, \r\n Thank you for registration \r\n Your login: {{to}}',
            html: '<div style="text-align: center"><h1>Hello {{userName}}</h1><p><ul><li>Thank you for registration</li><li>Your login: {{to}}</li></ul></p></div>',
            template: '<body>{{{html}}}</body>',
          });

          const task = JSON.parse(await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(uuid)));
          assert.isObject(task, 'task is Object');

          const rendered = mailTimes[type].___compileMailOpts(transports[0], task);
          assert.equal(rendered.html, `<body><div style="text-align: center"><h1>Hello Mike</h1><p><ul><li>Thank you for registration</li><li>Your login: ${address}</li></ul></p></div></body>`, 'HTML template is properly rendered');
          assert.equal(rendered.text, `Hello Mike, \r\n Thank you for registration \r\n Your login: ${address}`, 'Text template is properly rendered');

          const isCancelled = await mailTimes[type].cancelMail(uuid);
          assert.isTrue(isCancelled, 'isCancelled true from cancelMail');

          const sendTask = await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(uuid, 'sendat'));
          assert.isNull(sendTask, 'sendTask cleared .cancelMail(uuid)');

          const hasRecord = await mailTimes[type].queue.client.exists(mailTimes[type].queue.__getKey(uuid));
          if (keepHistory) {
            assert.equal(hasRecord, 1, 'Task saved {keepHistory: true}');
          } else {
            assert.equal(hasRecord, 0, 'Task removed {keepHistory: false}');
          }
        });

        it('sendMail testing concatenation to the same addressee - different emails', async function () {
          const address = `mail-time-tests-4@${domain}`;
          let hasRecord;
          const uuid1 = await mailTimes[type].sendMail({
            sendAt: Date.now() + 50000,
            to: address,
            userName: 'Concatenator',
            subject: '{{userName}}: testing concatenation 1',
            text: '{{userName}}: testing concatenation 1',
            html: '<b>{{userName}}: testing concatenation 1</b>',
            template: '<body>{{{html}}}</body>',
          });

          const uuid2 = await mailTimes[type].sendMail({
            sendAt: Date.now() + 50000,
            to: address,
            userName: 'Concatenator',
            subject: '{{userName}}: testing concatenation 2',
            text: '{{userName}}: testing concatenation 2',
            html: '<b>{{userName}}: testing concatenation 2</b>',
            template: '<body>{{{html}}}</body>',
          });

          const concatUuid = await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(address, 'concatletter'));
          const task = JSON.parse(await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(concatUuid)));

          if (concat === true) {
            assert.equal(uuid1, uuid2, 'Email uuids are the same when concatenated');
            assert.equal(uuid1, concatUuid, 'Email uuids and concatUuid are the same when concatenated');
            assert.equal(task.mailOptions.length, 2, '{task.mailOptions} hold two emails');
          } else {
            assert.isNull(concatUuid, 'Concatenation is disabled');
            assert.notEqual(uuid1, uuid2, 'Email uuids are notEqual concatenation is disabled');

            const isCancelled = await mailTimes[type].cancelMail(uuid2);
            assert.isTrue(isCancelled, '2 isCancelled true from cancelMail');

            const sendTask = await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(uuid2, 'sendat'));
            assert.isNull(sendTask, 'sendTask cleared .cancelMail(uuid2)');

            hasRecord = await mailTimes[type].queue.client.exists(mailTimes[type].queue.__getKey(uuid2));
            if (keepHistory) {
              assert.equal(hasRecord, 1, 'Task uuid2 saved {keepHistory: true}');
            } else {
              assert.equal(hasRecord, 0, 'Task uuid2 removed {keepHistory: false}');
            }
          }

          const isCancelled = await mailTimes[type].cancelMail(uuid1);
          assert.isTrue(isCancelled, '1 isCancelled true from cancelMail');

          const sendTask = await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(uuid1, 'sendat'));
          assert.isNull(sendTask, 'sendTask cleared .cancelMail(uuid1)');

          hasRecord = await mailTimes[type].queue.client.exists(mailTimes[type].queue.__getKey(uuid1));
          if (keepHistory) {
            assert.equal(hasRecord, 1, 'Task uuid1 saved {keepHistory: true}');
          } else {
            assert.equal(hasRecord, 0, 'Task uuid1 removed {keepHistory: false}');
          }
        });

        it('sendMail testing concatenation to the same addressee - same emails', async function () {
          const address = `mail-time-tests-5@${domain}`;
          let hasRecord;
          const opts = {
            sendAt: Date.now() + 50000,
            to: address,
            userName: 'Concatenator',
            subject: '{{userName}}: testing concatenation 1',
            text: '{{userName}}: testing concatenation 1',
            html: '<b>{{userName}}: testing concatenation 1</b>',
            template: '<body>{{{html}}}</body>',
          };
          const uuid1 = await mailTimes[type].sendMail(opts);

          const uuid2 = await mailTimes[type].sendMail({
            ...opts,
            sendAt: Date.now() + 50000
          });

          const concatUuid = await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(address, 'concatletter'));
          const task = JSON.parse(await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(concatUuid)));

          if (concat === true) {
            assert.equal(uuid1, uuid2, 'Email uuids are the same when concatenated');
            assert.equal(uuid1, concatUuid, 'Email uuids and concatUuid are the same when concatenated');
            assert.equal(task.mailOptions.length, 1, '{task.mailOptions} hold one emails');
          } else {
            assert.isNull(concatUuid, 'Concatenation is disabled');
            assert.notEqual(uuid1, uuid2, 'Email uuids are notEqual concatenation is disabled');

            const isCancelled = await mailTimes[type].cancelMail(uuid2);
            assert.isTrue(isCancelled, '2 isCancelled true from cancelMail');

            const sendTask = await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(uuid2, 'sendat'));
            assert.isNull(sendTask, 'sendTask cleared .cancelMail(uuid2)');

            hasRecord = await mailTimes[type].queue.client.exists(mailTimes[type].queue.__getKey(uuid2));
            if (keepHistory) {
              assert.equal(hasRecord, 1, 'Task uuid2 saved {keepHistory: true}');
            } else {
              assert.equal(hasRecord, 0, 'Task uuid2 removed {keepHistory: false}');
            }
          }

          const isCancelled = await mailTimes[type].cancelMail(uuid1);
          assert.isTrue(isCancelled, '1 isCancelled true from cancelMail');

          const sendTask = await mailTimes[type].queue.client.get(mailTimes[type].queue.__getKey(uuid1, 'sendat'));
          assert.isNull(sendTask, 'sendTask cleared .cancelMail(uuid1)');

          hasRecord = await mailTimes[type].queue.client.exists(mailTimes[type].queue.__getKey(uuid1));
          if (keepHistory) {
            assert.equal(hasRecord, 1, 'Task uuid1 saved {keepHistory: true}');
          } else {
            assert.equal(hasRecord, 0, 'Task uuid1 removed {keepHistory: false}');
          }
        });
      });

      describe('Callbacks', function () {
        this.slow(7750);
        this.timeout(8000);

        it('onError', async function () {
          const uuid = await mailTimes[type].sendMail({
            sendAt: Date.now() - 120000,
            to: `mail-time-tests-6@${crypto.randomUUID()}`,
            subject: 'test onError callback',
            text: 'sending email to invalid address',
            html: '<p>sending email to invalid email address</p>',
          });

          await wait(6500);

          assert.isString(uuid, 'uuid is String');
          assert.isObject(callbacks[uuid], 'error collected in callback');
          assert.isTrue(callbacks[uuid].task.isFailed, 'task.isFailed');
          assert.isFalse(callbacks[uuid].task.isSent, 'task.isSent');
          assert.isFalse(callbacks[uuid].task.isCancelled, 'task.isCancelled');
          assert.equal(callbacks[uuid].task.tries, 1, 'task.tries === 1');
          assert.oneOf(callbacks[uuid].error.toString(), ['Error: Message not accepted or Greeting never received', 'Error: Sending failed'], 'correct error received');
        });

        it('onError - Retry', async function () {
          this.slow(11500);
          this.timeout(12000);

          mailTimes[type].maxTries = 2;
          mailTimes[type].concatDelay = 100;

          const uuid = await mailTimes[type].sendMail({
            sendAt: Date.now() - 120000,
            to: `mail-time-tests-7@${crypto.randomUUID()}`,
            subject: 'test onError callback',
            text: 'sending email to invalid address',
            html: '<p>sending email to invalid email address</p>',
          });

          await wait(10000);

          assert.isString(uuid, 'uuid is String');
          assert.isObject(callbacks[uuid], 'error collected in callback');
          assert.isTrue(callbacks[uuid].task.isFailed, 'task.isFailed');
          assert.isFalse(callbacks[uuid].task.isSent, 'task.isSent');
          assert.isFalse(callbacks[uuid].task.isCancelled, 'task.isCancelled');
          assert.equal(callbacks[uuid].task.tries, 2, 'task.tries === 2');
          assert.oneOf(callbacks[uuid].error.toString(), ['Error: Message not accepted or Greeting never received', 'Error: Sending failed'], 'correct error received');

          mailTimes[type].maxTries = 1;
          mailTimes[type].concatDelay = 60000;
        });

        it('onSent', async function () {
          const uuid = await mailTimes[type].sendMail({
            sendAt: Date.now() - 120000,
            to: `mail-time-tests-8@${domain}`,
            subject: 'test onError callback',
            text: 'sending email to invalid address',
            html: '<p>sending email to invalid email address</p>',
          });

          await wait(6500);

          assert.isString(uuid, 'uuid is String');
          assert.isObject(callbacks[uuid], 'Data collected in callback');
          assert.isFalse(callbacks[uuid].task.isFailed, 'task.isFailed');
          assert.isTrue(callbacks[uuid].task.isSent, 'task.isSent');
          assert.isFalse(callbacks[uuid].task.isCancelled, 'task.isCancelled');
          assert.equal(callbacks[uuid].task.tries, 1, 'task.tries === 1');
          assert.isUndefined(callbacks[uuid].error, 'No error collected');
        });
      });
    });
  };

  runTests('WithConcatenation', true, false);
  runTests('WithoutConcatenation', false, false);
  runTests('WithHistory', false, true);
});

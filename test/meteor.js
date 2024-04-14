import { MongoInternals } from 'meteor/mongo';
import { MailTime, MongoQueue } from '../index.js';
import nodemailer from 'nodemailer';
import directTransport from 'nodemailer-direct-transport';
import { createClient } from 'redis';
import { assert } from 'chai';

if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined! Please run test with MONGO_URL, like `MONGO_URL=mongodb://127.0.0.1:27017/dbname npm test`');
}

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL env.var is not defined! Please run test with REDIS_URL, like `REDIS_URL=redis://127.0.0.1:6379 npm test`');
}

const transports = [];
const DEBUG = process.env.DEBUG === 'true' ? true : false;
const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
const domain = process.env.EMAIL_DOMAIN || 'example.com';
const TEST_TITLE = 'testSuiteMeteor';
const CHECK_TIMEOUT = 2048;

describe('Has MailTime Object', () => {
  it('MailTime is Constructor', () => {
    assert.isFunction(MailTime, 'MailTime is Constructor');
    assert.equal(typeof MailTime.Template === 'string', true, 'mailQueue has Template');
  });

  it('Change MailTime.Template', () => {
    assert.equal(MailTime.Template === '{{{html}}}', false, 'mailQueue.Template has original value (I know... it\'s "magic" setter/getter, so we got to test it)');
    MailTime.Template = '{{{html}}}';
    assert.equal(MailTime.Template === '{{{html}}}', true, 'mailQueue.Template has new value (I know... it\'s "magic" setter/getter, so we got to test it)');
  });
});

transports.push(nodemailer.createTransport(directTransport({
  pool: false,
  direct: true,
  name: domain,
  debug: DEBUG,
  logger: DEBUG ? console : void 0,
  from: `no-reply@${domain}`,
  connectionTimeout: 1000,
  greetingTimeout: 750,
  socketTimeout: 1500,
  dnsTimeout: 1500,
})));

const defaultQueueOptions = {
  transports,
  debug: DEBUG,
  type: 'server',
  from: `no-reply@${domain}`,
  strategy: 'balancer',
};

// let redisClient;
let mailQueues = {};

createClient({
  url: process.env.REDIS_URL
}).connect().then((redisClient) => {
  mailQueues.WithConcatenation = new MailTime(Object.assign({
    queue: new MongoQueue({
      db,
      prefix: `${TEST_TITLE}WithConcatenation`
    }),
    concatEmails: true,
    prefix: `${TEST_TITLE}WithConcatenation`,
    josk: {
      adapter: {
        type: 'redis',
        client: redisClient,
      }
    }
  }, defaultQueueOptions));

  mailQueues.WithoutConcatenation = new MailTime(Object.assign({
    queue: new MongoQueue({
      db,
      prefix: `${TEST_TITLE}WithoutConcatenation`
    }),
    concatEmails: false,
    prefix: `${TEST_TITLE}WithoutConcatenation`,
    josk: {
      adapter: {
        type: 'redis',
        client: redisClient,
      }
    }
  }, defaultQueueOptions));

  mailQueues.WithConcatenation.queue.collection.deleteMany({});
  mailQueues.WithoutConcatenation.queue.collection.deleteMany({});

  const runTests = (type, concat) => {
    describe(type, function () {
      const mailQueue = mailQueues[type];

      after(function () {
        mailQueue.queue.collection.deleteMany({});
      });

      describe('MailTime Instance', function () {
        this.slow(4000);
        this.timeout(30000);
        it('Check MailTime instance properties', function () {
          assert.instanceOf(mailQueue, MailTime, 'mailQueue is instance of MailTime');
          assert.equal(mailQueue.type, 'server', 'mailQueue has type');
          assert.equal(mailQueue.prefix, `${TEST_TITLE}${type}`, 'mailQueue has prefix');
          assert.equal(mailQueue.debug, DEBUG, 'mailQueue has debug');
          assert.equal(mailQueue.maxTries, 60, 'mailQueue has maxTries');
          assert.equal(mailQueue.retryDelay, 60000, 'mailQueue has retryDelay');
          assert.equal(mailQueue.template, '{{{html}}}', 'mailQueue has template');
          assert.equal(mailQueue.scheduler.zombieTime, 32786, 'mailQueue.scheduler has zombieTime');
          assert.equal(mailQueue.strategy, 'balancer', 'mailQueue has strategy');
          assert.equal(mailQueue.failsToNext, 4, 'mailQueue has failsToNext');
          assert.instanceOf(mailQueue.transports, Array, 'mailQueue has transports');
          assert.equal(mailQueue.transport, 0, 'mailQueue has transport');
          assert.equal(mailQueue.from(), `no-reply@${domain}`, 'mailQueue has from');
          assert.equal(mailQueue.concatEmails, concat, 'mailQueue has concatEmails');
          assert.equal(mailQueue.concatSubject, 'Multiple notifications', 'mailQueue has concatSubject');
          assert.equal(mailQueue.concatDelimiter, '<hr>', 'mailQueue has concatDelimiter');
          assert.equal(mailQueue.concatDelay, 60000, 'mailQueue has concatDelay');
          assert.equal(mailQueue.revolvingInterval, 1536, 'mailQueue.scheduler has revolvingInterval');
          assert.equal(mailQueue.scheduler.minRevolvingDelay, 512, 'mailQueue.scheduler has minRevolvingDelay');
          assert.equal(mailQueue.scheduler.maxRevolvingDelay, 2048, 'mailQueue.scheduler has maxRevolvingDelay');
        });
      });

      describe('ping', function () {
        this.slow(1000);
        this.timeout(2000);

        it('ping response', async function () {
          const pingRes = await mailQueue.ping();
          assert.isObject(pingRes, 'ping response is Object');
          assert.equal(pingRes.status, 'OK', 'ping.status');
          assert.equal(pingRes.code, 200, 'ping.code');
          assert.equal(pingRes.statusCode, 200, 'ping.statusCode');
          assert.isUndefined(pingRes.error, 'ping.error is undefined');
        });
      });

      describe('sendMail', function () {
        this.slow(5000);
        this.timeout(30000);

        it('sendMail Template placeholders render', function (done) {
          mailQueue.sendMail({
            sendAt: Date.now() + 50000,
            to: `mail-time-meteor-tests-1@${domain}`,
            subject: 'You\'ve got an email!',
            user: 'John',
            baseUrl: '<b>http://example.com</b>',
            text: '{{user}}, {{ baseUrl }}',
            html: '<p>Hi {{user}}, {{{ baseUrl }}}</p>',
            template: '{{{html}}} {{baseUrl}}',
          });

          setTimeout(async () => {
            const task = await mailQueue.queue.collection.findOne({
              'mailOptions.to': `mail-time-meteor-tests-1@${domain}`
            });
            assert.isObject(task, 'task is Object');

            const rendered = mailQueue.___compileMailOpts(transports[0], task);
            assert.equal(rendered.html, '<p>Hi John, <b>http://example.com</b></p> http://example.com', 'HTML template is properly rendered');
            assert.equal(rendered.text, 'John, http://example.com', 'Text template is properly rendered');
            done();
          }, CHECK_TIMEOUT);
        });

        it('sendMail with no template', function (done) {
          mailQueue.sendMail({
            sendAt: Date.now() + 50000,
            to: `mail-time-meteor-tests-2@${domain}`,
            subject: 'You\'ve got an email!',
            user: 'John',
            text: 'Plain text',
            html: '<p>Plain text</p>',
          });

          setTimeout(async () => {
            const task = await mailQueue.queue.collection.findOne({
              'mailOptions.to': `mail-time-meteor-tests-2@${domain}`
            });
            assert.isObject(task, 'task is Object');

            const rendered = mailQueue.___compileMailOpts(transports[0], task);
            assert.equal(rendered.html, '<p>Plain text</p>', 'HTML template is properly rendered');
            assert.equal(rendered.text, 'Plain text', 'Text template is properly rendered');
            done();
          }, CHECK_TIMEOUT);
        });

        it('sendMail with simple template', function (done) {
          mailQueue.sendMail({
            sendAt: Date.now() + 50000,
            to: `mail-time-meteor-tests-3@${domain}`,
            userName: 'Mike',
            subject: 'Sign up confirmation',
            text: 'Hello {{userName}}, \r\n Thank you for registration \r\n Your login: {{to}}',
            html: '<div style="text-align: center"><h1>Hello {{userName}}</h1><p><ul><li>Thank you for registration</li><li>Your login: {{to}}</li></ul></p></div>',
            template: '<body>{{{html}}}</body>'
          });

          setTimeout(async () => {
            const task = await mailQueue.queue.collection.findOne({
              'mailOptions.to': `mail-time-meteor-tests-3@${domain}`
            });
            assert.isObject(task, 'task is Object');

            const rendered = mailQueue.___compileMailOpts(transports[0], task);
            assert.equal(rendered.html, `<body><div style="text-align: center"><h1>Hello Mike</h1><p><ul><li>Thank you for registration</li><li>Your login: mail-time-meteor-tests-3@${domain}</li></ul></p></div></body>`, 'HTML template is properly rendered');
            assert.equal(rendered.text, `Hello Mike, \r\n Thank you for registration \r\n Your login: mail-time-meteor-tests-3@${domain}`, 'Text template is properly rendered');
            done();
          }, CHECK_TIMEOUT);
        });

        it('sendMail testing concatenation to the same addressee', function (done) {
          mailQueue.sendMail({
            sendAt: Date.now() + 50000,
            to: `mail-time-meteor-tests-4@${domain}`,
            userName: 'Concatenator',
            subject: '{{userName}}: testing concatenation 1',
            text: '{{userName}}: testing concatenation 1',
            html: '<b>{{userName}}: testing concatenation 1</b>',
            template: '<body>{{{html}}}</body>'
          });

          setTimeout(() => {
            mailQueue.sendMail({
              sendAt: Date.now() + 50000,
              to: `mail-time-meteor-tests-4@${domain}`,
              userName: 'Concatenator',
              subject: '{{userName}}: testing concatenation 2',
              text: '{{userName}}: testing concatenation 2',
              html: '<b>{{userName}}: testing concatenation 2</b>',
              template: '<body>{{{html}}}</body>'
            });
          }, CHECK_TIMEOUT / 4);

          setTimeout(async () => {
            const qty = await mailQueue.queue.collection.countDocuments({
              $or: [{
                to: `mail-time-meteor-tests-4@${domain}`
              }, {
                'mailOptions.to': `mail-time-meteor-tests-4@${domain}`
              }]
            });

            if (concat === true) {
              assert.equal(qty, 1, 'Has single email record with concatenation');
            } else {
              assert.equal(qty, 2, 'Has two email records without concatenation');
            }

            done();
          }, CHECK_TIMEOUT);
        });
      });
    });
  };

  runTests('WithConcatenation', true);
  runTests('WithoutConcatenation', false);
}).catch((err) => {
  console.error('CAUGHT', err);
});

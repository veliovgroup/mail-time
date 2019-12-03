if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined! Please run test with MONGO_URL, like `MONGO_URL=mongodb://127.0.0.1:27017/dbname npm test`');
}

const MailTime        = require('../index.js');
const nodemailer      = require('nodemailer');
const directTransport = require('nodemailer-direct-transport');
const { MongoClient, Cursor: MongoCursor } = require('mongodb');

const mongoAddr  = (process.env.MONGO_URL || '');
const dbName     = mongoAddr.split('/').pop().replace(/\/$/, '');
const transports = [];
const DEBUG      = process.env.DEBUG === 'true' ? true : false;
const domain     = process.env.EMAIL_DOMAIN || 'example.com';
const TEST_TITLE = 'testSuiteNPM';
const CHECK_TIMEOUT = 2048;

const { assert }       = require('chai');
const { it, describe } = require('mocha');

describe('Has MailTime Object', () => {
  it('MailTime is Constructor', () => {
    assert.isFunction(MailTime, 'MailTime is Constructor');
    assert.equal(typeof MailTime.Template === 'string', true, 'mailQueue has Template');
  });

  it('Change MailTime.Template', () => {
    assert.equal(MailTime.Template === '{{{html}}}', false, 'mailQueue.Template has original value');
    MailTime.Template = '{{{html}}}';
    assert.equal(MailTime.Template === '{{{html}}}', true, 'mailQueue.Template has new value');
  });
});

describe('MailTime Instance', async function () {
  this.slow(4000);
  this.timeout(30000);

  const client = await MongoClient.connect(mongoAddr, {
    j: true,
    w: 'majority',
    wtimeout: 30000,
    poolSize: 15,
    // readConcern: {
    //   level: 'majority'
    // },
    readPreference: 'primary',
    // reconnectTries: 60,
    socketTimeoutMS: 720000,
    useNewUrlParser: true,
    useUnifiedTopology: true,
    connectTimeoutMS: 120000,
    // reconnectInterval: 3072,
    connectWithNoPrimary: false,
    appname: 'mail-time-test-suite'
  });
  const db = client.db(dbName);

  transports.push(nodemailer.createTransport(directTransport({
    pool: false,
    direct: true,
    name: domain,
    debug: DEBUG,
    from: `no-reply@${domain}`,
    connectionTimeout: 30000,
    greetingTimeout: 15000,
    socketTimeout: 45000
  })));

  const defaultQueueOptions = {
    db,
    transports,
    debug: DEBUG,
    type: 'server',
    from: `no-reply@${domain}`,
    strategy: 'balancer'
  };

  const runTests = (type, concat) => {
    const mailQueue = new MailTime(Object.assign({
      concatEmails: concat,
      prefix: `${TEST_TITLE}${type}`
    }, defaultQueueOptions));

    mailQueue.collection.deleteMany({});

    describe(type, () => {
      describe('MailTime Instance', function () {
        it('Check MailTime instance properties', function () {
          assert.instanceOf(mailQueue, MailTime, 'mailQueue is instance of MailTime');
          assert.instanceOf(mailQueue.callbacks, Object, 'mailQueue has callbacks');
          assert.equal(mailQueue.type, 'server', 'mailQueue has type');
          assert.equal(mailQueue.prefix, `${TEST_TITLE}${type}`, 'mailQueue has prefix');
          assert.equal(mailQueue.debug, DEBUG, 'mailQueue has debug');
          assert.equal(mailQueue.maxTries, 60, 'mailQueue has maxTries');
          assert.equal(mailQueue.interval, 60000, 'mailQueue has interval');
          assert.equal(mailQueue.template, '{{{html}}}', 'mailQueue has template');
          assert.equal(mailQueue.zombieTime, 32786, 'mailQueue has zombieTime');
          assert.equal(mailQueue.strategy, 'balancer', 'mailQueue has strategy');
          assert.equal(mailQueue.failsToNext, 4, 'mailQueue has failsToNext');
          assert.instanceOf(mailQueue.transports, Array, 'mailQueue has transports');
          assert.equal(mailQueue.transport, 0, 'mailQueue has transport');
          assert.equal(mailQueue.from(), `no-reply@${domain}`, 'mailQueue has from');
          assert.equal(mailQueue.concatEmails, concat, 'mailQueue has concatEmails');
          assert.equal(mailQueue.concatSubject, 'Multiple notifications', 'mailQueue has concatSubject');
          assert.equal(mailQueue.concatDelimiter, '<hr>', 'mailQueue has concatDelimiter');
          assert.equal(mailQueue.concatThrottling, 60000, 'mailQueue has concatThrottling');
          assert.equal(mailQueue.revolvingInterval, 1536, 'mailQueue has revolvingInterval');
          assert.equal(mailQueue.minRevolvingDelay, 512, 'mailQueue has minRevolvingDelay');
          assert.equal(mailQueue.maxRevolvingDelay, 2048, 'mailQueue has maxRevolvingDelay');
        });
      });

      describe('sendMail', function () {
        this.slow(5000);
        this.timeout(30000);

        it('sendMail Template placeholders render', function (done) {
          mailQueue.sendMail({
            to: `mail-time-tests-1@${domain}`,
            subject: 'You\'ve got an email!',
            user: 'John',
            baseUrl: '<b>http://example.com</b>',
            text: '{{user}}, {{ baseUrl }}',
            html: '<p>Hi {{user}}, {{{ baseUrl }}}</p>',
            template: '{{{html}}} {{baseUrl}}',
            sendAt: new Date
          });

          setTimeout(() => {
            mailQueue.collection.findOne({
              'mailOptions.to': `mail-time-tests-1@${domain}`
            }, (findError, task) => {
              assert.equal(findError, undefined, 'no error');
              assert.isObject(task, 'task is Object');

              const rendered = mailQueue.___compileMailOpts(transports[0], task);
              assert.equal(rendered.html, '<p>Hi John, <b>http://example.com</b></p> http://example.com', 'HTML template is properly rendered');
              assert.equal(rendered.text, 'John, http://example.com', 'Text template is properly rendered');
              done();
            });
          }, CHECK_TIMEOUT);
        });

        it('sendMail with no template', function (done) {
          mailQueue.sendMail({
            to: `mail-time-tests-2@${domain}`,
            subject: 'You\'ve got an email!',
            user: 'John',
            text: 'Plain text',
            html: '<p>Plain text</p>',
          });

          setTimeout(() => {
            mailQueue.collection.findOne({
              'mailOptions.to': `mail-time-tests-2@${domain}`
            }, (findError, task) => {
              assert.equal(findError, undefined, 'no error');
              assert.isObject(task, 'task is Object');

              const rendered = mailQueue.___compileMailOpts(transports[0], task);
              assert.equal(rendered.html, '<p>Plain text</p>', 'HTML template is properly rendered');
              assert.equal(rendered.text, 'Plain text', 'Text template is properly rendered');
              done();
            });
          }, CHECK_TIMEOUT);
        });

        it('sendMail with simple template', function (done) {
          mailQueue.sendMail({
            to: `mail-time-tests-3@${domain}`,
            userName: 'Mike',
            subject: 'Sign up confirmation',
            text: 'Hello {{userName}}, \r\n Thank you for registration \r\n Your login: {{to}}',
            html: '<div style="text-align: center"><h1>Hello {{userName}}</h1><p><ul><li>Thank you for registration</li><li>Your login: {{to}}</li></ul></p></div>',
            template: '<body>{{{html}}}</body>'
          });

          setTimeout(() => {
            mailQueue.collection.findOne({
              'mailOptions.to': `mail-time-tests-3@${domain}`
            }, (findError, task) => {
              assert.equal(findError, undefined, 'no error');
              assert.isObject(task, 'task is Object');

              const rendered = mailQueue.___compileMailOpts(transports[0], task);
              assert.equal(rendered.html, `<body><div style="text-align: center"><h1>Hello Mike</h1><p><ul><li>Thank you for registration</li><li>Your login: mail-time-tests-3@${domain}</li></ul></p></div></body>`, 'HTML template is properly rendered');
              assert.equal(rendered.text, `Hello Mike, \r\n Thank you for registration \r\n Your login: mail-time-tests-3@${domain}`, 'Text template is properly rendered');
              done();
            });
          }, CHECK_TIMEOUT);
        });

        it('sendMail testing concatenation to the same addressee', function (done) {
          mailQueue.sendMail({
            to: `mail-time-tests-4@${domain}`,
            userName: 'Concatenator',
            subject: '{{Concatenator}}: testing concatenation 1',
            text: '{{Concatenator}}: testing concatenation 1',
            html: '<b>{{Concatenator}}: testing concatenation 1</b>',
            template: '<body>{{{html}}}</body>'
          });

          setTimeout(() => {
            mailQueue.sendMail({
              to: `mail-time-tests-4@${domain}`,
              userName: 'Concatenator',
              subject: '{{Concatenator}}: testing concatenation 2',
              text: '{{Concatenator}}: testing concatenation 2',
              html: '<b>{{Concatenator}}: testing concatenation 2</b>',
              template: '<body>{{{html}}}</body>'
            });
          }, CHECK_TIMEOUT / 4);

          setTimeout(() => {
            mailQueue.collection.find({
              $or: [{
                to: `mail-time-tests-4@${domain}`
              }, {
                'mailOptions.to': `mail-time-tests-4@${domain}`
              }]
            }, async (findError, taskCursor) => {
              assert.equal(findError, undefined, 'no error');
              assert.instanceOf(taskCursor, MongoCursor, 'taskCursor is Cursor');

              const qty = await taskCursor.count();

              if (concat === true) {
                assert.equal(qty, 1, 'Has single email record with concatenation');
              } else {
                assert.equal(qty, 2, 'Has two email records without concatenation');
              }

              taskCursor.close();
              done();
            });
          }, CHECK_TIMEOUT);
        });
      });
    });
  };

  runTests('WithConcatenation', true);
  runTests('WithoutConcatenation', false);
});


if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined! Please run test with MONGO_URL, like `MONGO_URL=mongodb://127.0.0.1:27017/dbname npm test`');
}

const MailTime        = require('../index.js');
const nodemailer      = require('nodemailer');
const directTransport = require('nodemailer-direct-transport');
const { MongoClient } = require('mongodb');

const mongoAddr  = (process.env.MONGO_URL || '');
const dbName     = mongoAddr.split('/').pop().replace(/\/$/, '');
const transports = [];
const DEBUG      = process.env.DEBUG === 'true' ? true : false;
const domain     = process.env.EMAIL_DOMAIN || 'example.com';
const TEST_TITLE = 'testSuiteNPM';
const CHECK_TIMEOUT = 1024;

const { assert } = require('chai');
const { it, describe, before } = require('mocha');

let db;
let client;
const mailTimes = {};

before(async function () {
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
    useNewUrlParser: true,
    useUnifiedTopology: true,
    connectTimeoutMS: 120000,
    // reconnectInterval: 3072,
    // connectWithNoPrimary: false,
    appname: 'mail-time-test-suite'
  });
  db = client.db(dbName);

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

  mailTimes.WithoutConcatenation = new MailTime(Object.assign({
    concatEmails: false,
    prefix: `${TEST_TITLE}WithoutConcatenation`
  }, defaultQueueOptions));
  await mailTimes.WithoutConcatenation.collection.deleteMany({});

  mailTimes.WithConcatenation = new MailTime(Object.assign({
    concatEmails: true,
    prefix: `${TEST_TITLE}WithConcatenation`
  }, defaultQueueOptions));
  await mailTimes.WithConcatenation.collection.deleteMany({});
});

describe('Has MailTime Object', function () {
  it('MailTime is Constructor', () => {
    assert.isFunction(MailTime, 'MailTime is Constructor');
    assert.equal(typeof MailTime.Template === 'string', true, 'MailTime# has Template');
  });

  it('Change MailTime.Template', () => {
    assert.equal(MailTime.Template === '{{{html}}}', false, 'MailTime#Template has original value');
    MailTime.Template = '{{{html}}}';
    assert.equal(MailTime.Template === '{{{html}}}', true, 'MailTime#Template has new value');
  });
});

describe('MailTime Instance', function () {
  this.slow(4000);
  this.timeout(8000);

  const runTests = (type, concat) => {
    describe(type, () => {
      describe('MailTime Instance', function () {
        it('Check MailTime instance properties', function () {
          assert.instanceOf(mailTimes[type], MailTime, 'mailTimes[type] is instance of MailTime');
          assert.instanceOf(mailTimes[type].callbacks, Object, 'mailTimes[type] has callbacks');
          assert.equal(mailTimes[type].type, 'server', 'mailTimes[type] has type');
          assert.equal(mailTimes[type].prefix, `${TEST_TITLE}${type}`, 'mailTimes[type] has prefix');
          assert.equal(mailTimes[type].debug, DEBUG, 'mailTimes[type] has debug');
          assert.equal(mailTimes[type].maxTries, 60, 'mailTimes[type] has maxTries');
          assert.equal(mailTimes[type].interval, 60000, 'mailTimes[type] has interval');
          assert.equal(mailTimes[type].template, '{{{html}}}', 'mailTimes[type] has template');
          assert.equal(mailTimes[type].zombieTime, 32786, 'mailTimes[type] has zombieTime');
          assert.equal(mailTimes[type].strategy, 'balancer', 'mailTimes[type] has strategy');
          assert.equal(mailTimes[type].failsToNext, 4, 'mailTimes[type] has failsToNext');
          assert.instanceOf(mailTimes[type].transports, Array, 'mailTimes[type] has transports');
          assert.equal(mailTimes[type].transport, 0, 'mailTimes[type] has transport');
          assert.equal(mailTimes[type].from(), `no-reply@${domain}`, 'mailTimes[type] has from');
          assert.equal(mailTimes[type].concatEmails, concat, 'mailTimes[type] has concatEmails');
          assert.equal(mailTimes[type].concatSubject, 'Multiple notifications', 'mailTimes[type] has concatSubject');
          assert.equal(mailTimes[type].concatDelimiter, '<hr>', 'mailTimes[type] has concatDelimiter');
          assert.equal(mailTimes[type].concatThrottling, 60000, 'mailTimes[type] has concatThrottling');
          assert.equal(mailTimes[type].revolvingInterval, 1536, 'mailTimes[type] has revolvingInterval');
          assert.equal(mailTimes[type].minRevolvingDelay, 512, 'mailTimes[type] has minRevolvingDelay');
          assert.equal(mailTimes[type].maxRevolvingDelay, 2048, 'mailTimes[type] has maxRevolvingDelay');
        });
      });

      describe('sendMail', function () {
        this.slow(5000);
        this.timeout(30000);

        it('sendMail Template placeholders render', function (done) {
          mailTimes[type].sendMail({
            to: `mail-time-tests-1@${domain}`,
            subject: 'You\'ve got an email!',
            user: 'John',
            baseUrl: '<b>http://example.com</b>',
            text: '{{user}}, {{ baseUrl }}',
            html: '<p>Hi {{user}}, {{{ baseUrl }}}</p>',
            template: '{{{html}}} {{baseUrl}}',
            sendAt: new Date(Date.now() + CHECK_TIMEOUT + 512)
          });

          setTimeout(() => {
            mailTimes[type].collection.findOne({
              'mailOptions.to': `mail-time-tests-1@${domain}`
            }, (findError, task) => {
              assert.equal(findError, undefined, 'no error');
              assert.isObject(task, 'task is Object');

              const rendered = mailTimes[type].___compileMailOpts(transports[0], task);
              assert.equal(rendered.html, '<p>Hi John, <b>http://example.com</b></p> http://example.com', 'HTML template is properly rendered');
              assert.equal(rendered.text, 'John, http://example.com', 'Text template is properly rendered');
              done();
            });
          }, CHECK_TIMEOUT);
        });

        it('sendMail with no template', function (done) {
          mailTimes[type].sendMail({
            to: `mail-time-tests-2@${domain}`,
            subject: 'You\'ve got an email!',
            user: 'John',
            text: 'Plain text',
            html: '<p>Plain text</p>',
          });

          setTimeout(() => {
            mailTimes[type].collection.findOne({
              'mailOptions.to': `mail-time-tests-2@${domain}`
            }, (findError, task) => {
              assert.equal(findError, undefined, 'no error');
              assert.isObject(task, 'task is Object');

              const rendered = mailTimes[type].___compileMailOpts(transports[0], task);
              assert.equal(rendered.html, '<p>Plain text</p>', 'HTML template is properly rendered');
              assert.equal(rendered.text, 'Plain text', 'Text template is properly rendered');
              done();
            });
          }, CHECK_TIMEOUT);
        });

        it('sendMail with simple template', function (done) {
          mailTimes[type].sendMail({
            to: `mail-time-tests-3@${domain}`,
            userName: 'Mike',
            subject: 'Sign up confirmation',
            text: 'Hello {{userName}}, \r\n Thank you for registration \r\n Your login: {{to}}',
            html: '<div style="text-align: center"><h1>Hello {{userName}}</h1><p><ul><li>Thank you for registration</li><li>Your login: {{to}}</li></ul></p></div>',
            template: '<body>{{{html}}}</body>'
          });

          setTimeout(() => {
            mailTimes[type].collection.findOne({
              'mailOptions.to': `mail-time-tests-3@${domain}`
            }, (findError, task) => {
              assert.equal(findError, undefined, 'no error');
              assert.isObject(task, 'task is Object');

              const rendered = mailTimes[type].___compileMailOpts(transports[0], task);
              assert.equal(rendered.html, `<body><div style="text-align: center"><h1>Hello Mike</h1><p><ul><li>Thank you for registration</li><li>Your login: mail-time-tests-3@${domain}</li></ul></p></div></body>`, 'HTML template is properly rendered');
              assert.equal(rendered.text, `Hello Mike, \r\n Thank you for registration \r\n Your login: mail-time-tests-3@${domain}`, 'Text template is properly rendered');
              done();
            });
          }, CHECK_TIMEOUT);
        });

        it('sendMail testing concatenation to the same addressee', function (done) {
          mailTimes[type].sendMail({
            to: `mail-time-tests-4@${domain}`,
            userName: 'Concatenator',
            subject: '{{userName}}: testing concatenation 1',
            text: '{{userName}}: testing concatenation 1',
            html: '<b>{{userName}}: testing concatenation 1</b>',
            template: '<body>{{{html}}}</body>'
          });

          setTimeout(() => {
            mailTimes[type].sendMail({
              to: `mail-time-tests-4@${domain}`,
              userName: 'Concatenator',
              subject: '{{userName}}: testing concatenation 2',
              text: '{{userName}}: testing concatenation 2',
              html: '<b>{{userName}}: testing concatenation 2</b>',
              template: '<body>{{{html}}}</body>'
            });
          }, CHECK_TIMEOUT / 4);

          setTimeout(async () => {
            const qty = await mailTimes[type].collection.countDocuments({
              $or: [{
                to: `mail-time-tests-4@${domain}`
              }, {
                'mailOptions.to': `mail-time-tests-4@${domain}`
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
});

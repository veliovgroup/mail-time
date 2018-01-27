if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined! Please run test with MONGO_URL, like `MONGO_URL=mongodb://127.0.0.1:27017/dbname npm test`');
}

const MailTime    = require('mail-time');
const nodemailer  = require('nodemailer');
const MongoClient = require('mongodb').MongoClient;
const mongoAddr   = (process.env.MONGO_URL || '');
const dbName      = mongoAddr.split('/').pop().replace(/\/$/, '');
const transports  = [];
const DEBUG       = false;

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

describe('MailTime Instance', function () {
  this.slow(82500);
  this.timeout(85000);

  (async function() {
    const client = await MongoClient.connect(mongoAddr);
    const db = client.db(dbName);

    transports.push(nodemailer.createTransport({
      pool: false,
      direct: true,
      name: 'example.com',
      debug: DEBUG,
      from: 'no-reply@example.com',
      connectionTimeout: 30000,
      greetingTimeout: 15000,
      socketTimeout: 45000
    }));

    const mailQueue = new MailTime({
      db,
      transports,
      prefix: 'testSuite',
      debug: DEBUG,
      type: 'server',
      from: 'no-reply@example.com',
      strategy: 'balancer',
      concatEmails: true
    });

    mailQueue.collection.remove({});

    describe('MailTime Instance', function () {
      it('Check MailTime instance properties', function () {
        assert.instanceOf(mailQueue, MailTime, 'mailQueue is instance of MailTime');
        assert.instanceOf(mailQueue.callbacks, Object, 'mailQueue has callbacks');
        assert.equal(mailQueue.type, 'server', 'mailQueue has type');
        assert.equal(mailQueue.prefix, 'testSuite', 'mailQueue has prefix');
        assert.equal(mailQueue.debug, DEBUG, 'mailQueue has debug');
        assert.equal(mailQueue.maxTries, 61, 'mailQueue has maxTries');
        assert.equal(mailQueue.interval, 60000, 'mailQueue has interval');
        assert.equal(mailQueue.template, '{{{html}}}', 'mailQueue has template');
        assert.equal(mailQueue.zombieTime, 32786, 'mailQueue has zombieTime');
        assert.equal(mailQueue.strategy, 'balancer', 'mailQueue has strategy');
        assert.equal(mailQueue.failsToNext, 4, 'mailQueue has failsToNext');
        assert.instanceOf(mailQueue.transports, Array, 'mailQueue has transports');
        assert.equal(mailQueue.transport, 0, 'mailQueue has transport');
        assert.equal(mailQueue.from(), 'no-reply@example.com', 'mailQueue has from');
        assert.equal(mailQueue.concatEmails, true, 'mailQueue has concatEmails');
        assert.equal(mailQueue.concatSubject, 'Multiple notifications', 'mailQueue has concatSubject');
        assert.equal(mailQueue.concatDelimiter, '<hr>', 'mailQueue has concatDelimiter');
        assert.equal(mailQueue.concatThrottling, 60000, 'mailQueue has concatThrottling');
      });
    });

    describe('sendMail', function () {
      this.slow(35000);
      this.timeout(62000);

      it('sendMail Template placeholders render', function (done) {
        mailQueue.sendMail({
          to: 'test1@email.com',
          subject: 'You\'ve got an email!',
          user: 'John',
          baseUrl: '<b>http://example.com</b>',
          text: '{{user}}, {{ baseUrl }}',
          html: '<p>Hi {{user}}, {{{ baseUrl }}}</p>',
          template: '{{{html}}} {{baseUrl}}'
        });

        setTimeout(() => {
          mailQueue.collection.findOne({
            to: 'test1@email.com'
          }, (findError, task) => {
            const rendered = mailQueue.___compileMailOpts(transports[0], task);
            assert.equal(rendered.html, '<p>Hi John, <b>http://example.com</b></p> http://example.com', 'HTML template is properly rendered');
            assert.equal(rendered.text, 'John, http://example.com', 'Text template is properly rendered');
            done();
          });
        }, 2500);
      });

      it('sendMail with no template', function (done) {
        mailQueue.sendMail({
          to: 'test2@email.com',
          subject: 'You\'ve got an email!',
          user: 'John',
          text: 'Plain text',
          html: '<p>Plain text</p>',
        });

        setTimeout(() => {
          mailQueue.collection.findOne({
            to: 'test2@email.com'
          }, (findError, task) => {
            const rendered = mailQueue.___compileMailOpts(transports[0], task);
            assert.equal(rendered.html, '<p>Plain text</p>', 'HTML template is properly rendered');
            assert.equal(rendered.text, 'Plain text', 'Text template is properly rendered');
            done();
          });
        }, 2500);
      });

      it('sendMail with simple template', function (done) {
        mailQueue.sendMail({
          to: 'test3@email.com',
          userName: 'Mike',
          subject: 'Sign up confirmation',
          text: 'Hello {{userName}}, \r\n Thank you for registration \r\n Your login: {{to}}',
          html: '<div style="text-align: center"><h1>Hello {{userName}}</h1><p><ul><li>Thank you for registration</li><li>Your login: {{to}}</li></ul></p></div>',
          template: '<body>{{{html}}}</body>'
        });

        setTimeout(() => {
          mailQueue.collection.findOne({
            to: 'test3@email.com'
          }, (findError, task) => {
            const rendered = mailQueue.___compileMailOpts(transports[0], task);
            assert.equal(rendered.html, '<body><div style="text-align: center"><h1>Hello Mike</h1><p><ul><li>Thank you for registration</li><li>Your login: test3@email.com</li></ul></p></div></body>', 'HTML template is properly rendered');
            assert.equal(rendered.text, 'Hello Mike, \r\n Thank you for registration \r\n Your login: test3@email.com', 'Text template is properly rendered');
            done();
          });
        }, 2500);
      });
    });
  })();
});


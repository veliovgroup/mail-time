import { Meteor }      from 'meteor/meteor';
import MailTime        from 'meteor/ostrio:mailer';
import nodemailer      from 'nodemailer';
import directTransport from 'nodemailer-direct-transport';
import { assert }      from 'meteor/practicalmeteor:chai';

if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined! Please run test with MONGO_URL, like `MONGO_URL=mongodb://127.0.0.1:27017/dbname npm test`');
}

const transports = [];
const DEBUG      = true;
const db         = Meteor.users.rawDatabase();

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

transports.push(nodemailer.createTransport(directTransport({
  pool: false,
  direct: true,
  name: 'example.com',
  debug: DEBUG,
  from: 'no-reply@example.com',
  connectionTimeout: 30000,
  greetingTimeout: 15000,
  socketTimeout: 45000
})));

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
      to: 'mail-time-meteor-tests-1@md5hashing.net',
      subject: 'You\'ve got an email!',
      user: 'John',
      baseUrl: '<b>http://example.com</b>',
      text: '{{user}}, {{ baseUrl }}',
      html: '<p>Hi {{user}}, {{{ baseUrl }}}</p>',
      template: '{{{html}}} {{baseUrl}}'
    });

    setTimeout(() => {
      mailQueue.collection.findOne({
        to: 'mail-time-meteor-tests-1@md5hashing.net'
      }, (findError, task) => {
        const rendered = mailQueue.___compileMailOpts(transports[0], task);
        assert.equal(rendered.html, '<p>Hi John, <b>http://example.com</b></p> http://example.com', 'HTML template is properly rendered');
        assert.equal(rendered.text, 'John, http://example.com', 'Text template is properly rendered');
        done();
      });
    }, 768);
  });

  it('sendMail with no template', function (done) {
    mailQueue.sendMail({
      to: 'mail-time-meteor-tests-2@md5hashing.net',
      subject: 'You\'ve got an email!',
      user: 'John',
      text: 'Plain text',
      html: '<p>Plain text</p>',
    });

    setTimeout(() => {
      mailQueue.collection.findOne({
        to: 'mail-time-meteor-tests-2@md5hashing.net'
      }, (findError, task) => {
        const rendered = mailQueue.___compileMailOpts(transports[0], task);
        assert.equal(rendered.html, '<p>Plain text</p>', 'HTML template is properly rendered');
        assert.equal(rendered.text, 'Plain text', 'Text template is properly rendered');
        done();
      });
    }, 768);
  });

  it('sendMail with simple template', function (done) {
    mailQueue.sendMail({
      to: 'mail-time-meteor-tests-3@md5hashing.net',
      userName: 'Mike',
      subject: 'Sign up confirmation',
      text: 'Hello {{userName}}, \r\n Thank you for registration \r\n Your login: {{to}}',
      html: '<div style="text-align: center"><h1>Hello {{userName}}</h1><p><ul><li>Thank you for registration</li><li>Your login: {{to}}</li></ul></p></div>',
      template: '<body>{{{html}}}</body>'
    });

    setTimeout(() => {
      mailQueue.collection.findOne({
        to: 'mail-time-meteor-tests-3@md5hashing.net'
      }, (findError, task) => {
        const rendered = mailQueue.___compileMailOpts(transports[0], task);
        assert.equal(rendered.html, '<body><div style="text-align: center"><h1>Hello Mike</h1><p><ul><li>Thank you for registration</li><li>Your login: mail-time-meteor-tests-3@md5hashing.net</li></ul></p></div></body>', 'HTML template is properly rendered');
        assert.equal(rendered.text, 'Hello Mike, \r\n Thank you for registration \r\n Your login: mail-time-meteor-tests-3@md5hashing.net', 'Text template is properly rendered');
        done();
      });
    }, 768);
  });
});


[![support](https://img.shields.io/badge/support-GitHub-white)](https://github.com/sponsors/dr-dimitru)
[![support](https://img.shields.io/badge/support-PayPal-white)](https://paypal.me/veliovgroup)
<a href="https://ostr.io/info/built-by-developers-for-developers">
  <img src="https://ostr.io/apple-touch-icon-60x60.png" height="20">
</a>

# MailTime

Micro-service package for mail queue, with *Server* and *Client* API.
Build on top of [`nodemailer`](https://github.com/nodemailer/nodemailer) package.

Every `MailTime` instance can be configured to be a *Server* or *Client*.

Main difference of *Server* from *Client* - *Server* handles queue and actually sends email.
While *Client* is only put emails into the queue.

"Mail-Time" is a micro-service package for mail queue, with *Server* and *Client* APIs. Build on top of the [`nodemailer`](https://github.com/nodemailer/nodemailer) package.

Every `MailTime` instance can get configured as *Server* or *Client*.

The main difference between *Server* and *Client* modes is that the *Server* handles the queue and __sends__ email. While the *Client* only __adds__ emails into the queue.

## ToC

- [How it works?](https://github.com/veliovgroup/Mail-Time#how-it-works)
  - [With single SMTP](https://github.com/veliovgroup/Mail-Time#single-point-of-failure)
  - [With multiple SMTP](https://github.com/veliovgroup/Mail-Time#multiple-smtp-providers)
  - [As Micro-Service](https://github.com/veliovgroup/Mail-Time#cluster-issue)
- [Features](https://github.com/veliovgroup/Mail-Time#features)
- [Installation](https://github.com/veliovgroup/Mail-Time#installation)
- [Meteor.js Installation](https://github.com/veliovgroup/Mail-Time#installation--import-via-npm): as [NPM Package](https://www.npmjs.com/package/mail-time)
- [Meteor.js Installation](https://github.com/veliovgroup/Mail-Time#installation--import-via-atmosphere): as [Atmosphere package](https://atmospherejs.com/ostrio/mailer)
- [Usage example](https://github.com/veliovgroup/Mail-Time#basic-usage)
- [API](https://github.com/veliovgroup/Mail-Time#api)
  - [*Constructor*](https://github.com/veliovgroup/Mail-Time#new-mailtimeopts-constructor)
  - [`.send()`](https://github.com/veliovgroup/Mail-Time#sendmailopts--callback)
  - [Default Template](https://github.com/veliovgroup/Mail-Time#static-mailtimetemplate)
- [Custom Templates](https://github.com/veliovgroup/Mail-Time#template-example)
- [~92% tests coverage](https://github.com/veliovgroup/Mail-Time#testing)

## Main features:

- 👨‍🔬 ~92% tests coverage;
- 📦 Two simple dependencies, written from scratch for top performance;
- 🏢 Synchronize email queue across multiple servers;
- 💪 Bulletproof design, built-in retries.

## How does it work?

Redundant solution for email transmission.

### Single point of failure

Issue - classic solution with a single point of failure:

```ascii
|----------------|         |------|         |------------------|
|  Other mailer  | ------> | SMTP | ------> |  ^_^ Happy user  |
|----------------|         |------|         |------------------|

The scheme above will work as long as SMTP service is available
or connection between your server and SMPT is up. Once network
failure occurs or SMTP service is down - users won't be happy

|----------------|  \ /    |------|         |------------------|
|  Other mailer  | --X---> | SMTP | ------> | 0_o Disappointed |
|----------------|  / \    |------|         |------------------|
                     ^- email lost in vain

Single SMTP solution may work in case of network or other failures
As long as MailTime has not received confirmation what email is sent
it will keep the letter in the queue and retry to send it again

|----------------|    /    |------|         |------------------|
|   Mail Time    | --X---> | SMTP | ------> |  ^_^ Happy user  |
|---^------------|  /      |------|         |------^-----------|
     \-------------/ ^- We will try later         /
      \- put it back into queue                  /
       \----------Once connection is back ------/
```

### Multiple SMTP providers

Backup scheme with multiple SMTP providers

```ascii
                           |--------|
                     /--X--| SMTP 1 |
                    /   ^  |--------|
                   /    \--- Retry with next provider
|----------------|/        |--------|         |------------------|
|   Mail Time    | ---X--> | SMTP 2 |      /->|  ^_^ Happy user  |
|----------------|\   ^    |--------|     /   |------------------|
                   \  \--- Retry         /
                    \      |--------|   /
                     \---->| SMTP 3 |--/
                           |--------|
```

### Cluster issue

It is common to create a "Cluster" of servers to balance the load and add a durability layer for horizontal scaling of quickly growing applications.

Most modern application has scheduled or recurring emails. For example, once a day — with recent news and updates. It won't be an issue with a single server setup — the server would send emails at a daily interval via timer or CRON. While in "Cluster" implementation — each server will attempt to send the same email. In such cases, users will receive multiple emails with the same content. We built MailTime to address this and other similar issues.

Here is how this issue is solved by using MailTime:

```ascii
|===================THE=CLUSTER===================| |=QUEUE=| |===Mail=Time===|
| |----------|     |----------|     |----------|  | |       | |=Micro-service=|   |--------|
| |   App    |     |   App    |     |   App    |  | |       | |               |-->| SMTP 1 |------\
| | Server 1 |     | Server 2 |     | Server 3 |  | |    <--------            |   |--------|       \
| |-----\----|     |----\-----|     |----\-----|  | |    -------->            |                |-------------|
|        \---------------\----------------\---------->      | |               |   |--------|   |     ^_^     |
| Each of the "App Server" or "Cluster Node"      | |       | |               |-->| SMTP 2 |-->| Happy users |
| runs Mail Time as a Client which only puts      | |       | |               |   |--------|   |-------------|
| emails into the queue. Aside to "App Servers"   | |       | |               |                    /
| We suggest running Mail Time as a Micro-service | |       | |               |   |--------|      /
| which will be responsible for making sure queue | |       | |               |-->| SMTP 3 |-----/
| has no duplicates and to actually send emails   | |       | |               |   |--------|
|=================================================| |=======| |===============|
```

## Features

- Queue - Managed via MongoDB, will survive server reboots and failures
- Support for multiple server setups - "Cluster", Phusion Passenger instances, Load Balanced solutions, etc.
- Emails concatenation by addressee email - Reduce amount of sent emails to a single user with concatenation, and avoid mistakenly doubled emails
- When concatenation is enabled - Same emails won't be sent twice, if for any reason, due to bad logic or application failure emails are sent twice or more times - this is solution to solve this annoying behavior
- Balancing for multiple nodemailer's transports, two modes - `backup` and `balancing`. This is the most useful feature — allowing to reduce the cost of SMTP services and add extra layer of durability. If one transport failing to send an email `mail-time` will switch to the next one
- Sending retries for network and other failures
- Templating support with [Mustache](https://mustache.github.io/)-like placeholders

## Installation

To implement Server functionality — as a first step install `nodemailer`, although this package meant to be used with `nodemailer`, it's not added as the dependency, as `nodemailer` not needed by Client, and you're free to choose `nodemailer`'s version to fit your project needs:

```shell
npm install --save nodemailer
```

Install *MailTime* package:

```shell
# for node@>=8.9.0
npm install --save mail-time

# for node@<8.9.0
npm install --save mail-time@=0.1.7
```

## Basic usage

Require package:

```js
const MailTime = require('mail-time');
```

Create nodemailer's transports (see [`nodemailer` docs](https://github.com/nodemailer/nodemailer/tree/v2#setting-up)):

```js
const transports = [];
const nodemailer = require('nodemailer');

// Use DIRECT transport
// and enable sending email from localhost
// install "nodemailer-direct-transport" NPM package:
const directTransport = require('nodemailer-direct-transport');
const directTransportOpts = {
  pool: false,
  direct: true,
  name: 'mail.example.com',
  from: 'no-reply@example.com',
};
transports.push(nodemailer.createTransport(directTransport(directTransportOpts)));
// IMPORTANT: Copy-paste passed options from directTransport() to
// transport's "options" property, to make sure it's available to MailTime package:
transports[0].options = directTransportOpts;

// Private SMTP
transports.push(nodemailer.createTransport({
  host: 'smtp.example.com',
  from: 'no-reply@example.com',
  auth: {
    user: 'no-reply',
    pass: 'xxx'
  },
}));

// Google Apps SMTP
transports.push(nodemailer.createTransport({
  host: 'smtp.gmail.com',
  from: 'no-reply@mail.example.com',
  auth: {
    user: 'no-reply@mail.example.com',
    pass: 'xxx'
  },
}));

// Mailing service (SparkPost as example)
transports.push(nodemailer.createTransport({
  host: 'smtp.sparkpostmail.com',
  port: 587,
  from: 'no-reply@mail2.example.com',
  auth: {
    user: 'SMTP_Injection',
    pass: 'xxx'
  },
}));
```

As the next step initiate `mail-time` in the *Server* mode, it will be able to __send__ and __add__ emails to the queue. Connecting to a MongoDB before initiating `new MailTime` instance:

```js
const MongoClient = require('mongodb').MongoClient;
const MailTime    = require('mail-time');
const dbName      = 'DatabaseName';

// We're using environment variable MONGO_URL
// to store connection string to MongoDB
// example: "MONGO_URL=mongodb://127.0.0.1:27017/myapp node mail-micro-service.js"
MongoClient.connect(process.env.MONGO_URL, (error, client) => {
  const db = client.db(dbName);

  const mailQueue = new MailTime({
    db, // MongoDB
    type: 'server',
    strategy: 'balancer', // Transports will be used in round robin chain
    transports,
    from(transport) {
      // To pass spam-filters `from` field should be correctly set
      // for each transport, check `transport` object for more options
      return `"Awesome App" <${transport.options.from}>`;
    },
    concatEmails: true, // Concatenate emails to the same addressee
    concatDelimiter: '<h1>{{{subject}}}</h1>', // Start each concatenated email with it's own subject
    template: MailTime.Template // Use default template
  });
});
```

Only __one__ `MailTime` *Server* instance required to send email. In the other parts of an app (like UI units or in sub-apps) use `mail-time` in the *Client* mode to __add__ emails to queue:

```js
const MongoClient = require('mongodb').MongoClient;
const MailTime    = require('mail-time');
const dbName      = 'DatabaseName';

MongoClient.connect(process.env.MONGO_URL, (error, client) => {
  const db = client.db(dbName);

  const mailQueue = new MailTime({
    db,
    type: 'client',
    strategy: 'balancer', // Transports will be used in round robin chain
    concatEmails: true // Concatenate emails to the same address
  });
});
```

Send email example:

```js
mailQueue.sendMail({
  to: 'user@gmail.com',
  subject: 'You\'ve got an email!',
  text: 'Plain text message',
  html: '<h1>HTML</h1><p>Styled message</p>'
});
```

### Two `MailTime` instances usage example

Create two `MailTime` instances with different settings.

```js
// USE FOR NON-URGENT EMAILS WHICH IS OKAY TO CONCATENATE
const mailQueue = new MailTime({
  db: db,
  interval: 35,
  strategy: 'backup',
  failsToNext: 1,
  concatEmails: true,
  concatThrottling: 16,
  zombieTime: 120000
});

// USE FOR TRANSACTIONAL EMAILS AND ALERTS
const mailInstantQueue = new MailTime({
  db: db,
  prefix: 'instant',
  interval: 2,
  strategy: 'backup',
  failsToNext: 1,
  concatEmails: false,
  zombieTime: 20000
});

mailQueue.sendMail({
  to: 'user@gmail.com',
  subject: 'You\'ve got an email!',
  text: 'Plain text message',
  html: '<h1>HTML</h1><p>Styled message</p>'
});

mailInstantQueue.sendMail({
  to: 'user@gmail.com',
  subject: 'Sign in request',
  text: 'Your OTP login code: xxxx:',
  html: '<h1>Code:</h1><code>XXXX</code>'
});
```

### Passing variables to the template

All options passed to the `.sendMail()` method is available inside `text`, `html`, and global templates

```js
const templates = {
  global: '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{{subject}}</title></head><body>{{{html}}}<footer>Message sent to @{{username}} user ({{to}})</footer></body></html>',
  signInCode: {
    text: 'Hello @{{username}}! Here\'s your login code: {{code}}'
    html: `<h1>Sign-in request</h1><p>Hello @{{username}}! <p>Copy your login code below:</p> <pre><code>{{code}}</code></pre>`
  }
}

const mailQueue = new MailTime({
  db: db,
  template: templates.global
});

mailQueue.sendMail({
  to: 'user@gmail.com',
  subject: 'Sign-in request',
  username: 'johndoe',
  code: 'XXXXX-YY',
  text: templates.signInCode.text,
  html: templates.signInCode.html
});
```

## Meteor.js usage:

Mail-Time package can be installed and used within [Meteor.js](https://docs.meteor.com/) via [NPM](https://www.npmjs.com/package/mail-time) or [Atmosphere](https://atmospherejs.com/ostrio/mailer)

### Installation & Import (*via NPM*):

Install [NPM `mail-time` package](https://www.npmjs.com/package/mail-time):

```shell
meteor npm install --save mail-time
```

Meteor.js: ES6 Import NPM package:

```js
import MailTime from 'mail-time';
```

### Installation & Import (*via Atmosphere*):

Install [Atmosphere `ostrio:mailer` package](https://atmospherejs.com/ostrio/mailer):

```shell
meteor add ostrio:mailer
```

Meteor.js: ES6 Import atmosphere package:

```js
import MailTime from 'meteor/ostrio:mailer';
```

### Usage:

`mail-time` package usage examples in Meteor.js

```js
import { MongoInternals } from 'meteor/mongo';

import MailTime from 'mail-time';
import nodemailer from 'nodemailer';
// Use DIRECT transport
// To enable sending email from localhost
// install "nodemailer-direct-transport" NPM package:
import directTransport from 'nodemailer-direct-transport';

const transports = [];
const directTransportOpts = {
  pool: false,
  direct: true,
  name: 'mail.example.com',
  from: 'no-reply@example.com',
};
transports.push(nodemailer.createTransport(directTransport(directTransportOpts)));
// IMPORTANT: Copy-paste passed options from directTransport() to
// transport's "options" property, to make sure it's available to MailTime package:
transports[0].options = directTransportOpts;

////////////////////////
// For more transports example see sections above and read nodemailer's docs
////////////////////////

const mailQueue = new MailTime({
  db: MongoInternals.defaultRemoteCollectionDriver().mongo.db, // MongoDB
  transports,
  from(transport) {
    // To pass spam-filters `from` field should be correctly set
    // for each transport, check `transport` object for more options
    return '"Awesome App" <' + transport.options.from + '>';
  }
});
```

## API

All available constructor options and `.sendMail()` method API overview

### `new MailTime(opts)` constructor

- `opts` {*Object*} - Configuration object
- `opts.db` {*Db*} - [Required] Mongo's `Db` instance. For example returned in callback of `MongoClient.connect()`
- `opts.type` {*String*} - [Optional] `client` or `server`, default - `server`
- `opts.from` {*Function*} - [Optional] A function which returns *String* of `from` field, format: `"MyApp" <user@example.com>`
- `opts.transports` {*Array*} - [Optional] An array of `nodemailer`'s transports, returned from `nodemailer.createTransport({})`
- `opts.strategy` {*String*} - [Optional] `backup` or `balancer`, default - `backup`. If set to `backup`, first transport will be used unless failed to send `failsToNext` times. If set to `balancer` - transports will be used equally in round robin chain
- `opts.failsToNext` {*Number*} - [Optional] After how many failed "send attempts" switch to next transport, applied only for `backup` strategy, default - `4`
- `opts.prefix` {*String*} - [Optional] Use unique prefixes to create multiple `MailTime` instances on same MongoDB
- `opts.maxTries` {*Number*} - [Optional] How many times resend failed emails, default - `60`
- `opts.interval` {*Number*} - [Optional] Interval in *seconds* between send re-tries, default - `60`
- `opts.zombieTime` {*Number*} - [Optional] Time in *milliseconds*, after this period - pending email will be interpreted as "*zombie*". This parameter allows to rescue pending email from "*zombie* mode" in case when: server was rebooted, exception during runtime was thrown, or caused by bad logic, default - `32786`. This option is used by package itself and passed directly to [`JoSk` package](https://github.com/veliovgroup/josk#api)
- `opts.keepHistory` {*Boolean*} - [Optional] By default sent emails not stored in the database. Set `{ keepHistory: true }` to keep queue task as it is in the database, default - `false`
- `opts.concatEmails` {*Boolean*} - [Optional] Concatenate email by `to` field, default - `false`
- `opts.concatSubject` {*String*} - [Optional] Email subject used in concatenated email, default - `Multiple notifications`
- `opts.concatDelimiter` {*String*} - [Optional] HTML or plain string delimiter used between concatenated email, default - `<hr>`
- `opts.concatThrottling` {*Number*} - [Optional] Time in *seconds* while emails are waiting to be concatenated, default - `60`
- `opts.revolvingInterval` {*Number*} - [Optional] Interval in *milliseconds* in between queue checks, default - `256`. Recommended value — between `opts.minRevolvingDelay` and `opts.maxRevolvingDelay`
- `opts.minRevolvingDelay` {*Number*} - [Optional] Minimum revolving delay — the minimum delay between tasks executions in *milliseconds*, default - `64`. This option is passed directly to [`JoSk` package](https://github.com/veliovgroup/josk#api)
- `opts.maxRevolvingDelay` {*Number*} - [Optional] Maximum revolving delay — the maximum delay between tasks executions in *milliseconds*, default - `256`. This option is passed directly to [`JoSk` package](https://github.com/veliovgroup/josk#api)
- `opts.template` {*String*} - [Optional] Mustache-like template, default - `{{{html}}}`, all options passed to `sendMail` is available in Template, like `to`, `subject`, `text`, `html` or any other custom option. Use `{{opt}}` for string placeholders and `{{{opt}}}` for html placeholders

### `sendMail(opts [, callback])`

- Alias - `send()`
- `opts` {*Object*} - Configuration object
- `opts.sendAt` {*Date*} - When email should be sent, default - `new Date()` use with caution on multi-server setup at different location with the different time-zones
- `opts.template` - Email specific template, this will override default template passed to `MailTime` constructor
- `opts.concatSubject` - Email specific concatenation subject, this will override default concatenation subject passed to `MailTime` constructor
- `opts[key]` {*Mix*} - Other custom and NodeMailer specific options, like `text`, `html` and `to`, see more [here](https://github.com/nodemailer/nodemailer/tree/v2#e-mail-message-fields). Note `attachments` should work only via `path`, and file must exists on all micro-services servers
- `callback` {*Function*} - Callback called after the email was sent or failed to be sent. __Do not use on multi-server setup__

### `static MailTime.Template`

Simple and bulletproof HTML template, see [its source](https://github.com/veliovgroup/Mail-Time/blob/master/template.html). Usage example:

```js
const MailTime  = require('mail-time');
// Make it default
const mailQueue = new MailTime({
  db: db, // MongoDB
  /* .. */
  template: MailTime.Template
});

// For single letter
mailQueue.sendMail({
  to: 'user@gmail.com',
  /* .. */
  template: MailTime.Template
});
```

### Template Example

Pass custom template via `template` property to `.sendMail()` method

```js
mailQueue.sendMail({
  to: 'user@gmail.com',
  userName: 'Mike',
  subject: 'Sign up confirmation',
  text: 'Hello {{userName}}, \r\n Thank you for registration \r\n Your login: {{to}}',
  html: '<div style="text-align: center"><h1>Hello {{userName}}</h1><p><ul><li>Thank you for registration</li><li>Your login: {{to}}</li></ul></p></div>',
  template: '<body>{{{html}}}</body>'
});
```

## Testing

1. Clone this package
2. In Terminal (*Console*) go to directory where package is cloned
3. Then run:

Test NPM package:

```shell
# Before run tests make sure NODE_ENV === development
# Install NPM dependencies
npm install --save-dev

# Before run tests you need to have running MongoDB
DEBUG="true" EMAIL_DOMAIN="example.com" MONGO_URL="mongodb://127.0.0.1:27017/npm-mail-time-test-001" npm test

# Be patient, tests are taking around 2 mins
```

Test Atmosphere (meteor.js) package:

```shell
# Default
EMAIL_DOMAIN="example.com" meteor test-packages ./ --driver-package=meteortesting:mocha

# With custom port
DEBUG="true" EMAIL_DOMAIN="example.com" meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# With local MongoDB and custom port
DEBUG="true" EMAIL_DOMAIN="example.com" MONGO_URL="mongodb://127.0.0.1:27017/meteor-mail-time-test-001" meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# Be patient, tests are taking around 2 mins
```

## Support this project:

- Star on [GitHub](https://github.com/veliovgroup/mail-time)
- Star on [NPM](https://www.npmjs.com/package/mail-time)
- Star on [Atmosphere](https://atmospherejs.com/ostrio/mailer)
- [Sponsor maintainer via GitHub](https://github.com/sponsors/dr-dimitru) — support open source with one-time contribution or on a regular basis
- [Sponsor veliovgroup via GitHub](https://github.com/sponsors/veliovgroup) — support company behind this package
- [Support via PayPal](https://paypal.me/veliovgroup) — support our open source contributions
- Use [ostr.io](https://ostr.io) — [Monitoring](https://snmp-monitoring.com), [Analytics](https://ostr.io/info/web-analytics), [WebSec](https://domain-protection.info), [Web-CRON](https://web-cron.info) and [Pre-rendering](https://prerendering.com) for a website

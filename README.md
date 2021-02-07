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

Issue - classic solution with the single point of failure:

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

Let's say you have an app which is growing fast. At some point, you've decided to create a "Cluster" of servers to balance the load and add durability layer.

Also, your application has scheduled emails, for example, once a day with recent news. While you have had single server emails was sent by some daily interval. So, after you made a "Cluster" of servers - each server has its own timer and going to send a daily email to our user. In such case - users will receive 3 emails, sounds not okay.

Here is how we solve this issue:

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

- Queue - Managed via MongoDB, and will survive server reboots and failures
- Support for multiple server setups - "Cluster", Phusion Passenger instances, Load Balanced solutions, etc.
- Emails concatenation by addressee email - Reduce amount of sent emails to a single user with concatenation, and avoid mistakenly doubled emails
- When concatenation is enabled - Same emails won't be sent twice, if for any reason, due to bad logic or application failure emails are sent twice or more times - this is solution to solve this annoying behavior
- Balancing for multiple nodemailer's transports, two modes - `backup` and `balancing`. Most useful feature - allows to reduce the cost of SMTP services and add durability. So, if any of used transports are failing to send an email it will switch to next one
- Sending retries for network and other failures
- Template support with Mustache-like placeholders

## Installation

If you're working on Server functionality - first you will need `nodemailer`, although this package is meant to be used with `nodemailer`, it's not added as the dependency, as it not needed by Client, and you're free to choose `nodemailer`'s version to fit your needs:

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

Create nodemailer's transports (see [nodemailer docs](https://github.com/nodemailer/nodemailer/tree/v2#setting-up)):

```js
const transports = [];
const nodemailer = require('nodemailer');

// Use DIRECT transport
// To enable sending email from localhost
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

Create `mail-time` *Server*, it is able to send and add emails to the queue.
We will need connect to MongoDB first:

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
      return '"Awesome App" <' + transport.options.from + '>';
    },
    concatEmails: true, // Concatenate emails to the same addressee
    concatDelimiter: '<h1>{{{subject}}}</h1>', // Start each concatenated email with it's own subject
    template: MailTime.Template // Use default template
  });
});
```

Create the *Client* to add emails to queue from other application units, like UI unit:

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

Send email:

```js
mailQueue.sendMail({
  to: 'user@gmail.com',
  subject: 'You\'ve got an email!',
  text: 'Plain text message',
  html: '<h1>HTML</h1><p>Styled message</p>'
});
```

## Meteor.js usage:

### Meteor.js Installation:

#### Installation & Import (*via NPM*):

Install NPM *MailTime* package:

```shell
meteor npm install --save mail-time
```

ES6 Import:

```js
import MailTime from 'mail-time';
```

#### Installation & Import (*via Atmosphere*):

Install Atmosphere *ostrio:mailer* package:

```shell
meteor add ostrio:mailer
```

ES6 Import:

```js
import MailTime from 'meteor/ostrio:mailer';
```

### Usage:

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

Simple and bulletproof HTML template, see its [source](https://github.com/veliovgroup/Mail-Time/blob/master/template.html). Usage:

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

- [Sponsor via GitHub](https://github.com/sponsors/dr-dimitru) — support open source contributions on a regular basis
- [Support via PayPal](https://paypal.me/veliovgroup) — support open source contributions once
- Use [ostr.io](https://ostr.io) — [Monitoring](https://snmp-monitoring.com), [Analytics](https://ostr.io/info/web-analytics), [WebSec](https://domain-protection.info), [Web-CRON](https://web-cron.info) and [Pre-rendering](https://prerendering.com) for a website

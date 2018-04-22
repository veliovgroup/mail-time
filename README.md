MailTime
========

Micro-service package for mail queue, with *Server* and *Client* API. 
Build on top of [`nodemailer`](https://github.com/nodemailer/nodemailer) package.

Every `MailTime` instance can be configured to be a *Server* or *Client*.

Main difference of *Server* from *Client* - *Server* handles queue and actually sends email. 
While *Client* is only put emails into the queue.

ToC
======
 - [How it works?](https://github.com/VeliovGroup/Mail-Time#how-it-works)
   * [With single SMTP](https://github.com/VeliovGroup/Mail-Time#single-point-of-failure)
   * [With multiple SMTP](https://github.com/VeliovGroup/Mail-Time#multiple-smtp-providers)
   * [As Micro-Service](https://github.com/VeliovGroup/Mail-Time#cluster-issue)
 - [Features](https://github.com/VeliovGroup/Mail-Time#features)
 - [Installation](https://github.com/VeliovGroup/Mail-Time#installation)
 - [Usage example](https://github.com/VeliovGroup/Mail-Time#basic-usage)
 - [API](https://github.com/VeliovGroup/Mail-Time#api)
   * [*Constructor*](https://github.com/VeliovGroup/Mail-Time#new-mailtimeopts-constructor)
   * [`.send()`](https://github.com/VeliovGroup/Mail-Time#sendmailopts--callback)
   * [Default Template](https://github.com/VeliovGroup/Mail-Time#static-mailtimetemplate)
 - [Custom Templates](https://github.com/VeliovGroup/Mail-Time#template-example)

## How it works?:

#### Single point of failure
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

#### Multiple SMTP providers
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

#### Cluster issue
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


Features
======
 - Queue - Managed via MongoDB, and will survive server reboots and failures
 - Support for multiple server setups - "Cluster", Phusion Passenger instances, Load Balanced solutions, etc.
 - Emails concatenation by addressee email - Reduce amount of sent email to single user with concatenation, and avoid mistakenly doubled emails
 - When concatenation is enabled - Same emails wouldn't be sent twice, if for any reason, due to bad logic or application failure emails is sent twice or more times - here is solution to solve this annoying behavior
 - Balancing for multiple nodemailer's transports, two modes - `backup` and `balancing`. Most useful feature - allows to reduce the cost of SMTP services and add durability. So, if any of used transports are failing to send an email it will switch to next one
 - Sending retries for network and other failures
 - Template support with Mustache-like placeholders

Installation
======
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

Basic usage
======
Require package:
```js
const MailTime = require('mail-time');
```

Create nodemailer's transports (see [nodemailer docs](https://github.com/nodemailer/nodemailer/tree/v2#setting-up)):
```js
const transports = [];

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
      return '"Awesome App" <' + transport._options.from + '>';
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

API
======
### `new MailTime(opts)` constructor
 - `opts` {*Object*} - Configuration object
 - `opts.db` {*Db*} - Mongo's `Db` instance. For example returned in callback of `MongoClient.connect()`
 - `opts.type` {*String*} - `client` or `server`, default - `server`
 - `opts.from` {*Function*} - A function which returns *String* of `from` field, format: `"MyApp" <user@example.com>`
 - `opts.transports` {*Array*} - An array of `nodemailer`'s transports, returned from `nodemailer.createTransport({})`
 - `opts.strategy` {*String*} - `backup` or `balancer`, default - `backup`. If set to `backup`, first transport will be used unless failed to send `failsToNext` times. If set to `balancer` - transports will be used equally in round robin chain
 - `opts.failsToNext` {*Number*} - After how many failed "send attempts" switch to next transport, applied only for `backup` strategy, default - `4`
 - `opts.prefix` {*String*} - Use unique prefixes to create multiple `MailTime` instances on same MongoDB
 - `opts.maxTries` {*Number*} - How many times resend failed emails, default - `60`
 - `opts.interval` {*Number*} - Interval in *seconds* between send re-tries, default - `60`
 - `opts.concatEmails` {*Boolean*} - Concatenate email by `to` field, default - `false`
 - `opts.concatSubject` {*String*} - Email subject used in concatenated email, default - `Multiple notifications`
 - `opts.concatDelimiter` {*String*} - HTML or plain string delimiter used between concatenated email, default - `<hr>`
 - `opts.concatThrottling` {*Number*} - Time in *seconds* while emails waiting to be concatenated, default - `60`
 - `opts.debug` {*Boolean*} - Print queue logs, default - `false`
 - `opts.template` {*String*} - Mustache-like template, default - `{{{html}}}`, all options passed to `sendMail` is available in Template, like `to`, `subject`, `text`, `html` or any other custom option. Use `{{opt}}` for string placeholders and `{{{opt}}}` for html placeholders

### `sendMail(opts [, callback])`
 - Alias - `send()`
 - `opts` {*Object*} - Configuration object
 - `opts.sendAt` {*Date*} - When email should be sent, default - `new Date()` use with caution on multi-server setup at different location with the different time-zones
 - `opts.template` - Email specific template, this will override default template passed to `MailTime` constructor
 - `opts.concatSubject` - Email specific concatenation subject, this will override default concatenation subject passed to `MailTime` constructor
 - `opts[key]` {*Mix*} - Other custom and NodeMailer specific options, like `text`, `html` and `to`, see more [here](https://github.com/nodemailer/nodemailer/tree/v2#e-mail-message-fields). Note `attachments` should work only via `path`, and file must exists on all micro-services servers
 - `callback` {*Function*} - Callback called after the email was sent or failed to be sent. __Do not use on multi-server setup__

### `static MailTime.Template`
Simple and bulletproof HTML template, see its [source](https://github.com/VeliovGroup/Mail-Time/blob/master/template.html). Usage:
```js
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


Testing
======
```shell
# Before run tests make sure NODE_ENV === development
# Install NPM dependencies
npm install --save-dev

# Before run tests you need to have running MongoDB
MONGO_URL="mongodb://127.0.0.1:27017/testCollectionName" npm test

# Be patient, tests are taking around 2 mins
```

Support this project:
======
This project wouldn't be possible without [ostr.io](https://ostr.io).

Using [ostr.io](https://ostr.io) you are not only [protecting domain names](https://ostr.io/info/domain-names-protection), [monitoring websites and servers](https://ostr.io/info/monitoring), using [Prerendering for better SEO](https://ostr.io/info/prerendering) of your JavaScript website, but support our Open Source activity, and great packages like this one could be available for free.

[![support](https://img.shields.io/badge/support-GitHub-white)](https://github.com/sponsors/dr-dimitru)
[![support](https://img.shields.io/badge/support-PayPal-white)](https://paypal.me/veliovgroup)
<a href="https://ostr.io/info/built-by-developers-for-developers?ref=github-mail-time-repo-top"><img src="https://ostr.io/apple-touch-icon-60x60.png" height="20"></a>
<a href="https://meteor-files.com/?ref=github-mail-time-repo-top"><img src="https://meteor-files.com/apple-touch-icon-60x60.png" height="20"></a>

# MailTime

"Mail-Time" is a micro-service package for mail queue, with *Server* and *Client* APIs. Build on top of the [`nodemailer`](https://github.com/nodemailer/nodemailer) package. Mail-Time made for single-server and horizontally scaled multi-server setups in mind.

Every `MailTime` instance can have `type` configured as *Server* or *Client*.

The main difference between *Server* and *Client* `type` is that the *Server* handles the queue and __sends__ email. While the *Client* only __adds__ emails into the queue.

## ToC

- [How it works?](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#how-it-works)
  - [With single SMTP](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#single-point-of-failure)
  - [With multiple SMTP](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#multiple-smtp-providers)
  - [For Clusters](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#sending-emails-from-cluster-of-servers)
- [Features](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#features)
- [Installation](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#installation)
- [Meteor.js usage](https://github.com/veliovgroup/mail-time/blob/master/docs/meteor.md)
- [Usage example](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#basic-usage)
- [API](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#api)
  - [`new MailTime` *Constructor*](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#new-mailtimeopts-constructor)
  - [`new RedisQueue` *Constructor*](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#new-redisqueueopts-constructor)
  - [`new MongoQueue` *Constructor*](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#new-mongoqueueopts-constructor)
  - [`.sendMail()`](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#sendmailopts)
  - [`.cancelMail()`](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#cancelmailuuid)
  - [Default Template](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#static-mailtimetemplate)
- [Custom Templates](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#template-example)
- [Running tests](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#testing)

## Main features:

- 👨‍🔬 ~94% tests coverage;
- 📦 Two simple dependencies, written from scratch for top performance;
- 🏢 Synchronize email queue across multiple (horizontally scaled) servers;
- 💪 Bulletproof design, built-in retries.

## How does it work?

Redundant solution for email transmission.

### Single point of failure

Issue - mitigate a single point of failure via persistent queue and re-send attempts

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

Rotate email transports by using multiple SMTP providers. *MailTime* support two strategies `backup` (*rotate when failed*) and `balancer` (*round-robin rotation*)

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

### Sending emails from cluster of servers

It is common to have horizontally scaled "Cluster" of servers for load-balancing and for durability.

Most modern application has scheduled or recurring emails. For example, once a day — with recent news and updates. It won't be an issue with a single server setup — the server would send emails at a daily interval via timer or CRON. But in "Cluster" implementation — each server will attempt to send the same email. MailTime built to avoid sending the same email multiple times to a user from horizontally scaled applications.

For the maximum durability and agility each Application Server can run MailTime in the "Server" mode:

```ascii
|===================THE=CLUSTER===================| |=QUEUE=|
| |----------|     |----------|     |----------|  | |       |   |--------|
| |   App    |     |   App    |     |   App    |  | |       |-->| SMTP 1 |------\
| | Server 1 |     | Server 2 |     | Server 3 |  | |       |   |--------|       \
| |-----\----|     |----\-----|     |----\-----|  | |       |                |-------------|
|        \---------------\----------------\---------->      |   |--------|   |     ^_^     |
|                                                 | |       |-->| SMTP 2 |-->| Happy users |
| Each "App Server" or "Cluster Node"             | |       |   |--------|   |-------------|
| runs MailTime as a "Server"                     | |       |                    /
| for the maximum durability                      | |       |   |--------|      /
|                                                 | |       |-->| SMTP 3 |-----/
|                                                 | |       |   |--------|
|=================================================| |=======|
```

To split roles MailTime can run on a dedicated machine as micro-service. This case is great for private email servers with implemented authentication via rDNS and PTR records:

```ascii
|===================THE=CLUSTER===================| |=QUEUE=| |===Mail=Time===|
| |----------|     |----------|     |----------|  | |       | |               |   |--------|
| |   App    |     |   App    |     |   App    |  | |       | | Micro-service |-->| SMTP 1 |------\
| | Server 1 |     | Server 2 |     | Server 3 |  | |       | | running       |   |--------|       \
| |-----\----|     |----\-----|     |----\-----|  | |       | | MailTime as   |                |-------------|
|        \---------------\----------------\---------->      | | "Server" only |   |--------|   |     ^_^     |
|                                                 | |       | | sending       |-->| SMTP 2 |-->| Happy users |
| Each "App Server" runs MailTime as              | |       | | emails        |   |--------|   |-------------|
| a "Client" only placing emails to the queue.    | |    <--------            |                    /
|                                                 | |    -------->            |   |--------|      /
|                                                 | |       | |               |-->| SMTP 3 |-----/
|                                                 | |       | |               |   |--------|
|=================================================| |=======| |===============|
```

## Features

- __Email Queue__ - Managed via MongoDB, will survive server reboots and failures
- __Support for horizontally scaled multi-server setups__ - "Cluster", multiple node.js instances, load balancing solutions, and similar. Great solution for applications scaled on a single machine, or multiple virtual or "bare metal" servers, or single or cross-border/worldwide across multiple data centers
- __Email concatenation__ - Reduce amount of sent emails to a single user with concatenation, and avoid mistakenly doubled emails. When concatenation is enabled the same emails (*checked by addressee and content*) won't be sent twice, if for any reason, due to bad logic or application failure emails are sent twice or more times - "email concatenation" is the solution to solve such annoying behavior
- __Multiple nodemailer/SMTP transports__ — Support for multiple SMPT transports implemented in two modes - `backup` and `balancing`. This feature allows to reduce the cost of SMTP services and add extra layer of durability. If one of the transports is failing to send an email `mail-time` will switch to the next one
- __Sending retries__ for network and other failures
- __Templating__ with [Mustache](https://mustache.github.io/)-like placeholders

## Installation

To implement Server functionality — as a first step install `nodemailer`, although this package meant to be used with `nodemailer`, it's not added as the dependency, as `nodemailer` not needed by Client, and you're free to choose `nodemailer`'s version to fit your project needs:

```shell
npm install --save nodemailer
```

Install *MailTime* package:

```shell
# for node@>=14.20.0
npm install --save mail-time

# for node@<14.20.0
npm install --save mail-time@=1.3.4

# for node@<8.9.0
npm install --save mail-time@=0.1.7
```

## Basic usage

Setup Nodemailer's transports, Queue storage, and *MailTime* instance

### Steps to get started

See steps 1-4 below to learn about different parts of *MailTime* library and how it can get used. From configuration options to sending email

#### 1. Require package

```js
// import as ES Module
import { MailTime, MongoQueue, RedisQueue } from 'mail-time';

// requires as CommonJS
const { MailTime, MongoQueue, RedisQueue } = require('mail-time');
```

#### 2. Create nodemailer's transports

For details and full list of options available in `.createTransport()` see [`nodemailer` docs](https://nodemailer.com/smtp/)

```js
// transports.js
import nodemailer from 'nodemailer';
// Use DIRECT transport
// and enable sending email from localhost
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
// IMPORTANT: Add `.options` to a newly created transport,
// this is necessary to make sure options are available to MailTime package:
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

export { transports };
```

#### 3. Initiate `mail-time`

Create new instance of *MailTime* in the *Server* mode, — it will be able to __send__ and __add__ emails to the queue.

3a. Connecting to Redis before initiating `new MailTime` instance:

```js
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';
import { transports } from './transports.js';

// Use REDIS_URL environment variable to store connection string to MongoDB
// example: "REDIS_URL=redis://127.0.0.1:6379/myapp node mail-micro-service.js"
const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();
const mailQueue = new MailTime({
  transports,
  queue: new MongoQueue({
    client: redisClient,
  }),
  josk: {
    adapter: {
      type: 'redis',
      client: redisClient,
    }
  },
  template: MailTime.Template // Use default template
  from(transport) {
    // To pass spam-filters `from` field should be correctly set
    // for each transport, check `transport` object for more options
    return `"Awesome App" <${transport.options.from}>`;
  },
  onError(error, email, details) {
    console.log(`Email "${email.mailOptions.subject}" wasn't sent to ${email.mailOptions.to}`, error, details);
  },
  onSent(email, details) {
    console.log(`Email "${email.mailOptions.subject}" successfully sent to ${email.mailOptions.to}`, details);
  },
});

export { mailQueue };
```

3b. Connecting to MongoDB before initiating `new MailTime` instance:

```js
import { MailTime, MongoQueue } from 'mail-time';
import { MongoClient } from 'mongodb';
import { transports } from './transports.js';

// Use MONGO_URL environment variable to store connection string to MongoDB
// example: "MONGO_URL=mongodb://127.0.0.1:27017/myapp node mail-micro-service.js"
const mongodb = (await MongoClient.connect(process.env.MONGO_URL)).db('database');
const mailQueue = new MailTime({
  transports,
  queue: new MongoQueue({
    db: mongodb,
  }),
  josk: {
    adapter: {
      type: 'mongo',
      db: mongodb,
    }
  },
  template: MailTime.Template // Use default template
  from(transport) {
    // To pass spam-filters `from` field should be correctly set
    // for each transport, check `transport` object for more options
    return `"Awesome App" <${transport.options.from}>`;
  },
  onError(error, email, details) {
    console.log(`Email "${email.mailOptions.subject}" wasn't sent to ${email.mailOptions.to}`, error, details);
  },
  onSent(email, details) {
    console.log(`Email "${email.mailOptions.subject}" successfully sent to ${email.mailOptions.to}`, details);
  },
});

export { mailQueue };
```

#### 3.1 Only __one__ `MailTime` *Server* instance required to send email. In the other parts of an app (like UI units or in sub-apps) use `mail-time` in the *Client* mode to __add__ emails to queue:

```js
// mail-queue.js
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';

const mailQueue = new MailTime({
  type: 'client',
  queue: new RedisQueue({
    client: await createClient({ url: 'redis://url' }).connect()
  }),
});

export { mailQueue };
```

#### 4. Send email

```js
import { mailQueue } from './mail-queue.js';

await mailQueue.sendMail({
  to: 'user@gmail.com',
  subject: 'You\'ve got an email!',
  text: 'Plain text message',
  html: '<h1>HTML</h1><p>Styled message</p>'
});
```

### Using MongoDB for queue and scheduler

*MailTime* uses separate storage for Queue management and Scheduler. In the example below MongoDB is used for both

```js
import { MongoClient } from 'mongodb';
import { MailTime, MongoQueue } from 'mail-time';
import { transports } from './transports.js';

const db = (await MongoClient.connect('mongodb://url')).db('database');
const mailQueue = new MailTime({
  queue: new MongoQueue({
    db: db,
  }),
  josk: {
    adapter: {
      type: 'mongo',
      db: db,
    }
  },
  transports,
  from(transport) {
    // To pass spam-filters `from` field should be correctly set
    // for each transport, check `transport` object for more options
    return `"Awesome App" <${transport.options.from}>`;
  }
});
```

### Using MongoDB for queue and Redis for scheduler

*MailTime* uses separate storage for Queue management and Scheduler. In the example below MongoDB is used for queue and Redis is used for scheduler

```js
import { MongoClient } from 'mongodb';
import { MailTime, MongoQueue } from 'mail-time';
import { createClient } from 'redis';
import { transports } from './transports.js';

const mailQueue = new MailTime({
  queue: new MongoQueue({
    db: (await MongoClient.connect('mongodb://url')).db('database'),
  }),
  josk: {
    adapter: {
      type: 'redis',
      client: await createClient({ url: 'redis://url' }).connect(),
    }
  },
  transports,
  from(transport) {
    return `"Awesome App" <${transport.options.from}>`;
  }
});
```

### Using Redis for queue and MongoDB for scheduler

*MailTime* uses separate storage for Queue management and Scheduler. In the example below Redis is used for queue and MongoDB is used for scheduler

```js
import { MongoClient } from 'mongodb';
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';
import { transports } from './transports.js';

const mailQueue = new MailTime({
  queue: new RedisQueue({
    client: await createClient({ url: 'redis://url' }).connect(),
  }),
  josk: {
    adapter: {
      type: 'mongo',
      db: (await MongoClient.connect('mongodb://url')).db('database'),
    }
  },
  transports,
  from(transport) {
    return `"Awesome App" <${transport.options.from}>`;
  }
});
```

### Using Redis for queue and scheduler

*MailTime* uses separate storage for Queue management and Scheduler. In the example below Redis is used for both

```js
import { MongoClient } from 'mongodb';
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';
import { transports } from './transports.js';

const redisClient = await createClient({ url: 'redis://url' }).connect();
const mailQueue = new MailTime({
  queue: new RedisQueue({
    client: redisClient,
  }),
  josk: {
    adapter: {
      type: 'redis',
      client: redisClient,
    }
  },
  transports,
  from(transport) {
    return `"Awesome App" <${transport.options.from}>`;
  }
});
```

### Two `MailTime` instances usage example

Create two `MailTime` instances with different settings. One for urgent (*e.g. "transactional" emails*), and another one for other types of emails (*e.g. "marketing" emails*)

```js
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';
import { transports } from './transports.js';
const redisClient = await createClient({ url: 'redis://url' }).connect();

// CREATE mailQueue FOR NON-URGENT EMAILS WHICH IS OKAY TO CONCATENATE
const mailQueue = new MailTime({
  queue: new RedisQueue({
    client: redisClient,
  }),
  transports,
  strategy: 'backup',
  failsToNext: 1,
  concatEmails: true,
  josk: {
    adapter: {
      type: 'redis',
      client: redisClient
    },
    zombieTime: 120000
  }
});

// CREATE mailInstantQueue FOR TRANSACTIONAL EMAILS AND ALERTS
const mailInstantQueue = new MailTime({
  queue: new RedisQueue({
    client: redisClient,
    prefix: 'instant'
  }),
  transports,
  prefix: 'instant',
  retryDelay: 2000,
  strategy: 'backup',
  failsToNext: 1,
  concatEmails: false,
  josk: {
    adapter: {
      type: 'redis',
      client: redisClient
    },
    zombieTime: 20000
  }
});

await mailQueue.sendMail({
  to: 'user@gmail.com',
  subject: 'You\'ve got an email!',
  text: 'Plain text message',
  html: '<h1>HTML</h1><p>Styled message</p>'
});

await mailInstantQueue.sendMail({
  to: 'user@gmail.com',
  subject: 'Sign in request',
  text: 'Your OTP login code: xxxx:',
  html: '<h1>Code:</h1><code>XXXX</code>'
});
```

### Passing variables to the template

All options passed to the `.sendMail()` method are available inside `text`, `html`, and global templates

```js
const templates = {
  global: '<html xmlns="http://www.w3.org/1999/xhtml"><head><title>{{subject}}</title></head><body>{{{html}}}<footer>Message sent to @{{username}} user ({{to}})</footer></body></html>',
  signInCode: {
    text: 'Hello @{{username}}! Here\'s your login code: {{code}}',
    html: `<h1>Sign-in request</h1><p>Hello @{{username}}! <p>Copy your login code below:</p> <pre><code>{{code}}</code></pre>`
  }
};

const mailQueue = new MailTime({
  queue: new RedisQueue({ /* ... */ }),
  template: templates.global
});

await mailQueue.sendMail({
  to: 'user@gmail.com',
  subject: 'Sign-in request',
  username: 'johndoe',
  code: 'XXXXX-YY',
  text: templates.signInCode.text,
  html: templates.signInCode.html
});
```

## API

All available constructor options and `.sendMail()` method API overview

### `new MailTime(opts)` constructor

- `opts` {*object*} - Configuration object
- `opts.type` {*string*} - [Optional] `client` or `server`, default - `server`
- `opts.queue` {*RedisQueue*|*MongoQueue*|*CustomQueue*} - Queue storage driver instance
- `opts.transports` {*[object]*} - [*Required for "server"*] An array of `nodemailer`'s transports, returned from `nodemailer.createTransport({})`. Required for `{type: 'server'}`
- `opts.josk` {*object*} - [*Required for "server"*] [`JoSk` package](https://github.com/veliovgroup/josk#api) options
- `opts.josk.adapter` {*object*|*RedisAdapter*|*MongoAdapter*|*CustomAdapter*} - Config object or *Adapter* instance
- `opts.josk.adapter.type` {*string*} - One of `mongo` *or* `redis`; Pass `josk.adapter.type` to avoid burden of creating *Adapter* instance manually
- `opts.josk.adapter.client` {*RedisClient*} - *RedisClient* instance
- `opts.josk.adapter.db` {*Db*} - Mongo's *Db* instance
- `opts.josk[option]` {*mix*} - Any other options passed to [`JoSk` instance](https://github.com/veliovgroup/josk#api)
- `opts.from` {*function*} - [Optional] A function which returns *string* of `from` field, format: `"MyApp" <user@example.com>`
- `opts.strategy` {*string*} - [Optional] `backup` or `balancer`, default - `backup`. If set to `backup`, first transport will be used unless failed to send `failsToNext` times. If set to `balancer` - transports will be used equally in round robin chain
- `opts.failsToNext` {*number*} - [Optional] After how many failed "send attempts" switch to the next transport, applied only for `backup` strategy, default - `4`
- `opts.prefix` {*string*} - [Optional] Use unique prefixes to create multiple `MailTime` instances within the same application
- `opts.retries` {*number*} - [Optional] How many times resend failed emails, default - `60`
- `opts.retryDelay` {*number*} - [Optional] Interval in *milliseconds* between send re-tries, default - `60000`
- `opts.keepHistory` {*boolean*} - [Optional] By default sent emails not stored in the database. Set `{ keepHistory: true }` to keep queue task as it is in the database, default - `false`
- `opts.concatEmails` {*boolean*} - [Optional] Concatenate email by `to` field (*e.g. to the same addressee*), default - `false`
- `opts.concatSubject` {*string*} - [Optional] Email subject used in concatenated email, default - `Multiple notifications`
- `opts.concatDelimiter` {*string*} - [Optional] HTML or plain string delimiter used between concatenated email, default - `<hr>`
- `opts.concatDelay` {*number*} - [Optional] Time in *milliseconds* while emails are waiting to be concatenated, default - `60000`
- `opts.revolvingInterval` {*number*} - [Optional] Interval in *milliseconds* in between queue checks, default - `256`
- `opts.template` {*string*} - [Optional] Mustache-like template, default - `{{{html}}}`, all options passed to `sendMail` is available in Template, like `to`, `subject`, `text`, `html` or any other custom option. Use `{{opt}}` for string placeholders and `{{{opt}}}` for html placeholders
- `opts.onError(error, email, details)` {*function*} - [Optional] called when email has failed to get sent and exhausted all send attempts (`opts.retries`), called with 3 arguments:
  - `error` {*Error*|*object*} - Error object
  - `email` {*object*} - email's object
  - `details` {*object*} - *not always present*, details from SMTP protocol
- `opts.onSent(email, details)` {*function*} - [Optional] called when email was successfully handed over to receiving/recipient's SMTP server, called with 2 arguments:
  - `email` {*object*} - email's object
  - `details` {*object*} - *not always present*, details from SMTP server/protocol

```js
import { MailTime, MongoQueue, RedisQueue } from 'mail-time';
import nodemailer from 'nodemailer';
import { createClient } from 'redis';

const redisClient = await createClient({ url: 'redis://url' }).connect();

const mailQueue = new MailTime({
  type: 'server',
  strategy: 'backup',
  prefix: 'appMailQueue',
  transports: [nodemailer.createTransport({/* ... */})],
  failsToNext: 4,
  retries: 60,
  retryDelay: 60000,
  keepHistory: false,
  concatEmails: false,
  concatDelay: 60000,
  concatDelimiter: '<hr>',
  concatSubject: 'Multiple notifications',
  revolvingInterval: 256,
  template: '{{{html}}}',
  queue: new RedisQueue({
    client: redisClient,
    prefix: 'appMailQueue',
  }),
  josk: {
    adapter: {
      type: 'redis',
      client: redisClient,
    }
  },
  from(transport) {
    // To pass spam-filters `from` field should be correctly set
    // for each transport, check `transport` object for more options
    return `"App Name" <${transport.options.from}>`;
  },
  onError(error, email, details) {
    console.log(`Email "${email.mailOptions.subject}" wasn't sent to ${email.mailOptions.to}`, error, details);
  },
  onSent(email, details) {
    console.log(`Email "${email.mailOptions.subject}" successfully sent to ${email.mailOptions.to}`, details);
  },
});

await mailQueue.sendMail({
  to: 'johndoe@example.com',
  subject: 'Email subject',
  text: 'You have got email!',
  html: '<p>You have got email!</p>',
});
```

### `new RedisQueue(opts)` constructor

*Create Redis Queue instance.* Use for `opts.queue` when creating *MailTime* instance

- `opts` {*object*} - Configuration object
- `opts.client` {*RedisClient*} - Required, Redis'es `RedisClient` instance, like one returned from `await redis.createClient().connect()` method
- `opts.prefix` {*string*} - Optional prefix for scope isolation; use when creating multiple `MailTime` instances within the single application

```js
import { MailTime, RedisQueue } from 'mail-time';
import { createClient } from 'redis';

new RedisQueue({
  client: await createClient({ url: 'redis://url' }).connect(),
  prefix: 'appMailQueue',
});
```

### `new MongoQueue(opts)` constructor

*Create MongoDB Queue instance.* Use for `opts.queue` when creating *MailTime* instance

- `opts` {*object*} - Configuration object
- `opts.db` {*Db*} - Required, Mongo's `Db` instance, like one returned from `MongoClient#db()`
- `opts.prefix` {*string*} - Optional prefix for scope isolation; use when creating multiple `MailTime` instances within the single application

```js
import { MailTime, MongoQueue } from 'mail-time';
import { MongoClient } from 'mongodb';

new MongoQueue({
  db: (await MongoClient.connect('mongodb://url')).db('database'),
  prefix: 'appMailQueue',
});
```

### `sendMail(opts)`

*Add email to the queue.* Returns `Promise<string>` unique email's `uuid`

- `opts` {*object*} - Configuration object
- `opts.sendAt` {*Date*} - When email should be sent, default - `Date.now()`; *Use with caution on multi-server setup at different location with the different time-zones*
- `opts.template` - Email specific template, this will override default template passed to `MailTime` constructor
- `opts.concatSubject` - Email specific concatenation subject, this will override default concatenation subject passed to `MailTime` constructor
- `opts[key]` {*mix*} - Other custom and NodeMailer specific options, like `text`, `html` and `to`, [learn more here](https://github.com/nodemailer/nodemailer/tree/v2#e-mail-message-fields). Note `attachments` should work only via `path`, and file must exists on all micro-services servers

### `cancelMail(uuid)`

*Removes email from queue.* Returns `Promise<boolean>` — `true` if cancelled or `false` if not found was sent or was cancelled previously. Throws *Error*

- `uuid` {*string|promise*} — email's `uuid` returned from `.sendEmail()` method

### `static MailTime.Template`

Simple and bulletproof HTML template, see [its source](https://github.com/veliovgroup/mail-time/blob/master/template.html). Usage example:

```js
import { MailTime, MongoQueue, RedisQueue } from 'mail-time';

// Make it default
const mailQueue = new MailTime({
  /* .. */
  template: MailTime.Template
});

// For single letter
mailQueue.sendMail({
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

# Before run tests you need to have running MongoDB and Redis
REDIS_URL="redis://127.0.0.1:6379" MONGO_URL="mongodb://127.0.0.1:27017/npm-mail-time-test-001" npm test

# OPTIONALLY RUN WITH CUSTOM DOMAIN
EMAIL_DOMAIN="your-domain.com" REDIS_URL="redis://127.0.0.1:6379" MONGO_URL="mongodb://127.0.0.1:27017/npm-mail-time-test-001" npm test

# IF SOME TESTS ARE FAILING: ENABLE DEBUG
DEBUG="true" REDIS_URL="redis://127.0.0.1:6379" MONGO_URL="mongodb://127.0.0.1:27017/npm-mail-time-test-001" npm test

# Be patient, tests are taking around 8 mins
```

## Support this project:

- Upload and share files using [☄️ meteor-files.com](https://meteor-files.com/?ref=github-mail-time-repo-footer) — Continue interrupted file uploads without losing any progress. There is nothing that will stop Meteor from delivering your file to the desired destination
- Use [▲ ostr.io](https://ostr.io?ref=github-mail-time-repo-footer) for [Server Monitoring](https://snmp-monitoring.com), [Web Analytics](https://ostr.io/info/web-analytics?ref=github-mail-time-repo-footer), [WebSec](https://domain-protection.info), [Web-CRON](https://web-cron.info) and [SEO Pre-rendering](https://prerendering.com) of a website
- Star on [GitHub](https://github.com/veliovgroup/mail-time)
- Star on [NPM](https://www.npmjs.com/package/mail-time)
- Star on [Atmosphere](https://atmospherejs.com/ostrio/mailer)
- [Sponsor maintainer via GitHub](https://github.com/sponsors/dr-dimitru) — support open source with one-time contribution or on a regular basis
- [Sponsor veliovgroup via GitHub](https://github.com/sponsors/veliovgroup) — support company behind this package
- [Support via PayPal](https://paypal.me/veliovgroup) — support our open source contributions

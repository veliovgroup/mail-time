# Meteor.js

We maintain a custom package build specifically for Meteor.js. Documentation from [NPM version of `mail-time`](https://github.com/veliovgroup/mail-time?tab=readme-ov-file#basic-usage) is valid and applicable to usage within Meteor.js in the same way as it's used in Node.js. The only difference in using [Atmosphere](https://atmospherejs.com/ostrio/mailer)/[Packosphere](https://packosphere.com/ostrio/mailer) version is in the `import`/`require` statement.

## Installation

Mail-Time package can be installed and used within Meteor.js via [NPM](https://www.npmjs.com/package/mail-time) or [Atmosphere](https://atmospherejs.com/ostrio/mailer)

### Install and import via Atmosphere

Install [Atmosphere `ostrio:mailer` package](https://atmospherejs.com/ostrio/mailer):

```shell
meteor add ostrio:mailer
```

Import `'meteor/ostrio:mailer'` package

```js
import { MailTime, MongoQueue, RedisQueue } from 'meteor/ostrio:mailer';
```

## Examples

`mail-time` package usage examples in Meteor.js

### Create NodeMailer transports

For compatibility and flexibility *MailTime* has no dependency on `nodemailer` it should be installed and imported manually. Create one or more "SMTP transports" before initializing new *MailTime* instance

```js
// transports.js
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
// IMPORTANT: Add `.options` to a newly created transport,
// this is necessary to make sure options are available to MailTime package:
transports[0].options = directTransportOpts;

export { transports };
```

### Using MongoDB for queue and scheduler

*MailTime* uses separate storage for Queue management and Scheduler. In the example below MongoDB is used for both

```js
import { MongoInternals } from 'meteor/mongo';
import { MailTime, MongoQueue } from 'meteor/ostrio:mailer';
import { transports } from './transports.js';

const mailQueue = new MailTime({
  queue: new MongoQueue({
    db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
  }),
  josk: {
    adapter: {
      type: 'mongo',
      db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
    }
  },
  transports,
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
```

### Using MongoDB for queue and Redis for scheduler

*MailTime* uses separate storage for Queue management and Scheduler. In the example below MongoDB is used for queue and Redis is used for scheduler

```js
import { MongoInternals } from 'meteor/mongo';
import { MailTime, MongoQueue } from 'meteor/ostrio:mailer';
import { createClient } from 'redis';
import { transports } from './transports.js';

const mailQueue = new MailTime({
  queue: new MongoQueue({
    db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
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
import { MongoInternals } from 'meteor/mongo';
import { MailTime, RedisQueue } from 'meteor/ostrio:mailer';
import { createClient } from 'redis';
import { transports } from './transports.js';

const mailQueue = new MailTime({
  queue: new RedisQueue({
    client: await createClient({ url: 'redis://url' }).connect(),
  }),
  josk: {
    adapter: {
      type: 'mongo',
      db: MongoInternals.defaultRemoteCollectionDriver().mongo.db,
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
import { MongoInternals } from 'meteor/mongo';
import { MailTime, RedisQueue } from 'meteor/ostrio:mailer';
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

## Testing

Run automated tests

1. Clone this package
2. In Terminal (*Console*) go to directory where package is cloned
3. Get URL for Redis database (*local or remote*)
4. Then run:

```shell
# Default
REDIS_URL="redis://127.0.0.1:6379" meteor test-packages ./ --driver-package=meteortesting:mocha

# Test with specific domain
EMAIL_DOMAIN="example.com" REDIS_URL="redis://127.0.0.1:6379" meteor test-packages ./ --driver-package=meteortesting:mocha

# In case of the errors, — enable DEBUG for detailed output
DEBUG="true"  REDIS_URL="redis://127.0.0.1:6379" meteor test-packages ./ --driver-package=meteortesting:mocha

# With custom port
REDIS_URL="redis://127.0.0.1:6379" meteor test-packages ./ --driver-package=meteortesting:mocha --port 8888

# With local MongoDB
MONGO_URL="mongodb://127.0.0.1:27017/meteor-mail-time-test-001" REDIS_URL="redis://127.0.0.1:6379" meteor test-packages ./ --driver-package=meteortesting:mocha

# Be patient, tests are taking around 2 mins
```

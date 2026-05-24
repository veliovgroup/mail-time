# MailTime in Meteor.js

A custom build of `mail-time` is published to Atmosphere as [`ostrio:mailer`](https://atmospherejs.com/ostrio/mailer). Configuration, API, retries, multi-SMTP, templates, and queue semantics are identical to the NPM version — see the main [README](../README.md) for everything API-related. This page covers only the Meteor-specific bits.

## Install

Via Atmosphere (recommended for Meteor projects):

```sh
meteor add ostrio:mailer
```

Via NPM (works inside Meteor too):

```sh
meteor npm install --save mail-time nodemailer
```

## Import

```js
// Atmosphere
import { MailTime, MongoQueue, RedisQueue, PostgresQueue } from 'meteor/ostrio:mailer';

// NPM (inside Meteor)
import { MailTime, MongoQueue, RedisQueue, PostgresQueue } from 'mail-time';
```

The only difference between the two is the module specifier. Everything else — constructor, methods, options — is the same as documented in the main [README API section](../README.md#api).

## Pulling Meteor's Mongo `db`

Meteor exposes the underlying Mongo `Db` instance through `MongoInternals`. Use it directly with `MongoQueue` and the Mongo `JoSk` adapter — no extra connection.

```js
import { MongoInternals } from 'meteor/mongo';

const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
```

## Examples

All examples below assume the transports are defined separately — see the [main README's transports section](../README.md#2-create-nodemailer-transports) for the shape `MailTime` expects.

### MongoDB queue + MongoDB scheduler

The most common Meteor setup — reuse the same Mongo connection Meteor already manages.

```js
import { MongoInternals } from 'meteor/mongo';
import { MailTime, MongoQueue } from 'meteor/ostrio:mailer';
import { transports } from './transports.js';

const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;

const mailQueue = new MailTime({
  type: 'server',
  prefix: 'app',
  queue: new MongoQueue({ db }),
  josk: {
    adapter: { type: 'mongo', db },
  },
  transports,
});

await mailQueue.ready();
export { mailQueue };
```

### MongoDB queue + Redis scheduler

Use Redis for tighter scheduler polling while keeping email storage in Meteor's Mongo:

```js
import { MongoInternals } from 'meteor/mongo';
import { MailTime, MongoQueue } from 'meteor/ostrio:mailer';
import { createClient } from 'redis';
import { transports } from './transports.js';

const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();

const mailQueue = new MailTime({
  type: 'server',
  prefix: 'app',
  queue: new MongoQueue({ db }),
  josk: {
    adapter: { type: 'redis', client: redisClient },
  },
  transports,
});
```

### Redis or PostgreSQL queues

`RedisQueue` and `PostgresQueue` work the same in Meteor as outside — see the [Storage layouts](../README.md#storage-layouts) section of the main README. Pass connected clients exactly the same way.

## Client-only mode

For multi-app deployments where one Meteor service drains the queue and the others only enqueue:

```js
import { MongoInternals } from 'meteor/mongo';
import { MailTime, MongoQueue } from 'meteor/ostrio:mailer';

const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;

export const mailQueue = new MailTime({
  type: 'client',
  prefix: 'app',
  queue: new MongoQueue({ db }),
});
```

No `transports`, no `josk` — the client only writes letters to the shared store.

## Shutdown

Meteor doesn't always signal a clean shutdown to Node, but for tests and graceful redeploys stop the scheduler and drain in-flight sends:

```js
process.on('SIGTERM', async () => {
  await mailQueue.destroy({ drain: true });
});
```

## Testing

The repository ships a `test/meteor.js` suite that exercises the package end-to-end inside Meteor:

```sh
meteor npm install

# All adapter combinations (local)
REDIS_URL=redis://127.0.0.1:6379 \
PG_URL=postgres://127.0.0.1:5432/postgres \
  meteor test-packages ./ --driver-package=meteortesting:mocha

# CI-style subsets via METEOR_TEST_SUITE
METEOR_TEST_SUITE=mongo meteor test-packages ./ --driver-package=meteortesting:mocha
METEOR_TEST_SUITE=redis REDIS_URL=redis://127.0.0.1:6379 meteor test-packages ./ --driver-package=meteortesting:mocha
METEOR_TEST_SUITE=postgres PG_URL=postgres://127.0.0.1:5432/postgres meteor test-packages ./ --driver-package=meteortesting:mocha
```

`METEOR_TEST_SUITE` accepts `mongo` (built-in MongoDB only), `redis`, `postgres`, or a comma-separated label list (`MongoMongo`, `MongoRedis`, …). Provide `REDIS_URL` / `PG_URL` only when the selected suite needs them.

## See also

- [Main README — full configuration & API](../README.md)
- [Queue adapter contract (custom adapters)](./queue-api.md)
- [JoSk — the underlying scheduler](https://github.com/veliovgroup/josk)

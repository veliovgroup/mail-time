import { MailTime, MongoQueue, PostgresQueue, RedisQueue } from '../index.js';
import { MongoClient } from 'mongodb';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { assert } from 'chai';
import { after, before, describe, it } from 'mocha';

if (!process.env.PG_URL) {
  throw new Error('PG_URL env.var is not defined! Please run test with PG_URL, like `PG_URL=postgres://127.0.0.1:5432/postgres npm test`');
}

const TEST_TITLE = `mail-time-test-suite-postgres-${Date.now()}`;
const domain = process.env.EMAIL_DOMAIN || 'example.com';
const combos = [
  ['postgres', 'postgres'],
  ['postgres', 'redis'],
  ['postgres', 'mongo'],
  ['redis', 'postgres'],
  ['mongo', 'postgres']
];

let pgPool;
let mongoClient;
let mongoDb;
let redisClient;
const mailTimes = [];
const prefixes = [];

const getMongoDbName = (mongoUrl) => {
  const parsed = new URL(mongoUrl);
  return parsed.pathname.replace(/^\/+|\/+$/g, '') || 'npm-mail-time-test';
};

const hasTypeConnection = (type) => {
  if (type === 'postgres') {
    return !!process.env.PG_URL;
  }

  if (type === 'redis') {
    return !!process.env.REDIS_URL;
  }

  if (type === 'mongo') {
    return !!process.env.MONGO_URL;
  }

  return false;
};

const hasComboConnection = ([queueType, schedulerType]) => {
  return hasTypeConnection(queueType) && hasTypeConnection(schedulerType);
};

const clearRedisPattern = async (pattern) => {
  if (!redisClient) {
    return;
  }

  const cursor = redisClient.scanIterator({
    MATCH: pattern,
    COUNT: 9999,
  });

  for await (const cursorValue of cursor) {
    const keys = Array.isArray(cursorValue) ? cursorValue : [cursorValue];
    if (keys.length) {
      await redisClient.del(keys);
    }
  }
};

const cleanupQueue = async (type, prefix) => {
  if (type === 'postgres') {
    await pgPool.query('DELETE FROM mail_time_queue WHERE prefix = $1', [prefix]).catch(() => void 0);
    return;
  }

  if (type === 'redis') {
    await clearRedisPattern(`mailtime:${prefix}:*`);
    return;
  }

  if (type === 'mongo' && mongoDb) {
    await mongoDb.collection(`__mailTimeQueue__${prefix}`).deleteMany({});
  }
};

const cleanupScheduler = async (type, prefix) => {
  const schedulerPrefix = `mailTimeQueue${prefix}`;

  if (type === 'postgres') {
    await pgPool.query('DELETE FROM josk_tasks WHERE prefix = $1', [schedulerPrefix]).catch(() => void 0);
    await pgPool.query('DELETE FROM josk_locks WHERE lock_key = $1', [`josk-${schedulerPrefix}.lock`]).catch(() => void 0);
    return;
  }

  if (type === 'redis') {
    await clearRedisPattern(`josk:${schedulerPrefix}*`);
    return;
  }

  if (type === 'mongo' && mongoDb) {
    await mongoDb.collection(`__JobTasks__${schedulerPrefix}`).deleteMany({});
    await mongoDb.collection('__JobTasks__.lock').deleteMany({
      uniqueName: `__JobTasks__${schedulerPrefix}`,
    });
  }
};

const createQueue = (type, prefix) => {
  if (type === 'postgres') {
    return new PostgresQueue({
      client: pgPool,
      prefix,
    });
  }

  if (type === 'redis') {
    return new RedisQueue({
      client: redisClient,
      prefix,
    });
  }

  return new MongoQueue({
    db: mongoDb,
    prefix,
  });
};

const createSchedulerAdapter = (type) => {
  if (type === 'postgres') {
    return {
      type,
      client: pgPool,
      resetOnInit: true,
    };
  }

  if (type === 'redis') {
    return {
      type,
      client: redisClient,
    };
  }

  return {
    type,
    db: mongoDb,
    resetOnInit: true,
  };
};

const countQueue = async (type, queue, prefix, uuid) => {
  if (type === 'postgres') {
    const res = await pgPool.query('SELECT COUNT(*)::int AS total FROM mail_time_queue WHERE prefix = $1 AND uuid = $2', [prefix, uuid]);
    return res.rows[0].total;
  }

  if (type === 'redis') {
    return await redisClient.exists(queue.__getKey(uuid));
  }

  return await queue.collection.countDocuments({
    uuid,
  });
};

const createTransport = () => {
  return {
    options: {
      from: `no-reply@${domain}`,
    },
    sendMail(mail, done) {
      done(null, {
        accepted: [mail.to],
        rejected: [],
      });
    },
  };
};

describe('Postgres queue and scheduler combinations', function () {
  this.slow(3000);
  this.timeout(20000);

  before(async function () {
    pgPool = new Pool({
      connectionString: process.env.PG_URL,
      max: 1,
    });
    await pgPool.query('SELECT 1');

    if (process.env.REDIS_URL) {
      redisClient = await createClient({
        url: process.env.REDIS_URL,
      }).connect();
    }

    if (process.env.MONGO_URL) {
      mongoClient = await MongoClient.connect(process.env.MONGO_URL, {
        appName: TEST_TITLE,
        connectTimeoutMS: 120000,
        socketTimeoutMS: 720000,
      });
      mongoDb = mongoClient.db(getMongoDbName(process.env.MONGO_URL));
    }
  });

  after(async function () {
    for (const mailTime of mailTimes) {
      mailTime.destroy();
    }

    for (const { queueType, schedulerType, prefix } of prefixes) {
      await cleanupQueue(queueType, prefix);
      await cleanupScheduler(schedulerType, prefix);
    }

    if (redisClient) {
      await redisClient.quit();
    }

    if (mongoClient) {
      await mongoClient.close();
    }

    if (pgPool) {
      await pgPool.end();
    }
  });

  for (const combo of combos) {
    const [queueType, schedulerType] = combo;
    const testFn = hasComboConnection(combo) ? it : it.skip;

    testFn(`${queueType} queue with ${schedulerType} scheduler`, async function () {
      const prefix = `${TEST_TITLE}-${queueType}-${schedulerType}`;
      prefixes.push({
        queueType,
        schedulerType,
        prefix,
      });

      await cleanupQueue(queueType, prefix);
      await cleanupScheduler(schedulerType, prefix);

      const sent = {};
      const queue = createQueue(queueType, prefix);
      const mailTime = new MailTime({
        type: 'server',
        prefix,
        queue,
        transports: [createTransport()],
        josk: {
          adapter: createSchedulerAdapter(schedulerType),
          execute: 'one',
          lockOwnerId: `${prefix}-owner`,
        },
        retries: 0,
        retryDelay: 250,
        revolvingInterval: 600000,
        from: `no-reply@${domain}`,
        onSent(task, details) {
          sent[task.uuid] = {
            task,
            details,
          };
        },
      });
      mailTimes.push(mailTime);

      await mailTime.ready();
      const ping = await mailTime.ping();
      assert.equal(ping.status, 'OK', 'ping.status');

      const uuid = await mailTime.sendMail({
        sendAt: Date.now() - 1000,
        to: `mail-time-postgres-${queueType}-${schedulerType}@${domain}`,
        subject: 'Postgres combination',
        text: 'Postgres combination text',
      });

      assert.equal(await countQueue(queueType, queue, prefix, uuid), 1, 'queued task exists');
      await mailTime.queue.iterate();
      await mailTime.drain();
      assert.isObject(sent[uuid], 'onSent callback called');
      assert.equal(await countQueue(queueType, queue, prefix, uuid), 0, 'sent task removed');

      const futureUuid = await mailTime.sendMail({
        sendAt: Date.now() + 60000,
        to: `mail-time-postgres-cancel-${queueType}-${schedulerType}@${domain}`,
        subject: 'Postgres cancellation',
        text: 'Postgres cancellation text',
      });

      assert.isTrue(await mailTime.cancelMail(futureUuid), 'future task cancelled');
      assert.equal(await countQueue(queueType, queue, prefix, futureUuid), 0, 'cancelled task removed');
      assert.isTrue(mailTime.destroy(), 'MailTime destroyed');
    });
  }
});

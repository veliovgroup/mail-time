import { MongoInternals } from 'meteor/mongo';
import { MailTime, MongoQueue, PostgresQueue, RedisQueue } from '../index.js';
import { createClient } from 'redis';
import { Pool } from 'pg';
import { assert } from 'chai';

if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined! Please run test with MONGO_URL, like `MONGO_URL=mongodb://127.0.0.1:27017/dbname npm test`');
}

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL env.var is not defined! Please run test with REDIS_URL, like `REDIS_URL=redis://127.0.0.1:6379 npm test`');
}

const DEBUG = process.env.DEBUG === 'true';
const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
const domain = process.env.EMAIL_DOMAIN || 'example.com';
const TEST_TITLE = `testSuiteMeteor-${Date.now()}`;
const CHECK_TIMEOUT = 2048;

const createTransport = () => ({
  options: {
    pool: false,
    direct: true,
    name: domain,
    debug: DEBUG,
    from: `no-reply@${domain}`,
  },
  sendMail(mail, done) {
    const to = Array.isArray(mail.to) ? mail.to[0] : mail.to;
    if (typeof to === 'string' && to.endsWith(`@${domain}`)) {
      done(null, { accepted: [to], rejected: [], response: 'OK' });
      return;
    }
    done(new Error('Sending failed'), { accepted: [], rejected: [to] });
  },
});

const transports = [createTransport()];
const defaultQueueOptions = {
  transports,
  debug: DEBUG,
  type: 'server',
  from: `no-reply@${domain}`,
  strategy: 'balancer',
};

describe('Has MailTime Object', () => {
  it('MailTime is Constructor', () => {
    assert.isFunction(MailTime, 'MailTime is Constructor');
    assert.equal(typeof MailTime.Template === 'string', true, 'mailQueue has Template');
  });

  it('Change MailTime.Template', () => {
    const orig = MailTime.Template;
    assert.equal(MailTime.Template === '{{{html}}}', false, 'Template has original value');
    MailTime.Template = '{{{html}}}';
    assert.equal(MailTime.Template === '{{{html}}}', true, 'Template has new value');
    MailTime.Template = orig;
  });
});

const mailQueues = {};
const cleanupFns = [];

const buildMongoQueue = (prefix) => new MongoQueue({ db, prefix });
const buildRedisQueue = (client, prefix) => new RedisQueue({ client, prefix });
const buildPostgresQueue = (client, prefix) => new PostgresQueue({ client, prefix });

(async () => {
  const redisClient = await createClient({ url: process.env.REDIS_URL }).connect();
  cleanupFns.push(() => redisClient.quit());

  let pgPool;
  if (process.env.PG_URL) {
    pgPool = new Pool({ connectionString: process.env.PG_URL });
    cleanupFns.push(() => pgPool.end());
  }

  // Mongo queue + Redis scheduler (Meteor canonical setup).
  mailQueues.MongoRedis = new MailTime({
    ...defaultQueueOptions,
    prefix: `${TEST_TITLE}-MongoRedis`,
    queue: buildMongoQueue(`${TEST_TITLE}-MongoRedis`),
    concatEmails: true,
    josk: { adapter: { type: 'redis', client: redisClient } },
  });

  // Redis queue + Mongo scheduler.
  mailQueues.RedisMongo = new MailTime({
    ...defaultQueueOptions,
    prefix: `${TEST_TITLE}-RedisMongo`,
    queue: buildRedisQueue(redisClient, `${TEST_TITLE}-RedisMongo`),
    concatEmails: false,
    josk: { adapter: { type: 'mongo', db } },
  });

  // Postgres queue + Postgres scheduler (only when PG_URL is provided).
  if (pgPool) {
    mailQueues.Postgres = new MailTime({
      ...defaultQueueOptions,
      prefix: `${TEST_TITLE}-Postgres`,
      queue: buildPostgresQueue(pgPool, `${TEST_TITLE}-Postgres`),
      concatEmails: false,
      josk: { adapter: { type: 'postgres', client: pgPool } },
    });
  }

  await Promise.all(Object.values(mailQueues).map((mq) => mq.ready()));

  // Reset state across runs.
  await mailQueues.MongoRedis.queue.collection.deleteMany({}).catch(() => {});
  if (mailQueues.Postgres) {
    await pgPool.query('DELETE FROM mail_time_queue WHERE prefix = $1', [mailQueues.Postgres.queue.prefix]).catch(() => {});
  }

  const introspect = async (mailQueue) => {
    if (mailQueue.queue.name === 'mongo-queue') {
      return await mailQueue.queue.collection.find({}).toArray();
    }
    if (mailQueue.queue.name === 'postgres-queue') {
      const res = await pgPool.query('SELECT to_address as to FROM mail_time_queue WHERE prefix = $1', [mailQueue.prefix]);
      return res.rows;
    }
    return null;
  };

  const runTests = (label, concat) => {
    const mailQueue = mailQueues[label];
    if (!mailQueue) {
      return;
    }

    describe(label, function () {
      this.slow(5000);
      this.timeout(30000);

      after(async () => {
        await mailQueue.destroy?.();
      });

      it('exposes MailTime properties', () => {
        assert.instanceOf(mailQueue, MailTime, 'is MailTime');
        assert.equal(mailQueue.type, 'server');
        assert.equal(mailQueue.scheduler.zombieTime, 60000);
        assert.equal(mailQueue.scheduler.minRevolvingDelay, 512);
        assert.equal(mailQueue.scheduler.maxRevolvingDelay, 2048);
      });

      it('ping returns OK', async () => {
        const r = await mailQueue.ping();
        assert.equal(r.status, 'OK');
      });

      it('sends, then cancels a future-dated mail', async () => {
        const uuid = await mailQueue.sendMail({
          sendAt: Date.now() + 60000,
          to: `mail-time-meteor-${label}@${domain}`,
          subject: 'hi',
          text: 'plain',
          html: '<p>plain</p>',
        });
        assert.isString(uuid);

        const cancelled = await mailQueue.cancelMail(uuid);
        assert.isTrue(cancelled);
      });

      it('respects concatEmails setting', function (done) {
        const address = `concat-${label}@${domain}`;
        mailQueue.sendMail({
          sendAt: Date.now() + 60000,
          to: address,
          subject: 'First',
          text: 'First',
          html: '<p>First</p>',
        });

        setTimeout(() => {
          mailQueue.sendMail({
            sendAt: Date.now() + 60000,
            to: address,
            subject: 'Second',
            text: 'Second',
            html: '<p>Second</p>',
          });
        }, CHECK_TIMEOUT / 4);

        setTimeout(async () => {
          const docs = await introspect(mailQueue) ?? [];
          const matches = docs.filter((d) => d.to === address);
          if (concat) {
            assert.equal(matches.length, 1, 'folded into one letter');
          } else {
            assert.equal(matches.length, 2, 'kept as two letters');
          }
          done();
        }, CHECK_TIMEOUT);
      });
    });
  };

  runTests('MongoRedis', true);
  runTests('RedisMongo', false);
  runTests('Postgres', false);

  after(async () => {
    for (const fn of cleanupFns.reverse()) {
      await fn().catch(() => {});
    }
  });
})().catch((err) => {
  console.error('Meteor test bootstrap failed', err);
});

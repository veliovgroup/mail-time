import { MongoInternals } from 'meteor/mongo';
import { MailTime, MongoQueue, PostgresQueue, RedisQueue } from '../index.js';
import { createClient } from 'redis';
import { Pool } from 'pg';
import { assert } from 'chai';
import { randomUUID } from 'node:crypto';

if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined! Please run test with MONGO_URL, like `MONGO_URL=mongodb://127.0.0.1:27017/dbname npm test`');
}

if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL env.var is not defined! Please run test with REDIS_URL, like `REDIS_URL=redis://127.0.0.1:6379 npm test`');
}

const DEBUG = process.env.DEBUG === 'true';
const HAS_PG = !!process.env.PG_URL;
const db = MongoInternals.defaultRemoteCollectionDriver().mongo.db;
const domain = process.env.EMAIL_DOMAIN || 'example.com';
const TEST_TITLE = `testSuiteMeteor-${Date.now()}`;

const sentByUuid = new Map();
const errorByUuid = new Map();

const createTransport = () => ({
  options: {
    pool: false,
    direct: true,
    name: domain,
    debug: DEBUG,
    from: `no-reply@${domain}`,
  },
  // Per-recipient accept/reject so multi-recipient + partial-delivery paths
  // through ___trackAcceptedRecipients / ___finalizeRejected get exercised.
  sendMail(mail, done) {
    const list = Array.isArray(mail.to) ? mail.to : [mail.to];
    const accepted = [];
    const rejected = [];
    for (const to of list) {
      if (typeof to === 'string' && to.endsWith(`@${domain}`)) {
        accepted.push(to);
      } else {
        rejected.push(to);
      }
    }
    if (accepted.length === 0) {
      done(new Error('Sending failed'), { accepted, rejected });
      return;
    }
    done(null, { accepted, rejected, response: 'OK' });
  },
});

const transports = [createTransport(), createTransport()];
const defaultQueueOptions = {
  transports,
  debug: DEBUG,
  type: 'server',
  from: `no-reply@${domain}`,
  strategy: 'balancer',
  maxTries: 2,
  retryDelay: 100,
  onSent: (task) => { sentByUuid.set(task.uuid, task); },
  onError: (err, task) => { if (task) errorByUuid.set(task.uuid, { err, task }); },
};

const mailQueues = {};
const cleanupFns = [];
let redisClient;
let pgPool;

const buildMongoQueue = (prefix) => new MongoQueue({ db, prefix });
const buildRedisQueue = (client, prefix) => new RedisQueue({ client, prefix });
const buildPostgresQueue = (client, prefix) => new PostgresQueue({ client, prefix });

const clearRedisPattern = async (client, pattern) => {
  const cursor = client.scanIterator({ TYPE: 'string', MATCH: pattern, COUNT: 9999 });
  for await (const chunk of cursor) {
    const keys = Array.isArray(chunk) ? chunk : [chunk];
    if (keys.length) {
      await client.del(keys);
    }
  }
};

// Normalize each adapter's row shape into a common { uuid, tries, isSending,
// sendingAt, mailOptions } plus the adapter-specific id (_id for mongo,
// id for postgres) so the returned object can be passed back to queue.update.
const introspect = async (mailQueue) => {
  if (mailQueue.queue.name === 'mongo-queue') {
    return mailQueue.queue.collection.find({}).toArray();
  }
  if (mailQueue.queue.name === 'postgres-queue') {
    const res = await pgPool.query(
      `SELECT id, uuid, tries, is_sending, sending_at, mail_options
         FROM mail_time_queue
        WHERE prefix = $1`,
      [mailQueue.prefix]
    );
    return (res.rows || []).map((r) => ({
      id: r.id,
      uuid: r.uuid,
      tries: parseInt(r.tries, 10),
      isSending: r.is_sending === true,
      sendingAt: r.sending_at !== null && r.sending_at !== undefined ? parseInt(r.sending_at, 10) : 0,
      mailOptions: typeof r.mail_options === 'string' ? JSON.parse(r.mail_options) : r.mail_options,
    }));
  }
  if (mailQueue.queue.name === 'redis-queue') {
    const out = [];
    const cursor = redisClient.scanIterator({
      TYPE: 'string',
      MATCH: `mailtime:${mailQueue.prefix}:letter:*`,
      COUNT: 9999,
    });
    for await (const chunk of cursor) {
      const keys = Array.isArray(chunk) ? chunk : [chunk];
      for (const key of keys) {
        const raw = await redisClient.get(key);
        if (raw) {
          out.push(JSON.parse(raw));
        }
      }
    }
    return out;
  }
  return [];
};

const recipientList = (mo) => Array.isArray(mo.to) ? mo.to : (typeof mo.to === 'string' ? [mo.to] : []);

const findByMailTo = (docs, address) =>
  (docs || []).filter((d) => (d.mailOptions || []).some((mo) => recipientList(mo).includes(address)));

const waitUntil = async (fn, { timeout = 10000, interval = 64, label = 'condition' } = {}) => {
  const deadline = Date.now() + timeout;
  let lastErr;
  while (Date.now() < deadline) {
    try {
      const result = await fn();
      if (result) {
        return result;
      }
    } catch (err) {
      lastErr = err;
    }
    await new Promise((r) => setTimeout(r, interval));
  }
  throw new Error(`waitUntil(${label}) timed out after ${timeout}ms${lastErr ? `: ${lastErr.message}` : ''}`);
};

before(async function () {
  this.timeout(30000);

  redisClient = await createClient({ url: process.env.REDIS_URL }).connect();
  cleanupFns.push(() => redisClient.quit());

  if (HAS_PG) {
    pgPool = new Pool({ connectionString: process.env.PG_URL });
    cleanupFns.push(() => pgPool.end());
  }

  // Mongo queue + Redis scheduler — Meteor canonical setup.
  mailQueues.MongoRedis = new MailTime({
    ...defaultQueueOptions,
    prefix: `${TEST_TITLE}-MongoRedis`,
    queue: buildMongoQueue(`${TEST_TITLE}-MongoRedis`),
    concatEmails: true,
    josk: { adapter: { type: 'redis', client: redisClient } },
  });

  // Mongo queue + Mongo scheduler — single-backend deployment.
  mailQueues.MongoMongo = new MailTime({
    ...defaultQueueOptions,
    prefix: `${TEST_TITLE}-MongoMongo`,
    queue: buildMongoQueue(`${TEST_TITLE}-MongoMongo`),
    concatEmails: false,
    josk: { adapter: { type: 'mongo', db } },
  });

  // Redis queue + Mongo scheduler.
  mailQueues.RedisMongo = new MailTime({
    ...defaultQueueOptions,
    prefix: `${TEST_TITLE}-RedisMongo`,
    queue: buildRedisQueue(redisClient, `${TEST_TITLE}-RedisMongo`),
    concatEmails: false,
    josk: { adapter: { type: 'mongo', db } },
  });

  // Redis queue + Redis scheduler — single-backend deployment.
  mailQueues.RedisRedis = new MailTime({
    ...defaultQueueOptions,
    prefix: `${TEST_TITLE}-RedisRedis`,
    queue: buildRedisQueue(redisClient, `${TEST_TITLE}-RedisRedis`),
    concatEmails: true,
    josk: { adapter: { type: 'redis', client: redisClient } },
  });

  if (HAS_PG) {
    mailQueues.PostgresPostgres = new MailTime({
      ...defaultQueueOptions,
      prefix: `${TEST_TITLE}-PostgresPostgres`,
      queue: buildPostgresQueue(pgPool, `${TEST_TITLE}-PostgresPostgres`),
      concatEmails: false,
      josk: { adapter: { type: 'postgres', client: pgPool } },
    });
  }

  await Promise.all(Object.values(mailQueues).map((mq) => mq.ready()));

  // Wipe any leftovers from prior runs across every queue (each adapter
  // separately — wildcard `TEST_TITLE-*` prefix lets a re-run with the same
  // base title avoid colliding with the previous attempt).
  await mailQueues.MongoRedis.queue.collection.deleteMany({}).catch(() => {});
  await mailQueues.MongoMongo.queue.collection.deleteMany({}).catch(() => {});
  await clearRedisPattern(redisClient, `mailtime:${TEST_TITLE}-RedisMongo:*`).catch(() => {});
  await clearRedisPattern(redisClient, `mailtime:${TEST_TITLE}-RedisRedis:*`).catch(() => {});
  if (mailQueues.PostgresPostgres) {
    await pgPool.query(
      'DELETE FROM mail_time_queue WHERE prefix = $1',
      [mailQueues.PostgresPostgres.queue.prefix]
    ).catch(() => {});
  }
});

after(async function () {
  this.timeout(10000);

  for (const mq of Object.values(mailQueues)) {
    if (typeof mq.destroy === 'function') {
      mq.destroy();
    }
    if (typeof mq.drain === 'function') {
      await mq.drain().catch(() => {});
    }
  }
  for (const fn of cleanupFns.reverse()) {
    await fn().catch(() => {});
  }
});

describe('Has MailTime Object', () => {
  it('MailTime is Constructor', () => {
    assert.isFunction(MailTime, 'MailTime is Constructor');
    assert.equal(typeof MailTime.Template === 'string', true, 'mailQueue has Template');
  });

  // NOTE: mutates a module-level static; restored in this test. Other Template
  // tests can't run in parallel with this one.
  it('Change MailTime.Template', () => {
    const orig = MailTime.Template;
    assert.equal(MailTime.Template === '{{{html}}}', false, 'Template has original value');
    MailTime.Template = '{{{html}}}';
    assert.equal(MailTime.Template === '{{{html}}}', true, 'Template has new value');
    MailTime.Template = orig;
  });
});

const runTests = (label, concat) => {
  describe(label, function () {
    this.slow(5000);
    this.timeout(30000);

    it('exposes MailTime properties', () => {
      const mailQueue = mailQueues[label];
      assert.instanceOf(mailQueue, MailTime, 'is MailTime');
      assert.equal(mailQueue.type, 'server');
      assert.equal(mailQueue.maxTries, 2);
      assert.equal(mailQueue.retryDelay, 100);
      assert.equal(mailQueue.concatEmails, concat);
      assert.equal(mailQueue.scheduler.zombieTime, 60000);
      assert.equal(mailQueue.scheduler.minRevolvingDelay, 512);
      assert.equal(mailQueue.scheduler.maxRevolvingDelay, 2048);
    });

    it('ping returns OK', async () => {
      const r = await mailQueues[label].ping();
      assert.equal(r.status, 'OK');
    });

    it('sends, then cancels a future-dated mail', async () => {
      const mailQueue = mailQueues[label];
      const uuid = await mailQueue.sendMail({
        sendAt: Date.now() + 60000,
        to: `cancel-${label}@${domain}`,
        subject: 'hi',
        text: 'plain',
        html: '<p>plain</p>',
      });
      assert.isString(uuid);

      const cancelled = await mailQueue.cancelMail(uuid);
      assert.isTrue(cancelled);

      const docs = await introspect(mailQueue);
      assert.equal(
        findByMailTo(docs, `cancel-${label}@${domain}`).length,
        0,
        'row removed after cancel (no keepHistory)'
      );
    });

    it('respects concatEmails setting', async () => {
      const mailQueue = mailQueues[label];
      const address = `concat-${label}@${domain}`;

      await mailQueue.sendMail({
        sendAt: Date.now() + 60000,
        to: address,
        subject: 'First',
        text: 'First',
        html: '<p>First</p>',
      });
      await mailQueue.sendMail({
        sendAt: Date.now() + 60000,
        to: address,
        subject: 'Second',
        text: 'Second',
        html: '<p>Second</p>',
      });

      const matches = await waitUntil(async () => {
        const docs = await introspect(mailQueue);
        const found = findByMailTo(docs, address);
        if (concat) {
          return (found.length === 1 && found[0].mailOptions.length === 2) ? found : null;
        }
        return found.length === 2 ? found : null;
      }, { label: `concat:${label}` });

      if (concat) {
        assert.equal(matches.length, 1, 'folded into one letter');
        assert.equal(matches[0].mailOptions.length, 2, 'task carries both mailOptions entries');
      } else {
        assert.equal(matches.length, 2, 'kept as two letters');
      }
    });

    it('iterates and sends a due email end-to-end', async () => {
      const mailQueue = mailQueues[label];
      const address = `e2e-${label}@${domain}`;
      // concatEmails adds concatDelay (default 60s) to sendAt; back-date enough
      // that the effective sendAt is still due regardless of mode.
      const uuid = await mailQueue.sendMail({
        sendAt: Date.now() - 90000,
        to: address,
        subject: 'go',
        text: 'now',
        html: '<p>now</p>',
      });

      await waitUntil(() => sentByUuid.has(uuid) || null, { label: `sent:${label}` });

      const docs = await introspect(mailQueue);
      assert.equal(findByMailTo(docs, address).length, 0, 'row removed after successful send');
    });

    it('reclaims a stale isSending lock and delivers', async () => {
      const mailQueue = mailQueues[label];
      const address = `stale-${label}@${domain}`;
      const taskUuid = randomUUID();

      // Forge a row that looks like a previous worker grabbed the claim and
      // then crashed. `sendingAt` is well past the 5-minute sendingTimeout, so
      // the next iterate must re-claim it.
      await mailQueue.queue.push({
        uuid: taskUuid,
        tries: 0,
        sendAt: Date.now() - 1000,
        isSent: false,
        isCancelled: false,
        isFailed: false,
        isSending: true,
        sendingAt: Date.now() - 10 * 60 * 1000,
        template: false,
        transport: 0,
        concatSubject: false,
        mailOptions: [{
          to: address,
          subject: 'stuck',
          text: 'stuck',
          html: '<p>stuck</p>',
        }],
      });

      await waitUntil(() => sentByUuid.has(taskUuid) || null, { label: `stale:${label}` });

      const docs = await introspect(mailQueue);
      assert.equal(findByMailTo(docs, address).length, 0, 'stale row removed after reclaim+send');
    });

    it('atomic claim guard rejects repeat claim with stale tries', async () => {
      const mailQueue = mailQueues[label];
      const address = `claim-${label}@${domain}`;
      const uuid = await mailQueue.sendMail({
        sendAt: Date.now() + 60000,
        to: address,
        subject: 'lock',
        text: 'lock',
        html: '<p>lock</p>',
      });

      const task = await waitUntil(async () => {
        const docs = await introspect(mailQueue);
        return docs.find((d) => d.uuid === uuid) || null;
      }, { label: `pushed:${label}` });

      const now = Date.now();
      const claimUpdate = { isSending: true, sendingAt: now, tries: (task.tries || 0) + 1 };

      const r1 = await mailQueue.queue.update(task, claimUpdate);
      assert.isTrue(r1, 'first claim wins');

      // Second call uses the SAME stale `task` snapshot — guard must reject.
      const r2 = await mailQueue.queue.update(task, claimUpdate);
      assert.isFalse(r2, 'second claim with stale tries is rejected');

      await mailQueue.cancelMail(uuid);
    });

    it('partial delivery exhausts retries and reports rejected recipients', async () => {
      const mailQueue = mailQueues[label];
      const good = `partial-good-${label}@${domain}`;
      const bad = `partial-bad-${label}@nope.invalid`;
      const uuid = await mailQueue.sendMail({
        sendAt: Date.now() - 90000,
        to: [good, bad],
        subject: 'partial',
        text: 'partial',
        html: '<p>partial</p>',
      });

      const entry = await waitUntil(() => errorByUuid.get(uuid) || null, { label: `partial:${label}` });
      const failedTask = entry.task;
      // extractEmail (helpers.js) lowercases every parsed address, so
      // mo.accepted / mo.rejected[*].address are always lowercase regardless
      // of the casing the caller passed to sendMail. Compare in lowercase.
      const lower = (a) => typeof a === 'string' ? a.toLowerCase() : a;
      const rejectedAddrs = (failedTask.mailOptions || []).flatMap((mo) =>
        (mo.rejected || []).map((r) => lower(r.address))
      );
      assert.include(
        rejectedAddrs,
        bad.toLowerCase(),
        `bad recipient flagged rejected; got rejected=${JSON.stringify(rejectedAddrs)}`
      );

      const acceptedAddrs = (failedTask.mailOptions || []).flatMap((mo) => (mo.accepted || []).map(lower));
      assert.include(
        acceptedAddrs,
        good.toLowerCase(),
        `good recipient recorded as accepted; got accepted=${JSON.stringify(acceptedAddrs)}`
      );

      const docs = await introspect(mailQueue);
      assert.equal(findByMailTo(docs, good).length, 0, 'row removed after maxTries exhausted');
    });
  });
};

runTests('MongoRedis', true);
runTests('MongoMongo', false);
runTests('RedisMongo', false);
runTests('RedisRedis', true);
if (HAS_PG) {
  runTests('PostgresPostgres', false);
}

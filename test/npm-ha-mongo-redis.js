import { MailTime, MongoQueue } from '../index.js';
import { MongoClient } from 'mongodb';
import { createClient } from 'redis';
import { randomUUID } from 'node:crypto';
import { assert } from 'chai';
import { it, describe, before, after } from 'mocha';

if (!process.env.MONGO_URL) {
  throw new Error('MONGO_URL env.var is not defined');
}
if (!process.env.REDIS_URL) {
  throw new Error('REDIS_URL env.var is not defined');
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const waitUntil = async (fn, { timeout = 12000, interval = 64 } = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const value = await fn();
    if (value) {
      return value;
    }
    await wait(interval);
  }
  return fn();
};

const mongoAddr = process.env.MONGO_URL || '';
const dbName = mongoAddr.split('/').pop().replace(/\/$/, '');
const domain = process.env.EMAIL_DOMAIN || 'example.com';
const TEST_TITLE = `mail-time-ha-${Date.now()}`;

const createTransport = () => ({
  options: { from: `no-reply@${domain}` },
  sendMail(mail, done) {
    const to = Array.isArray(mail.to) ? mail.to[0] : mail.to;
    done(null, { accepted: [to], rejected: [], response: 'OK' });
  },
});

let db;
let mongoClient;
let redisClient;
const sentByUuid = new Map();
const haPrefix = `${TEST_TITLE}-ha`;
let primary;
let standby;

before(async function () {
  this.timeout(20000);

  redisClient = await createClient({ url: process.env.REDIS_URL }).connect();
  mongoClient = await MongoClient.connect(mongoAddr);
  db = mongoClient.db(dbName);

  const sharedQueueOpts = { db, prefix: haPrefix };
  const fastJosk = {
    adapter: { client: redisClient, type: 'redis' },
    minRevolvingDelay: 128,
    maxRevolvingDelay: 256,
    zombieTime: 60000,
  };
  const transport = createTransport();
  const onSent = (task) => {
    sentByUuid.set(task.uuid, true);
  };

  primary = new MailTime({
    queue: new MongoQueue(sharedQueueOpts),
    transports: [transport],
    prefix: haPrefix,
    type: 'server',
    retries: 0,
    revolvingInterval: 256,
    josk: { ...fastJosk, lockOwnerId: `${TEST_TITLE}-primary` },
    onSent,
  });

  standby = new MailTime({
    queue: new MongoQueue(sharedQueueOpts),
    transports: [transport],
    prefix: haPrefix,
    type: 'server',
    retries: 0,
    revolvingInterval: 256,
    josk: { ...fastJosk, lockOwnerId: `${TEST_TITLE}-standby` },
    onSent,
  });

  await primary.ready();
  await standby.ready();
  await primary.queue.collection.deleteMany({});
});

after(async function () {
  this.timeout(10000);
  primary?.destroy();
  standby?.destroy();
  await redisClient?.quit();
  await mongoClient?.close();
});

describe('HA — Mongo queue + Redis JoSk', function () {
  this.slow(1000);
  this.timeout(15000);

  it('reclaims a stale isSending lock and delivers', async () => {
    const address = `stale-ha@${domain}`;
    const taskUuid = randomUUID();

    await primary.queue.push({
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

    await waitUntil(() => sentByUuid.has(taskUuid));
    const remaining = await primary.queue.collection.find({ uuid: taskUuid }).toArray();
    assert.equal(remaining.length, 0, 'stale row removed after reclaim+send');
  });

  it('standby drains after primary destroy (JoSk lease failover)', async () => {
    const address = `failover-ha@${domain}`;
    const uuid = await primary.sendMail({
      to: address,
      subject: 'failover',
      text: 'failover',
      html: '<p>failover</p>',
    });

    primary.destroy();

    await waitUntil(() => sentByUuid.has(uuid));
    const remaining = await standby.queue.collection.find({ uuid }).toArray();
    assert.equal(remaining.length, 0, 'standby removed row after send');
  });
});

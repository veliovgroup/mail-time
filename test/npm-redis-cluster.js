import { MailTime, RedisQueue } from '../index.js';
import { createCluster } from 'redis';
import { assert } from 'chai';
import { after, before, describe, it } from 'mocha';
import { execFile } from 'child_process';
import { promisify } from 'util';

const clusterUrl = process.env.REDIS_CLUSTER_URL;
const sourceUrl = process.env.REDIS_URL;
const clusterDescribe = clusterUrl ? describe : describe.skip;
const execFileAsync = promisify(execFile);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitUntil = async (fn, { timeout = 5000, interval = 32 } = {}) => {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeout) {
    const value = await fn();
    if (value) {
      return value;
    }
    await wait(interval);
  }
  return await fn();
};

const transport = (sent) => ({
  options: { from: 'no-reply@example.com' },
  sendMail(mail, done) {
    sent.push(mail);
    done(null, {
      accepted: [mail.to],
      rejected: [],
      response: 'OK',
    });
  },
});

clusterDescribe('Redis Cluster queue', function () {
  this.timeout(15000);

  const prefix = `mailtime-cluster-${Date.now()}`;
  const sent = [];
  let cluster;
  let client;
  let serverA;
  let serverB;

  before(async () => {
    cluster = createCluster({ rootNodes: [{ url: clusterUrl }] });
    await cluster.connect();
    const shared = {
      client: cluster,
      prefix,
      useHashTags: true,
    };
    client = new MailTime({
      type: 'client',
      prefix,
      queue: new RedisQueue(shared),
    });
    const serverOptions = {
      type: 'server',
      prefix,
      queue: new RedisQueue(shared),
      transports: [transport(sent)],
      verifyTransports: false,
      revolvingInterval: 32,
      josk: {
        minRevolvingDelay: 16,
        maxRevolvingDelay: 32,
        adapter: {
          type: 'redis',
          client: cluster,
          useHashTags: true,
        },
      },
    };
    serverA = new MailTime(serverOptions);
    serverB = new MailTime({
      ...serverOptions,
      queue: new RedisQueue(shared),
      josk: {
        ...serverOptions.josk,
        lockOwnerId: `${prefix}-b`,
        adapter: { ...serverOptions.josk.adapter },
      },
    });
    await Promise.all([client.ready(), serverA.ready(), serverB.ready()]);
  });

  after(async () => {
    await Promise.all([serverA?.destroy({ drain: true }), serverB?.destroy({ drain: true })]);
    await cluster?.close();
  });

  it('delivers once when two servers claim a tagged queue concurrently', async () => {
    await client.sendMail({ to: 'cluster@example.com', subject: 'Cluster', text: 'one' });
    await Promise.all([serverA.___iterate(), serverB.___iterate()]);
    await Promise.all([serverA.drain(), serverB.drain()]);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].to, 'cluster@example.com');
    assert.equal(typeof cluster.watch, 'undefined');
    assert.equal(typeof cluster.scanIterator, 'undefined');
  });

  it('reschedules retries, cancels queued mail, and recovers stale claims', async () => {
    const delayed = await client.sendMail({
      to: 'later@example.com',
      subject: 'Later',
      text: 'delayed',
      sendAt: Date.now() + 120,
    });
    const cancelled = await client.sendMail({ to: 'cancel@example.com', subject: 'Cancel', text: 'cancel' });
    assert.equal(await client.cancelMail(cancelled), true);

    await waitUntil(async () => {
      await serverA.___iterate();
      await serverA.drain();
      return sent.some((mail) => mail.to === 'later@example.com');
    });
    assert.equal(sent.filter((mail) => mail.to === 'later@example.com').length, 1);
    assert.equal(sent.some((mail) => mail.to === 'cancel@example.com'), false);

    const queue = serverA.queue;
    const stale = {
      uuid: 'stale-claim',
      to: 'stale@example.com',
      tries: 0,
      sendAt: Date.now() - 1,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: true,
      sendingAt: Date.now() - serverA.sendingTimeout - 1,
      transport: 0,
      mailOptions: [{ to: 'stale@example.com', subject: 'Stale', text: 'recovered' }],
    };
    await queue.push(stale);
    await serverA.___iterate();
    await serverA.drain();
    assert.equal(sent.filter((mail) => mail.to === 'stale@example.com').length, 1);
    assert.equal(await cluster.hExists(queue.lettersKey, delayed), false);
  });

  it('atomically folds concatenated mail through tagged Lua state', async () => {
    const concatClient = new MailTime({
      type: 'client',
      prefix,
      concatEmails: true,
      concatDelay: 1000,
      queue: new RedisQueue({ client: cluster, prefix, useHashTags: true }),
    });
    await concatClient.ready();
    try {
      const first = await concatClient.sendMail({ to: 'concat@example.com', subject: 'First', text: 'one' });
      const second = await concatClient.sendMail({ to: 'concat@example.com', subject: 'Second', text: 'two' });
      assert.equal(second, first);
      await wait(1020);
      await serverA.___iterate();
      await serverA.drain();
      assert.equal(sent.filter((mail) => mail.to === 'concat@example.com').length, 1);
    } finally {
      concatClient.destroy();
    }
  });

  it('keeps newer concat pointers when removing an older task', async () => {
    const queue = serverA.queue;
    const first = {
      uuid: 'concat-old',
      to: 'pointer@example.com',
      tries: 0,
      sendAt: Date.now() + 2000,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0,
      mailOptions: [],
    };
    const second = { ...first, uuid: 'concat-new' };
    await queue.push(first);
    await queue.push(second);
    assert.equal(await queue.remove(first), true);
    assert.equal(await cluster.get(`${queue.uniqueName}:concatletter:${first.to}`), second.uuid);
  });

  it('removes expired concat pointers from tagged cleanup index', async () => {
    const queue = serverA.queue;
    const task = {
      uuid: 'concat-expired',
      to: 'expired-pointer@example.com',
      tries: 0,
      sendAt: Date.now() + 500,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0,
      mailOptions: [],
    };
    const pointerKey = `${queue.uniqueName}:concatletter:${task.to}`;
    await queue.push(task);
    await wait(400);
    assert.equal(await queue.remove(task), true);
    assert.equal(await cluster.zScore(queue.concatKeysKey, pointerKey), null);
  });

  it('removes tagged concat pointer index on terminal history updates', async () => {
    const queue = serverA.queue;
    const task = {
      uuid: 'concat-terminal',
      to: 'terminal-pointer@example.com',
      tries: 0,
      sendAt: Date.now() + 5000,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0,
      mailOptions: [],
    };
    const pointerKey = `${queue.uniqueName}:concatletter:${task.to}`;
    await queue.push(task);
    assert.equal(await queue.update(task, { isSent: true }), true);
    assert.equal(await cluster.get(pointerKey), null);
    assert.equal(await cluster.zScore(queue.concatKeysKey, pointerKey), null);
  });

  it('migrates standalone queue data into tagged Cluster keys', async function () {
    if (!sourceUrl) {
      this.skip();
    }
    const migrationPrefix = `${prefix}-migration`;
    const source = await (await import('redis')).createClient({ url: sourceUrl }).connect();
    const task = {
      uuid: 'migrated-task',
      to: 'migrate@example.com',
      tries: 0,
      sendAt: Date.now() + 60000,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0,
      mailOptions: [{ to: 'migrate@example.com', subject: 'Migrate', text: 'preserved' }],
    };
    try {
      await source.set(`mailtime:${migrationPrefix}:letter:${task.uuid}`, JSON.stringify(task));
      await source.set(`mailtime:${migrationPrefix}:sendat:${task.uuid}`, `${task.sendAt}`);
      await source.set(`mailtime:${migrationPrefix}:concatletter:${task.to}`, task.uuid, { PX: 30000 });
      const tagged = `mailtime:{${migrationPrefix}}`;
      await cluster.hSet(`${tagged}:letters`, 'old-task', JSON.stringify(task));
      await cluster.zAdd(`${tagged}:schedule`, { score: task.sendAt, value: 'old-task' });
      await cluster.set(`${tagged}:concatletter:orphan@example.com`, 'orphan');
      await cluster.zAdd(`${tagged}:concatkeys`, {
        score: Date.now() + 30000,
        value: `${tagged}:concatletter:orphan@example.com`,
      });
      await execFileAsync(process.execPath, [
        'scripts/migrate-redis-queue-to-cluster.mjs',
        '--source', sourceUrl,
        '--target', clusterUrl,
        '--prefix', migrationPrefix,
        '--overwrite',
      ], { cwd: process.cwd() });
    } finally {
      await source.close();
    }

    const tagged = `mailtime:{${migrationPrefix}}`;
    assert.deepEqual(JSON.parse(await cluster.hGet(`${tagged}:letters`, task.uuid)), task);
    assert.equal(await cluster.zScore(`${tagged}:schedule`, task.uuid), task.sendAt);
    assert.equal(await cluster.get(`${tagged}:concatletter:${task.to}`), task.uuid);
    assert.equal(await cluster.get(`${tagged}:concatletter:orphan@example.com`), null);
  });
});

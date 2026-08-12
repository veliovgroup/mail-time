import { createClient, createCluster } from 'redis';

const args = process.argv.slice(2);
const readArg = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? void 0 : args[index + 1];
};
const sourceUrl = readArg('--source');
const targetUrl = readArg('--target');
const prefix = readArg('--prefix');
const sendingTimeout = Number(readArg('--sending-timeout') || 300000);
const overwrite = args.includes('--overwrite');

if (!sourceUrl || !targetUrl || !prefix || !Number.isFinite(sendingTimeout) || sendingTimeout <= 0) {
  throw new Error('Usage: node scripts/migrate-redis-queue-to-cluster.mjs --source <redis-url> --target <cluster-url> --prefix <prefix> [--sending-timeout <ms>] [--overwrite]');
}

if (!/^[A-Za-z0-9_\-:.]+$/.test(prefix)) {
  throw new Error(`{prefix} must match /^[A-Za-z0-9_\\-:.]+$/ (received: "${prefix}")`);
}

const legacyName = `mailtime:${prefix}`;
const taggedName = `mailtime:{${prefix}}`;
const lettersKey = `${taggedName}:letters`;
const scheduleKey = `${taggedName}:schedule`;
const concatKeysKey = `${taggedName}:concatkeys`;
const source = await createClient({ url: sourceUrl }).connect();
const target = createCluster({ rootNodes: [{ url: targetUrl }] });

const scan = async function * (client, pattern) {
  for await (const batch of client.scanIterator({ TYPE: 'string', MATCH: pattern, COUNT: 9999 })) {
    for (const key of (Array.isArray(batch) ? batch : [batch])) {
      yield key;
    }
  }
};

const nextEligibleAt = (task) => {
  if (task.isSent === true || task.isFailed === true || task.isCancelled === true) {
    return null;
  }
  if (task.isSending === true) {
    return (typeof task.sendingAt === 'number' ? task.sendingAt : 0) + sendingTimeout;
  }
  return +task.sendAt;
};

try {
  await target.connect();
  const trackedConcatKeys = await target.zRange(concatKeysKey, 0, -1);
  for (const key of trackedConcatKeys) {
    if (await target.pTTL(key) === -2) {
      await target.zRem(concatKeysKey, key);
    }
  }
  const targetHasData = (await target.hLen(lettersKey)) > 0
    || (await target.zCard(scheduleKey)) > 0
    || (await target.zCard(concatKeysKey)) > 0;
  if (targetHasData && !overwrite) {
    throw new Error(`Target queue "${taggedName}" is not empty. Pass --overwrite only after verifying its contents can be replaced.`);
  }
  if (targetHasData) {
    const concatKeys = await target.zRange(concatKeysKey, 0, -1);
    if (concatKeys.length) {
      await target.del(concatKeys);
    }
    await target.del([lettersKey, scheduleKey, concatKeysKey]);
  }

  let migrated = 0;
  for await (const key of scan(source, `${legacyName}:letter:*`)) {
    const payload = await source.get(key);
    if (!payload) {
      continue;
    }
    const task = JSON.parse(payload);
    if (!task || typeof task.uuid !== 'string') {
      continue;
    }
    await target.hSet(lettersKey, task.uuid, payload);
    const eligibleAt = nextEligibleAt(task);
    if (eligibleAt !== null && Number.isFinite(eligibleAt)) {
      await target.zAdd(scheduleKey, { score: eligibleAt, value: task.uuid });
    }
    migrated++;
  }

  for await (const key of scan(source, `${legacyName}:concatletter:*`)) {
    const uuid = await source.get(key);
    if (!uuid) {
      continue;
    }
    const ttl = await source.pTTL(key);
    const to = key.slice(`${legacyName}:concatletter:`.length);
    const targetKey = `${taggedName}:concatletter:${to}`;
    if (ttl > 0) {
      await target.set(targetKey, uuid, { PX: ttl });
      await target.zAdd(concatKeysKey, { score: Date.now() + ttl, value: targetKey });
    } else if (ttl === -1) {
      await target.set(targetKey, uuid);
      await target.zAdd(concatKeysKey, { score: Number.MAX_SAFE_INTEGER, value: targetKey });
    }
  }

  console.info(`Migrated ${migrated} RedisQueue tasks from "${legacyName}" to "${taggedName}".`);
} finally {
  await Promise.all([source.close(), target.close()]);
}

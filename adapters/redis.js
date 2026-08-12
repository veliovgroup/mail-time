import {
  debug,
  logError,
  isSendClaimUpdate,
  isSendLeaseGuardedUpdate,
  isAppendMailOptionUpdate,
  stripInternalUpdateMeta,
  isSendLeaseRemove,
} from '../helpers.js';
import { createHash } from 'crypto';

/**
 * @typedef {object} RedisClient
 * @property {(key: string) => Promise<number>} exists
 * @property {(key: string) => Promise<string|null>} get
 * @property {(key: string, value: string, options?: object) => Promise<unknown>} set
 * @property {(key: string|string[]) => Promise<number>} del
 * @property {() => Promise<string>} ping
 * @property {(options: object) => AsyncIterable<string|string[]>} [scanIterator]
 * @property {(key: string, field: string) => Promise<string|null>} [hGet]
 * @property {(script: string, options: { keys: string[], arguments: string[] }) => Promise<unknown>} [eval]
 * @property {(sha: string, options: { keys: string[], arguments: string[] }) => Promise<unknown>} [evalSha]
 * @property {(script: string) => Promise<string>} [scriptLoad]
 * @property {(key: string) => Promise<unknown>} [watch]
 * @property {() => Promise<unknown>} [unwatch]
 * @property {() => object} [multi]
 */

/**
 * @typedef {object} RedisQueueOption
 * @property {RedisClient} client
 * @property {string} [prefix]
 * @property {boolean} [useHashTags] - Use Redis Cluster hash-tag keys (`mailtime:{prefix}:*`). Default keeps existing standalone keys.
 */

const KEY_TYPES = new Set(['letter', 'sendat', 'concatletter']);
const DEFAULT_PREFIX = 'default';
const VALID_PREFIX = /^[A-Za-z0-9_\-:.]+$/;
const TAGGED_ITERATE_LIMIT = 100;

const PUSH_TAGGED_TASK_SCRIPT = `
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[2])
  redis.call('ZADD', KEYS[2], tonumber(ARGV[3]), ARGV[1])
  if #KEYS > 3 then
    redis.call('SET', KEYS[3], ARGV[1], 'PXAT', tonumber(ARGV[4]))
    redis.call('ZADD', KEYS[4], tonumber(ARGV[4]), KEYS[3])
  end
  return 1
`;

const ITERATE_TAGGED_TASKS_SCRIPT = `
  local now = tonumber(ARGV[1])
  local maxTries = tonumber(ARGV[2])
  local sendingTimeout = tonumber(ARGV[3])
  local limit = tonumber(ARGV[4])
  local scanLimit = tonumber(ARGV[5])
  local tasks = {}
  if #KEYS > 2 then
    local expiredPointers = redis.call('ZRANGEBYSCORE', KEYS[3], '-inf', now, 'LIMIT', 0, 100)
    for _, pointerKey in ipairs(expiredPointers) do
      redis.call('DEL', pointerKey)
      redis.call('ZREM', KEYS[3], pointerKey)
    end
  end
  local due = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now, 'LIMIT', 0, scanLimit)
  for _, uuid in ipairs(due) do
    local payload = redis.call('HGET', KEYS[1], uuid)
    if not payload then
      redis.call('ZREM', KEYS[2], uuid)
    else
      local task = cjson.decode(payload)
      if task.isSent or task.isFailed or task.isCancelled or tonumber(task.tries or 0) >= maxTries then
        redis.call('ZREM', KEYS[2], uuid)
      elseif task.isSending then
        local eligibleAt = tonumber(task.sendingAt or 0) + sendingTimeout
        if eligibleAt > now then
          redis.call('ZADD', KEYS[2], eligibleAt, uuid)
        else
          table.insert(tasks, task)
        end
      elseif tonumber(task.sendAt or 0) <= now then
        table.insert(tasks, task)
      else
        redis.call('ZADD', KEYS[2], tonumber(task.sendAt), uuid)
      end
      if #tasks >= limit then
        break
      end
    end
  end

  return cjson.encode(tasks)
`;

const UPDATE_TAGGED_TASK_SCRIPT = `
  local payload = redis.call('HGET', KEYS[1], ARGV[1])
  if not payload then
    redis.call('ZREM', KEYS[2], ARGV[1])
    return 0
  end

  local task = cjson.decode(payload)
  local update = cjson.decode(ARGV[2])
  local mode = ARGV[3]
  local now = tonumber(ARGV[4])
  local sendingTimeout = tonumber(ARGV[5])
  local expectedTries = tonumber(ARGV[6])
  local leaseSendingAt = tonumber(ARGV[7])

  if mode == 'claim' then
    if task.isSent or task.isFailed or task.isCancelled or tonumber(task.tries or 0) ~= expectedTries then
      return 0
    end
    if task.isSending and tonumber(task.sendingAt or 0) > now - sendingTimeout then
      return 0
    end
  elseif mode == 'lease' then
    if task.isCancelled or task.isFailed or not task.isSending
      or tonumber(task.tries or 0) ~= expectedTries
      or tonumber(task.sendingAt or 0) ~= leaseSendingAt then
      return 0
    end
  end

  for key, value in pairs(update) do
    task[key] = value
  end
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(task))

  if task.isSent or task.isFailed or task.isCancelled then
    redis.call('ZREM', KEYS[2], ARGV[1])
    if #KEYS > 3 then
      local concatUuid = redis.call('GET', KEYS[3])
      if concatUuid == ARGV[1] then
        redis.call('DEL', KEYS[3])
        redis.call('ZREM', KEYS[4], KEYS[3])
      elseif not concatUuid then
        redis.call('ZREM', KEYS[4], KEYS[3])
      end
    end
  elseif task.isSending then
    redis.call('ZADD', KEYS[2], tonumber(task.sendingAt or now) + sendingTimeout, ARGV[1])
  else
    redis.call('ZADD', KEYS[2], tonumber(task.sendAt), ARGV[1])
  end
  return 1
`;

const APPEND_TAGGED_MAIL_OPTION_SCRIPT = `
  local payload = redis.call('HGET', KEYS[1], ARGV[1])
  if not payload then
    return 0
  end
  local task = cjson.decode(payload)
  if task.isSending or task.isSent or task.isFailed or task.isCancelled then
    return 0
  end
  task.mailOptions = task.mailOptions or {}
  table.insert(task.mailOptions, cjson.decode(ARGV[2]))
  redis.call('HSET', KEYS[1], ARGV[1], cjson.encode(task))
  return 1
`;

const REMOVE_TAGGED_TASK_SCRIPT = `
  local payload = redis.call('HGET', KEYS[1], ARGV[1])
  if not payload then
    redis.call('ZREM', KEYS[2], ARGV[1])
    return 0
  end
  local task = cjson.decode(payload)
  if ARGV[2] == 'lease' and (task.isCancelled or task.isFailed or not task.isSending
    or tonumber(task.tries or 0) ~= tonumber(ARGV[3])
    or tonumber(task.sendingAt or 0) ~= tonumber(ARGV[4])) then
    return 0
  end
  redis.call('HDEL', KEYS[1], ARGV[1])
  redis.call('ZREM', KEYS[2], ARGV[1])
  if #KEYS > 3 then
    local concatUuid = redis.call('GET', KEYS[3])
    if concatUuid == ARGV[1] then
      redis.call('DEL', KEYS[3])
      redis.call('ZREM', KEYS[4], KEYS[3])
    elseif not concatUuid then
      redis.call('ZREM', KEYS[4], KEYS[3])
    end
  end
  return 1
`;

const sha1Hex = (string) => createHash('sha1').update(string).digest('hex');

const isNoScriptError = (error) => {
  return !!error && (error.code === 'NOSCRIPT' || (typeof error.message === 'string' && error.message.includes('NOSCRIPT')));
};

const canReleaseLease = (currentTask, updateObj) => {
  return currentTask
    && currentTask.tries === updateObj.leaseTries
    && currentTask.isSending === true
    && (typeof currentTask.sendingAt === 'number' ? currentTask.sendingAt : 0) === updateObj.leaseSendingAt
    && currentTask.isCancelled !== true
    && currentTask.isFailed !== true;
};

const canClaimTask = (currentTask, task, now, sendingTimeout) => {
  if (!currentTask) {
    return false;
  }
  if (currentTask.isSent === true || currentTask.isFailed === true || currentTask.isCancelled === true) {
    return false;
  }
  if (currentTask.tries !== task.tries) {
    return false;
  }
  if (currentTask.isSending === true) {
    const sendingAt = typeof currentTask.sendingAt === 'number' ? currentTask.sendingAt : 0;
    if (sendingAt > now - sendingTimeout) {
      return false;
    }
  }
  return true;
};

const isIterateCandidate = (candidate, now, sendingTimeout, maxTries) => {
  if (!candidate || typeof candidate !== 'object') {
    return false;
  }
  if (candidate.isSent === true || candidate.isFailed === true || candidate.isCancelled === true) {
    return false;
  }
  const tries = typeof candidate.tries === 'number' ? candidate.tries : 0;
  if (tries >= maxTries) {
    return false;
  }
  if (candidate.isSending === true) {
    const sendingAt = typeof candidate.sendingAt === 'number' ? candidate.sendingAt : 0;
    if (sendingAt > now - sendingTimeout) {
      return false;
    }
  }
  return true;
};

const parseUuidFromKey = (key, uniqueName) => {
  const prefix = `${uniqueName}:sendat:`;
  if (!key.startsWith(prefix)) {
    return null;
  }
  return key.slice(prefix.length);
};

/** Class representing Redis Queue for MailTime */
class RedisQueue {
  /**
   * Create a RedisQueue instance
   * @param {RedisQueueOption} opts - configuration object
   */
  constructor (opts) {
    this.name = 'redis-queue';
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('[mail-time] Configuration object must be passed into RedisQueue constructor');
    }

    if (!opts.client) {
      throw new Error('[mail-time] [RedisQueue] required {client} option is missing, e.g. returned from `redis.createClient()` or `redis.createCluster()` method');
    }

    if (opts.useHashTags !== undefined && typeof opts.useHashTags !== 'boolean') {
      throw new TypeError(`[mail-time] [RedisQueue] {useHashTags} option must be a boolean (received: ${typeof opts.useHashTags})`);
    }

    this.client = opts.client;
    this.useHashTags = opts.useHashTags === true;
    this.__scriptSources = {
      push: PUSH_TAGGED_TASK_SCRIPT,
      iterate: ITERATE_TAGGED_TASKS_SCRIPT,
      update: UPDATE_TAGGED_TASK_SCRIPT,
      append: APPEND_TAGGED_MAIL_OPTION_SCRIPT,
      remove: REMOVE_TAGGED_TASK_SCRIPT,
    };
    this.__scriptShas = Object.fromEntries(Object.entries(this.__scriptSources).map(([name, source]) => [name, sha1Hex(source)]));
    this.__loadedShas = new Set();
    if (typeof opts.prefix === 'string') {
      this.__applyPrefix(opts.prefix);
    }
  }

  /** @internal */
  __applyPrefix(prefix) {
    if (this.useHashTags && !VALID_PREFIX.test(prefix)) {
      throw new Error(`[mail-time] [RedisQueue] {prefix} option must match ${VALID_PREFIX} when {useHashTags} is true (received: "${prefix}")`);
    }
    this.prefix = prefix;
    this.uniqueName = this.useHashTags ? `mailtime:{${prefix}}` : `mailtime:${prefix}`;
    if (this.useHashTags) {
      this.lettersKey = `${this.uniqueName}:letters`;
      this.scheduleKey = `${this.uniqueName}:schedule`;
      this.concatKeysKey = `${this.uniqueName}:concatkeys`;
    }
  }

  /** @internal */
  __ensurePrefix() {
    if (typeof this.prefix !== 'string') {
      this.__applyPrefix(this.mailTimeInstance?.prefix || DEFAULT_PREFIX);
    }
  }

  /** @internal */
  __debug(...args) {
    debug(this.mailTimeInstance?.debug === true, `[${this.name}]`, ...args);
  }

  /** @internal */
  async __runScript(scriptKey, options) {
    const source = this.__scriptSources[scriptKey];
    const sha = this.__scriptShas[scriptKey];
    if (!source || !sha) {
      throw new Error(`[mail-time] [RedisQueue] unknown script "${scriptKey}"`);
    }

    if (this.__loadedShas.has(sha) && typeof this.client.evalSha === 'function') {
      try {
        return await this.client.evalSha(sha, options);
      } catch (error) {
        if (!isNoScriptError(error)) {
          throw error;
        }
        this.__loadedShas.delete(sha);
      }
    }

    if (typeof this.client.scriptLoad === 'function' && typeof this.client.evalSha === 'function') {
      try {
        await this.client.scriptLoad(source);
        this.__loadedShas.add(sha);
        return await this.client.evalSha(sha, options);
      } catch (error) {
        if (!isNoScriptError(error)) {
          this.__debug(`[script:${scriptKey}] scriptLoad failed; falling back to EVAL`, error);
        }
      }
    }

    if (typeof this.client.eval !== 'function') {
      throw new Error('[mail-time] [RedisQueue] Redis Cluster client must support EVAL');
    }
    return await this.client.eval(source, options);
  }

  /** @internal */
  __getTaggedConcatKey(to) {
    this.__ensurePrefix();
    return `${this.uniqueName}:concatletter:${to}`;
  }

  /**
   * @async
   * @memberOf RedisQueue
   * @name ready
   * @description Storage adapter has no async setup
   * @returns {Promise<void 0>}
   */
  async ready() {
    this.__ensurePrefix();
    this.__debug('[ready]');
    return void 0;
  }

  /**
   * @async
   * @memberOf RedisQueue
   * @name ping
   * @description Check connection to Storage
   * @returns {Promise<object>}
   */
  async ping() {
    this.__debug('[ping]');
    if (!this.mailTimeInstance) {
      return {
        status: 'Service Unavailable',
        code: 503,
        statusCode: 503,
        error: new Error('MailTime instance not yet assigned to {mailTimeInstance} of Queue Adapter context'),
      };
    }

    try {
      const ping = await this.client.ping();
      if (ping === 'PONG') {
        return {
          status: 'OK',
          code: 200,
          statusCode: 200,
        };
      }
    } catch (pingError) {
      return {
        status: 'Internal Server Error',
        code: 500,
        statusCode: 500,
        error: pingError,
      };
    }

    return {
      status: 'Service Unavailable',
      code: 503,
      statusCode: 503,
      error: new Error('Service Unavailable'),
    };
  }

  /**
   * @memberOf RedisQueue
   * @name iterate
   * @description iterate over queued tasks passing each to `mailTimeInstance.___dispatch` (the bounded send pool)
   * @param {{ limit?: number, sendingTimeout?: number }} [opts] - iteration options
   * @returns {Promise<void>}
   */
  async iterate(opts) {
    this.__debug('[iterate]', opts);
    try {
      const now = Date.now();
      const sendingTimeout = (opts && typeof opts.sendingTimeout === 'number' && opts.sendingTimeout > 0)
        ? opts.sendingTimeout
        : 300000;
      const limit = (opts && typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0)
        ? Math.floor(opts.limit)
        : 0;
      const maxTries = (this.mailTimeInstance && typeof this.mailTimeInstance.maxTries === 'number')
        ? this.mailTimeInstance.maxTries
        : 60;

      if (this.useHashTags) {
        this.__ensurePrefix();
        const dispatchLimit = Number.isFinite(limit) && limit > 0 ? Math.floor(limit) : TAGGED_ITERATE_LIMIT;
        const payload = await this.__runScript('iterate', {
          keys: [this.lettersKey, this.scheduleKey, this.concatKeysKey],
          arguments: [`${now}`, `${maxTries}`, `${sendingTimeout}`, `${dispatchLimit}`, `${Math.max(dispatchLimit * 20, 100)}`],
        });
        const candidates = payload ? JSON.parse(String(payload)) : [];
        if (!Array.isArray(candidates)) {
          return;
        }
        for (const candidate of candidates) {
          if (isIterateCandidate(candidate, now, sendingTimeout, maxTries)) {
            await this.mailTimeInstance.___dispatch(candidate);
          }
        }
        return;
      }
      let dispatched = 0;

      const matchPattern = this.__getKey('*', 'sendat');
      const cursor = this.client.scanIterator({
        TYPE: 'string',
        MATCH: matchPattern,
        COUNT: 9999,
      });

      outer:
      for await (const cursorValue of cursor) {
        const sendatKeys = Array.isArray(cursorValue) ? cursorValue : [cursorValue];
        for (const sendatKey of sendatKeys) {
          const raw = await this.client.get(sendatKey);
          if (raw === null || parseInt(raw, 10) > now) {
            continue;
          }
          const uuid = parseUuidFromKey(sendatKey, this.uniqueName);
          if (!uuid) {
            continue;
          }
          const taskJSON = await this.client.get(this.__getKey(uuid));
          if (!taskJSON) {
            continue;
          }
          const candidate = JSON.parse(taskJSON);
          if (!isIterateCandidate(candidate, now, sendingTimeout, maxTries)) {
            continue;
          }
          await this.mailTimeInstance.___dispatch(candidate);
          dispatched++;
          if (limit > 0 && dispatched >= limit) {
            break outer;
          }
        }
      }
    } catch (iterateError) {
      logError('[iterate] [for/await] [iterateError]', iterateError);
    }
  }

  /**
   * @async
   * @memberOf RedisQueue
   * @name getPendingTo
   * @description get queued task by `to` field (addressee)
   * @param to {string} - email address
   * @param sendAt {number} - timestamp
   * @returns {Promise<object|null>}
   */
  async getPendingTo(to, sendAt) {
    this.__debug('[getPendingTo]', to, sendAt);
    if (typeof to !== 'string' || typeof sendAt !== 'number') {
      return null;
    }

    const concatKey = this.useHashTags ? this.__getTaggedConcatKey(to) : this.__getKey(to, 'concatletter');
    const uuid = await this.client.get(concatKey);
    if (!uuid) {
      return null;
    }

    const taskJSON = this.useHashTags
      ? await this.client.hGet(this.lettersKey, uuid)
      : await this.client.get(this.__getKey(uuid, 'letter'));
    if (!taskJSON) {
      return null;
    }

    const task = JSON.parse(taskJSON);
    if (!task || task.isSent === true || task.isCancelled === true || task.isFailed === true || task.sendAt > sendAt || task.isSending === true || task.tries >= this.mailTimeInstance.maxTries) {
      return null;
    }

    return task;
  }

  /**
   * @async
   * @memberOf RedisQueue
   * @name push
   * @description push task to the queue/storage
   * @param task {object} - task's object
   * @returns {Promise<void 0>}
   */
  async push(task) {
    this.__debug('[push]', task?.uuid);
    if (!task || typeof task !== 'object') {
      return;
    }

    if (task.sendAt instanceof Date) {
      task.sendAt = +task.sendAt;
    }

    if (this.useHashTags) {
      this.__ensurePrefix();
      const keys = [this.lettersKey, this.scheduleKey];
      const args = [task.uuid, JSON.stringify(task), `${+task.sendAt}`];
      if (task.to) {
        keys.push(this.__getTaggedConcatKey(task.to));
        keys.push(this.concatKeysKey);
        args.push(`${task.sendAt - 128}`);
      }
      await this.__runScript('push', { keys, arguments: args });
      return;
    }

    const letterKey = this.__getKey(task.uuid, 'letter');
    const sendatKey = this.__getKey(task.uuid, 'sendat');
    const taskJSON = JSON.stringify(task);

    if (typeof this.client.multi === 'function') {
      const multi = this.client.multi();
      multi.set(letterKey, taskJSON);
      multi.set(sendatKey, `${task.sendAt}`);
      if (task.to) {
        multi.set(this.__getKey(task.to, 'concatletter'), task.uuid, {
          PXAT: task.sendAt - 128,
        });
      }
      await multi.exec();
      return;
    }

    await this.client.set(letterKey, taskJSON);
    await this.client.set(sendatKey, `${task.sendAt}`);
    if (task.to) {
      await this.client.set(this.__getKey(task.to, 'concatletter'), task.uuid, {
        PXAT: task.sendAt - 128,
      });
    }
  }

  /**
   * @async
   * @memberOf RedisQueue
   * @name cancel
   * @description cancel scheduled email
   * @param uuid {string} - email's uuid
   * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found, was sent, or was cancelled previously
   */
  async cancel(uuid) {
    this.__debug('[cancel]', uuid);
    if (typeof uuid !== 'string') {
      return false;
    }

    if (this.useHashTags) {
      this.__ensurePrefix();
    } else {
      await this.client.del(this.__getKey(uuid, 'sendat'));
    }
    const taskJSON = this.useHashTags
      ? await this.client.hGet(this.lettersKey, uuid)
      : await this.client.get(this.__getKey(uuid, 'letter'));
    if (!taskJSON) {
      return false;
    }

    const task = JSON.parse(taskJSON);
    if (!task || task.isSent === true || task.isCancelled === true) {
      return false;
    }

    if (!this.mailTimeInstance.keepHistory) {
      return await this.remove(task);
    }

    return await this.update(task, {
      isCancelled: true,
    });
  }

  /**
   * @async
   * @memberOf RedisQueue
   * @name remove
   * @description remove task from queue
   * @param task {object} - task's object
   * @param {{ leaseTries: number, leaseSendingAt: number }} [opts] - lease guard: only remove if this worker still holds the lease (tries + sendingAt match, row not cancelled/failed)
   * @returns {Promise<boolean>} returns `true` if removed or `false` if not found
   */
  async remove(task, opts) {
    this.__debug('[remove]', task?.uuid);
    if (!task || typeof task !== 'object' || typeof task.uuid !== 'string') {
      return false;
    }

    if (this.useHashTags) {
      this.__ensurePrefix();
      try {
        const keys = [this.lettersKey, this.scheduleKey];
        if (task.to) {
          keys.push(this.__getTaggedConcatKey(task.to));
          keys.push(this.concatKeysKey);
        }
        const result = await this.__runScript('remove', {
          keys,
          arguments: [
            task.uuid,
            isSendLeaseRemove(opts) ? 'lease' : 'plain',
            `${opts?.leaseTries || 0}`,
            `${opts?.leaseSendingAt || 0}`,
          ],
        });
        return Number(result) >= 1;
      } catch (opError) {
        logError('[remove] [tagged] [opError]', opError);
        return false;
      }
    }

    const letterKey = this.__getKey(task.uuid, 'letter');
    if (isSendLeaseRemove(opts)) {
      if (typeof this.client.watch !== 'function' || typeof this.client.multi !== 'function') {
        return false;
      }
      try {
        await this.client.watch(letterKey);
        const taskJSON = await this.client.get(letterKey);
        if (!taskJSON) {
          await this.client.unwatch?.();
          return false;
        }
        const currentTask = JSON.parse(taskJSON);
        if (currentTask.tries !== opts.leaseTries
          || currentTask.isSending !== true
          || (typeof currentTask.sendingAt === 'number' ? currentTask.sendingAt : 0) !== opts.leaseSendingAt
          || currentTask.isCancelled === true
          || currentTask.isFailed === true) {
          await this.client.unwatch?.();
          return false;
        }
        const keysToDelete = [letterKey, this.__getKey(task.uuid, 'sendat')];
        if (task.to) {
          keysToDelete.push(this.__getKey(task.to, 'concatletter'));
        }
        const multi = this.client.multi();
        for (const key of keysToDelete) {
          multi.del(key);
        }
        const result = await multi.exec();
        return result !== null;
      } catch (opError) {
        logError('[remove] [lease] [opError]', opError);
        return false;
      }
    }

    const exists = await this.client.exists(letterKey);
    if (!exists) {
      return false;
    }

    const keysToDelete = [letterKey, this.__getKey(task.uuid, 'sendat')];
    if (task.to) {
      keysToDelete.push(this.__getKey(task.to, 'concatletter'));
    }
    await this.client.del(keysToDelete);
    return true;
  }

  /**
   * @async
   * @memberOf RedisQueue
   * @name update
   * @description update task in queue
   * @param task {object} - task's object
   * @param updateObj {object} - fields with new values to update
   * @returns {Promise<boolean>} returns `true` if updated or `false` if not found or no changes was made
   */
  async update(task, updateObj) {
    this.__debug('[update]', task?.uuid);
    if (!task || typeof task !== 'object' || typeof task.uuid !== 'string' || !updateObj || typeof updateObj !== 'object') {
      return false;
    }

    const letterKey = this.__getKey(task.uuid, 'letter');
    const sendatKey = this.__getKey(task.uuid, 'sendat');
    const isClaim = isSendClaimUpdate(updateObj);
    const isAppend = isAppendMailOptionUpdate(updateObj);
    const isLeaseRelease = isSendLeaseGuardedUpdate(updateObj);
    const now = isClaim && typeof updateObj.sendingAt === 'number' ? updateObj.sendingAt : Date.now();
    const sendingTimeout = this.mailTimeInstance?.sendingTimeout || 300000;

    try {
      if (this.useHashTags) {
        if (isAppend) {
          const result = await this.__runScript('append', {
            keys: [this.lettersKey],
            arguments: [task.uuid, JSON.stringify(updateObj.appendMailOption)],
          });
          return Number(result) >= 1;
        }

        const mode = isClaim ? 'claim' : (isLeaseRelease ? 'lease' : 'plain');
        const keys = [this.lettersKey, this.scheduleKey];
        if (task.to) {
          keys.push(this.__getTaggedConcatKey(task.to));
          keys.push(this.concatKeysKey);
        }
        const result = await this.__runScript('update', {
          keys,
          arguments: [
            task.uuid,
            JSON.stringify(stripInternalUpdateMeta(updateObj)),
            mode,
            `${now}`,
            `${sendingTimeout}`,
            `${isClaim ? task.tries : (updateObj.leaseTries || 0)}`,
            `${updateObj.leaseSendingAt || 0}`,
          ],
        });
        return Number(result) >= 1;
      }

      if (isAppend) {
        if (typeof this.client.watch !== 'function' || typeof this.client.multi !== 'function') {
          if (!RedisQueue.__atomicAppendWarned) {
            RedisQueue.__atomicAppendWarned = true;
            logError('[update] Redis client without watch()/multi() — concat appendMailOption falls back to non-atomic read-modify-write; concurrent folds into the same row may lose letters');
          }
          const taskJSON = await this.client.get(letterKey);
          if (!taskJSON) {
            return false;
          }
          const currentTask = JSON.parse(taskJSON);
          if (currentTask.isSending === true || currentTask.isSent === true || currentTask.isFailed === true || currentTask.isCancelled === true) {
            return false;
          }
          currentTask.mailOptions = [...(currentTask.mailOptions || []), updateObj.appendMailOption];
          await this.client.set(letterKey, JSON.stringify(currentTask));
          return true;
        }

        await this.client.watch(letterKey);
        const taskJSON = await this.client.get(letterKey);
        if (!taskJSON) {
          await this.client.unwatch?.();
          return false;
        }
        const currentTask = JSON.parse(taskJSON);
        if (currentTask.isSending === true || currentTask.isSent === true || currentTask.isFailed === true || currentTask.isCancelled === true) {
          await this.client.unwatch?.();
          return false;
        }
        currentTask.mailOptions = [...(currentTask.mailOptions || []), updateObj.appendMailOption];
        const multi = this.client.multi();
        multi.set(letterKey, JSON.stringify(currentTask));
        const result = await multi.exec();
        return result !== null;
      }

      if ((isClaim || isLeaseRelease) && (typeof this.client.watch !== 'function' || typeof this.client.multi !== 'function')) {
        if (isClaim && !RedisQueue.__atomicClaimWarned) {
          RedisQueue.__atomicClaimWarned = true;
          logError('[update] Redis client must support watch() and multi() for atomic send claims');
        }
        return false;
      }

      if (isClaim || isLeaseRelease) {
        await this.client.watch(letterKey);
        const taskJSON = await this.client.get(letterKey);
        if (!taskJSON) {
          await this.client.unwatch?.();
          return false;
        }

        const currentTask = JSON.parse(taskJSON);
        if (isClaim && !canClaimTask(currentTask, task, now, sendingTimeout)) {
          await this.client.unwatch?.();
          return false;
        }
        if (isLeaseRelease && !canReleaseLease(currentTask, updateObj)) {
          await this.client.unwatch?.();
          return false;
        }

        const updatedTask = { ...currentTask, ...stripInternalUpdateMeta(updateObj) };
        const multi = this.client.multi();
        multi.set(letterKey, JSON.stringify(updatedTask));
        if (updatedTask.isSent === true || updatedTask.isFailed === true || updatedTask.isCancelled === true) {
          multi.del(sendatKey);
        } else if (updatedTask.sendAt) {
          multi.set(sendatKey, `${+updatedTask.sendAt}`);
        }

        const result = await multi.exec();
        return result !== null;
      }

      const taskJSON = await this.client.get(letterKey);
      if (!taskJSON) {
        return false;
      }

      const currentTask = JSON.parse(taskJSON);
      const updatedTask = { ...currentTask, ...stripInternalUpdateMeta(updateObj) };
      await this.client.set(letterKey, JSON.stringify(updatedTask));

      if (updatedTask.isSent === true || updatedTask.isFailed === true || updatedTask.isCancelled === true) {
        await this.client.del(sendatKey);
      } else if (updatedTask.sendAt) {
        await this.client.set(sendatKey, `${+updatedTask.sendAt}`);
      }
      return true;
    } catch (opError) {
      logError('[update] [try/catch] [opError]', opError);
      return false;
    }
  }

  /**
   * @internal
   * @memberOf RedisQueue
   * @name __getKey
   * @description helper to generate scoped key
   * @param uuid {string} - letter's uuid (or "to" address for `concatletter` keys)
   * @param type {string} - "letter" or "sendat" or "concatletter"
   * @returns {string} returns key used by Redis
   */
  __getKey(uuid, type = 'letter') {
    if (!KEY_TYPES.has(type)) {
      throw new Error(`[mail-time] [RedisQueue] [__getKey] unsupported key "${type}" passed into the second argument`);
    }
    this.__ensurePrefix();
    if (this.useHashTags) {
      if (type === 'letter') {
        return this.lettersKey;
      }
      if (type === 'sendat') {
        return this.scheduleKey;
      }
      return this.__getTaggedConcatKey(uuid);
    }
    return `${this.uniqueName}:${type}:${uuid}`;
  }
}

export { RedisQueue };

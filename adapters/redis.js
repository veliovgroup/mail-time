import { debug, logError } from '../helpers.js';

/**
 * @typedef {object} RedisClient
 * @property {(key: string) => Promise<number>} exists
 * @property {(key: string) => Promise<string|null>} get
 * @property {(key: string, value: string, options?: object) => Promise<unknown>} set
 * @property {(key: string|string[]) => Promise<number>} del
 * @property {() => Promise<string>} ping
 * @property {(options: object) => AsyncIterable<string|string[]>} scanIterator
 * @property {(key: string) => Promise<unknown>} [watch]
 * @property {() => Promise<unknown>} [unwatch]
 * @property {() => object} [multi]
 */

/**
 * @typedef {object} RedisQueueOption
 * @property {RedisClient} client
 * @property {string} [prefix]
 */

const KEY_TYPES = new Set(['letter', 'sendat', 'concatletter']);
const DEFAULT_PREFIX = 'default';

const isSendClaimUpdate = (updateObj) => {
  return updateObj.isSending === true && typeof updateObj.tries === 'number';
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

    this.client = opts.client;
    if (typeof opts.prefix === 'string') {
      this.__applyPrefix(opts.prefix);
    }
  }

  /** @internal */
  __applyPrefix(prefix) {
    this.prefix = prefix;
    this.uniqueName = `mailtime:${prefix}`;
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
          if (candidate.isSending === true) {
            const sendingAt = typeof candidate.sendingAt === 'number' ? candidate.sendingAt : 0;
            if (sendingAt > now - sendingTimeout) {
              continue;
            }
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

    const concatKey = this.__getKey(to, 'concatletter');
    const uuid = await this.client.get(concatKey);
    if (!uuid) {
      return null;
    }

    const letterKey = this.__getKey(uuid, 'letter');
    const taskJSON = await this.client.get(letterKey);
    if (!taskJSON) {
      return null;
    }

    const task = JSON.parse(taskJSON);
    if (!task || task.isSent === true || task.isCancelled === true || task.isFailed === true || task.sendAt > sendAt) {
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

    await this.client.del(this.__getKey(uuid, 'sendat'));
    const letterKey = this.__getKey(uuid, 'letter');
    const taskJSON = await this.client.get(letterKey);
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
   * @returns {Promise<boolean>} returns `true` if removed or `false` if not found
   */
  async remove(task) {
    this.__debug('[remove]', task?.uuid);
    if (!task || typeof task !== 'object' || typeof task.uuid !== 'string') {
      return false;
    }

    const letterKey = this.__getKey(task.uuid, 'letter');
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
    const now = isClaim && typeof updateObj.sendingAt === 'number' ? updateObj.sendingAt : Date.now();
    const sendingTimeout = this.mailTimeInstance?.sendingTimeout || 300000;

    try {
      if (isClaim && typeof this.client.watch === 'function' && typeof this.client.multi === 'function') {
        await this.client.watch(letterKey);
        const taskJSON = await this.client.get(letterKey);
        if (!taskJSON) {
          await this.client.unwatch?.();
          return false;
        }

        const currentTask = JSON.parse(taskJSON);
        if (!canClaimTask(currentTask, task, now, sendingTimeout)) {
          await this.client.unwatch?.();
          return false;
        }

        const updatedTask = { ...currentTask, ...updateObj };
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
      if (isClaim && !canClaimTask(currentTask, task, now, sendingTimeout)) {
        return false;
      }

      const updatedTask = { ...currentTask, ...updateObj };
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
    return `${this.uniqueName}:${type}:${uuid}`;
  }
}

export { RedisQueue };

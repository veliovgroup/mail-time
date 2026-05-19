'use strict';

const josk = require('josk');
const node_crypto = require('node:crypto');

const hasOwn = Object.prototype.hasOwnProperty;

const debug = (isDebug, ...args) => {
  if (isDebug) {
    console.info('[DEBUG] [mail-time]', `${new Date()}`, ...args);
  }
};

const logError = (...args) => {
  console.error('[ERROR] [mail-time]', `${new Date()}`, ...args);
};

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
};

/**
 * Minimal deep-merge sufficient for nodemailer-shaped mail options:
 * - plain objects merge key-by-key
 * - arrays concatenate
 * - other values (strings, numbers, Date, Buffer, streams, classes) replace
 * Source values override target values.
 */
const deepMerge = (target, source) => {
  if (!isPlainObject(source)) {
    return target;
  }

  const out = isPlainObject(target) ? { ...target } : {};

  for (const key of Object.keys(source)) {
    const sVal = source[key];
    const tVal = out[key];

    if (Array.isArray(sVal)) {
      out[key] = Array.isArray(tVal) ? tVal.concat(sVal) : sVal.slice();
    } else if (isPlainObject(sVal)) {
      out[key] = isPlainObject(tVal) ? deepMerge(tVal, sVal) : deepMerge({}, sVal);
    } else {
      out[key] = sVal;
    }
  }

  return out;
};

/**
 * Order-insensitive deep equality. Treats arrays as multisets and
 * objects as unordered maps. Designed for the small `mailOptions`
 * shape used by MailTime's email concatenation dedup.
 */
const equals = (a, b) => {
  if (a === b) {
    return true;
  }

  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }

  if (a instanceof Date && b instanceof Date) {
    return a.valueOf() === b.valueOf();
  }

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) {
      return false;
    }

    const matched = new Array(b.length).fill(false);
    for (let i = 0; i < a.length; i++) {
      let found = false;
      for (let j = 0; j < b.length; j++) {
        if (!matched[j] && equals(a[i], b[j])) {
          matched[j] = true;
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
    return true;
  }

  if (Array.isArray(b)) {
    return false;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i];
    if (!hasOwn.call(b, key) || !equals(a[key], b[key])) {
      return false;
    }
  }

  return true;
};

/**
 * Extract the email part of a nodemailer-shaped recipient entry.
 * Accepts `'a@x.com'`, `'Name <a@x.com>'`, or `{ name, address }`.
 * Returns the address lowercased, or `null` when none can be parsed.
 */
const extractEmail = (entry) => {
  if (!entry) {
    return null;
  }
  if (typeof entry === 'object' && typeof entry.address === 'string') {
    return entry.address.trim().toLowerCase();
  }
  if (typeof entry !== 'string') {
    return null;
  }
  const angled = entry.match(/<([^>]+)>/);
  return (angled ? angled[1] : entry).trim().toLowerCase();
};

/**
 * Normalize a `to`/`cc`/`bcc` field into a flat list of lowercase addresses.
 */
const toAddressList = (field) => {
  if (!field) {
    return [];
  }
  if (Array.isArray(field)) {
    const out = [];
    for (const entry of field) {
      const addr = extractEmail(entry);
      if (addr) {
        out.push(addr);
      }
    }
    return out;
  }
  const single = extractEmail(field);
  return single ? [single] : [];
};

/**
 * Remove entries whose extracted address is in `acceptedSet` from a
 * nodemailer `to`/`cc`/`bcc` field. Returns `void 0` when the filtered
 * array would be empty or the single string is dropped.
 */
const filterAddressField = (field, acceptedSet) => {
  if (!field || !(acceptedSet instanceof Set) || acceptedSet.size === 0) {
    return field;
  }
  if (Array.isArray(field)) {
    const filtered = [];
    for (const entry of field) {
      const addr = extractEmail(entry);
      if (!addr || !acceptedSet.has(addr)) {
        filtered.push(entry);
      }
    }
    return filtered.length ? filtered : void 0;
  }
  const addr = extractEmail(field);
  if (addr && acceptedSet.has(addr)) {
    return void 0;
  }
  return field;
};

const DEFAULT_PREFIX$2 = '';

const isSendClaimUpdate$2 = (updateObj) => {
  return updateObj.isSending === true && typeof updateObj.tries === 'number';
};

/**
 * @typedef {object} MongoCollection
 * @property {string} [collectionName]
 * @property {(keys: object, opts?: object) => Promise<unknown>} createIndex
 * @property {() => Promise<{ name: string, key: Record<string, unknown> }[]>} indexes
 * @property {(name: string) => Promise<unknown>} dropIndex
 * @property {(query: object, opts?: object) => unknown} find
 * @property {(query: object, opts?: object) => Promise<object|null>} findOne
 * @property {(doc: object) => Promise<unknown>} insertOne
 * @property {(query: object) => Promise<{ deletedCount?: number }>} deleteOne
 * @property {(query: object, update: object) => Promise<{ modifiedCount?: number }>} updateOne
 */

/**
 * @typedef {object} Db
 * @property {(name: string) => MongoCollection} collection
 * @property {(cmd: object) => Promise<{ ok?: number }>} command
 */

/**
 * @typedef {object} MongoQueueOption
 * @property {Db} db
 * @property {string} [prefix]
 */

/** @internal */
const ensureIndex = async (collection, keys, opts) => {
  try {
    await collection.createIndex(keys, opts);
  } catch (e) {
    if (e?.code === 85) {
      let indexName;
      const indexes = await collection.indexes();
      const keyNames = Object.keys(keys);
      for (const index of indexes) {
        const indexKeys = Object.keys(index.key);
        if (indexKeys.length !== keyNames.length) {
          continue;
        }
        let match = true;
        for (const k of keyNames) {
          if (typeof index.key[k] === 'undefined') {
            match = false;
            break;
          }
        }
        if (match) {
          indexName = index.name;
          break;
        }
      }

      if (indexName) {
        await collection.dropIndex(indexName);
        await collection.createIndex(keys, opts);
      }
    } else {
      logError(`[ensureIndex] Can not set ${Object.keys(keys).join(' + ')} index on "${collection?.collectionName || 'MongoDB'}" collection`, { keys, opts, details: e });
    }
  }
};

/** Class representing MongoDB Queue for MailTime */
class MongoQueue {
  /**
   * Create a MongoQueue instance
   * @param {MongoQueueOption} opts - configuration object
   */
  constructor (opts) {
    this.name = 'mongo-queue';
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('[mail-time] Configuration object must be passed into MongoQueue constructor');
    }

    if (!opts.db) {
      throw new Error('[mail-time] [MongoQueue] requires MongoDB database {db} option, like returned from `MongoClient#db()`');
    }

    this.db = opts.db;
    if (typeof opts.prefix === 'string') {
      this.__applyPrefix(opts.prefix);
    }
  }

  /** @internal */
  __applyPrefix(prefix) {
    this.prefix = prefix;
    this.collection = this.db.collection(`__mailTimeQueue__${prefix}`);
    this.__readyPromise = Promise.all([
      ensureIndex(this.collection, { uuid: 1 }, { background: false }),
      ensureIndex(this.collection, { isSent: 1, isFailed: 1, isCancelled: 1, to: 1, sendAt: 1 }, { background: false }),
      ensureIndex(this.collection, { isSent: 1, isFailed: 1, isCancelled: 1, isSending: 1, sendingAt: 1, sendAt: 1, tries: 1 }, { background: false }),
    ]).then(() => void 0);
  }

  /** @internal */
  __ensurePrefix() {
    if (typeof this.prefix !== 'string') {
      this.__applyPrefix(this.mailTimeInstance?.prefix || DEFAULT_PREFIX$2);
    }
  }

  /** @internal */
  __debug(...args) {
    debug(this.mailTimeInstance?.debug === true, `[${this.name}]`, ...args);
  }

  /**
   * @async
   * @memberOf MongoQueue
   * @name ready
   * @description Wait until indexes are created
   * @returns {Promise<void 0>}
   */
  async ready() {
    this.__ensurePrefix();
    this.__debug('[ready]');
    await this.__readyPromise;
  }

  /**
   * @async
   * @memberOf MongoQueue
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
      const ping = await this.db.command({ ping: 1 });
      if (ping?.ok === 1) {
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
   * @memberOf MongoQueue
   * @name iterate
   * @description iterate over queued tasks passing each to `mailTimeInstance.___dispatch` (the bounded send pool)
   * @param {{ limit?: number, sendingTimeout?: number }} [opts] - iteration options
   * @returns {Promise<void>}
   */
  async iterate(opts) {
    this.__debug('[iterate]', opts);
    this.__ensurePrefix();
    const now = Date.now();
    const sendingTimeout = (opts && typeof opts.sendingTimeout === 'number' && opts.sendingTimeout > 0)
      ? opts.sendingTimeout
      : 300000;
    const limit = (opts && typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0)
      ? Math.floor(opts.limit)
      : 0;

    try {
      const cursor = this.collection.find({
        isSent: false,
        isFailed: false,
        isCancelled: false,
        sendAt: {
          $lte: now,
        },
        tries: {
          $lt: this.mailTimeInstance.maxTries,
        },
        $or: [
          { isSending: { $ne: true } },
          { sendingAt: { $lte: now - sendingTimeout } },
        ],
      }, {
        projection: {
          _id: 1,
          uuid: 1,
          tries: 1,
          template: 1,
          transport: 1,
          isSent: 1,
          isFailed: 1,
          isCancelled: 1,
          isSending: 1,
          sendingAt: 1,
          mailOptions: 1,
          concatSubject: 1,
        },
      });

      if (limit > 0) {
        cursor.limit(limit);
      }

      while (await cursor.hasNext()) {
        await this.mailTimeInstance.___dispatch(await cursor.next());
      }
      await cursor.close();
    } catch (iterateError) {
      logError('[iterate] [while/await] [iterateError]', iterateError);
    }
  }

  /**
   * @async
   * @memberOf MongoQueue
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
    this.__ensurePrefix();

    return await this.collection.findOne({
      to,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      sendAt: {
        $lte: sendAt,
      },
    }, {
      projection: {
        _id: 1,
        to: 1,
        uuid: 1,
        tries: 1,
        isSent: 1,
        isFailed: 1,
        isCancelled: 1,
        mailOptions: 1,
      },
    });
  }

  /**
   * @async
   * @memberOf MongoQueue
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
    this.__ensurePrefix();

    if (task.sendAt instanceof Date) {
      task.sendAt = +task.sendAt;
    }
    await this.collection.insertOne(task);
  }

  /**
   * @async
   * @memberOf MongoQueue
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
    this.__ensurePrefix();

    const task = await this.collection.findOne({ uuid }, {
      projection: {
        _id: 1,
        uuid: 1,
        isSent: 1,
        isCancelled: 1,
      },
    });

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
   * @memberOf MongoQueue
   * @name remove
   * @description remove task from queue
   * @param task {object} - task's object
   * @returns {Promise<boolean>} returns `true` if removed or `false` if not found
   */
  async remove(task) {
    this.__debug('[remove]', task?.uuid);
    if (!task || typeof task !== 'object') {
      return false;
    }
    this.__ensurePrefix();

    const res = await this.collection.deleteOne({ _id: task._id });
    return (res?.deletedCount || 0) >= 1;
  }

  /**
   * @async
   * @memberOf MongoQueue
   * @name update
   * @description update task in queue
   * @param task {object} - task's object
   * @param updateObj {object} - fields with new values to update
   * @returns {Promise<boolean>} returns `true` if updated or `false` if not found or no changes was made
   */
  async update(task, updateObj) {
    this.__debug('[update]', task?.uuid);
    if (!task || typeof task !== 'object' || !updateObj || typeof updateObj !== 'object') {
      return false;
    }
    this.__ensurePrefix();

    const query = {
      _id: task._id,
    };

    if (isSendClaimUpdate$2(updateObj)) {
      const now = typeof updateObj.sendingAt === 'number' ? updateObj.sendingAt : Date.now();
      const sendingTimeout = this.mailTimeInstance?.sendingTimeout || 300000;
      query.isSent = false;
      query.isFailed = false;
      query.isCancelled = false;
      query.tries = task.tries;
      query.$or = [
        { isSending: { $ne: true } },
        { sendingAt: { $lte: now - sendingTimeout } },
      ];
    }

    const res = await this.collection.updateOne(query, {
      $set: updateObj,
    });
    return (res?.modifiedCount || 0) >= 1;
  }
}

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
const DEFAULT_PREFIX$1 = 'default';

const isSendClaimUpdate$1 = (updateObj) => {
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
      this.__applyPrefix(this.mailTimeInstance?.prefix || DEFAULT_PREFIX$1);
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
      const maxTries = (this.mailTimeInstance && typeof this.mailTimeInstance.maxTries === 'number')
        ? this.mailTimeInstance.maxTries
        : 60;
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
    const isClaim = isSendClaimUpdate$1(updateObj);
    const now = isClaim && typeof updateObj.sendingAt === 'number' ? updateObj.sendingAt : Date.now();
    const sendingTimeout = this.mailTimeInstance?.sendingTimeout || 300000;

    try {
      if (isClaim && (typeof this.client.watch !== 'function' || typeof this.client.multi !== 'function')) {
        if (!RedisQueue.__atomicClaimWarned) {
          RedisQueue.__atomicClaimWarned = true;
          logError('[update] Redis client must support watch() and multi() for atomic send claims');
        }
        return false;
      }

      if (isClaim) {
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

/**
 * @typedef {object} PostgresQueryResult
 * @property {number | null | undefined} [rowCount]
 * @property {unknown[]} [rows]
 */

/**
 * @typedef {object} PostgresClient
 * @property {(queryText: string, values?: unknown[]) => Promise<PostgresQueryResult>} query
 */

/**
 * @typedef {object} PostgresQueueOption
 * @property {PostgresClient} client
 * @property {string} [prefix]
 */

const DEFAULT_PREFIX = 'default';
const setupLockId = 93824519;

const fieldMap = {
  to: 'to_address',
  tries: 'tries',
  sendAt: 'send_at',
  isSent: 'is_sent',
  isCancelled: 'is_cancelled',
  isFailed: 'is_failed',
  isSending: 'is_sending',
  sendingAt: 'sending_at',
  template: 'template',
  transport: 'transport',
  concatSubject: 'concat_subject',
  mailOptions: 'mail_options',
};

const isSendClaimUpdate = (updateObj) => {
  return updateObj.isSending === true && typeof updateObj.tries === 'number';
};

const parseMailOptions = (mailOptions) => {
  if (typeof mailOptions === 'string') {
    return JSON.parse(mailOptions);
  }
  return mailOptions;
};

const normalizeRow = (row) => {
  if (!row) {
    return null;
  }

  return {
    id: row.id,
    uuid: row.uuid,
    to: row.to_address,
    tries: parseInt(row.tries, 10),
    sendAt: parseInt(row.send_at, 10),
    isSent: row.is_sent,
    isCancelled: row.is_cancelled,
    isFailed: row.is_failed,
    isSending: row.is_sending === true,
    sendingAt: row.sending_at !== null && row.sending_at !== undefined ? parseInt(row.sending_at, 10) : 0,
    template: row.template || false,
    transport: parseInt(row.transport, 10),
    concatSubject: row.concat_subject || false,
    mailOptions: parseMailOptions(row.mail_options),
  };
};

/** Class representing PostgreSQL Queue for MailTime */
class PostgresQueue {
  /**
   * Create a PostgresQueue instance
   * @param {PostgresQueueOption} opts - configuration object
   */
  constructor(opts) {
    this.name = 'postgres-queue';
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('[mail-time] Configuration object must be passed into PostgresQueue constructor');
    }

    if (!opts.client || typeof opts.client.query !== 'function') {
      throw new Error('[mail-time] [PostgresQueue] required {client} option is missing or does not expose a `query` method');
    }

    this.client = opts.client;
    if (typeof opts.prefix === 'string' && opts.prefix.length > 0) {
      this.__applyPrefix(opts.prefix);
    }
  }

  /** @internal */
  __applyPrefix(prefix) {
    this.prefix = prefix;
    this.__readyPromise = this.__setup();
    this.__readyPromise.catch(() => void 0);
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
   * @memberOf PostgresQueue
   * @name ready
   * @description Wait until PostgreSQL schema is ready
   * @returns {Promise<void 0>}
   */
  async ready() {
    this.__ensurePrefix();
    this.__debug('[ready]');
    await this.__readyPromise;
  }

  /** @internal */
  async __setup() {
    await this.client.query('SELECT pg_advisory_lock($1)', [setupLockId]);

    try {
      await this.client.query(`CREATE TABLE IF NOT EXISTS mail_time_queue (
          id BIGSERIAL PRIMARY KEY,
          prefix TEXT NOT NULL DEFAULT 'default',
          uuid TEXT NOT NULL,
          to_address TEXT,
          tries INTEGER NOT NULL DEFAULT 0,
          send_at BIGINT NOT NULL,
          is_sent BOOLEAN NOT NULL DEFAULT false,
          is_cancelled BOOLEAN NOT NULL DEFAULT false,
          is_failed BOOLEAN NOT NULL DEFAULT false,
          is_sending BOOLEAN NOT NULL DEFAULT false,
          sending_at BIGINT NOT NULL DEFAULT 0,
          template TEXT,
          transport INTEGER NOT NULL DEFAULT 0,
          concat_subject TEXT,
          mail_options JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )`);
      await this.client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_time_queue_prefix_uuid
        ON mail_time_queue (prefix, uuid)`);

      await this.client.query(`CREATE INDEX IF NOT EXISTS idx_mail_time_queue_due
        ON mail_time_queue (prefix, is_sent, is_failed, is_cancelled, is_sending, sending_at, send_at, tries)`);

      await this.client.query(`CREATE INDEX IF NOT EXISTS idx_mail_time_queue_pending_to
        ON mail_time_queue (prefix, to_address, is_sent, is_failed, is_cancelled, send_at)`);
    } finally {
      await this.client.query('SELECT pg_advisory_unlock($1)', [setupLockId]);
    }
  }

  /**
   * @async
   * @memberOf PostgresQueue
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
      await this.ready();
      const ping = await this.client.query('SELECT 1 as ping');
      if (ping?.rows?.[0]?.ping === 1) {
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
   * @memberOf PostgresQueue
   * @name iterate
   * @description iterate over queued tasks passing each to `mailTimeInstance.___dispatch` (the bounded send pool). Postgres reads buffer the full result, so each tick is bounded by `opts.limit` (or 1000 when caller passes `Infinity` / no limit) to keep memory predictable; high-throughput deployments should shard prefixes.
   * @param {{ limit?: number, sendingTimeout?: number }} [opts] - iteration options
   * @returns {Promise<void>}
   */
  async iterate(opts) {
    this.__debug('[iterate]', opts);
    if (!this.mailTimeInstance) {
      return;
    }
    await this.ready();

    const now = Date.now();
    const sendingTimeout = (opts && typeof opts.sendingTimeout === 'number' && opts.sendingTimeout > 0)
      ? opts.sendingTimeout
      : 300000;
    const limit = (opts && typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0)
      ? Math.max(1, Math.floor(opts.limit))
      : 1000;

    try {
      const res = await this.client.query(`SELECT id, uuid, to_address, tries, send_at, is_sent, is_cancelled, is_failed,
               is_sending, sending_at, template, transport, concat_subject, mail_options
        FROM mail_time_queue
        WHERE prefix = $1
          AND is_sent = false
          AND is_failed = false
          AND is_cancelled = false
          AND send_at <= $2
          AND tries < $3
          AND (is_sending = false OR sending_at <= $4)
        ORDER BY send_at ASC
        LIMIT $5`, [this.prefix, now, this.mailTimeInstance.maxTries, now - sendingTimeout, limit]);

      for (const row of res.rows || []) {
        await this.mailTimeInstance.___dispatch(normalizeRow(row));
      }
    } catch (iterateError) {
      logError('[PostgresQueue] [iterate] [iterateError]', iterateError);
    }
  }

  /**
   * @async
   * @memberOf PostgresQueue
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

    await this.ready();

    const res = await this.client.query(`SELECT id, uuid, to_address, tries, send_at, is_sent, is_cancelled, is_failed,
             template, transport, concat_subject, mail_options
      FROM mail_time_queue
      WHERE prefix = $1
        AND to_address = $2
        AND is_sent = false
        AND is_failed = false
        AND is_cancelled = false
        AND send_at <= $3
      ORDER BY send_at DESC
      LIMIT 1`, [this.prefix, to, sendAt]);

    return normalizeRow(res.rows?.[0]);
  }

  /**
   * @async
   * @memberOf PostgresQueue
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

    await this.ready();

    if (task.sendAt instanceof Date) {
      task.sendAt = +task.sendAt;
    }

    await this.client.query(`INSERT INTO mail_time_queue (
        prefix, uuid, to_address, tries, send_at, is_sent, is_cancelled, is_failed,
        is_sending, sending_at, template, transport, concat_subject, mail_options, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (prefix, uuid) DO UPDATE SET
        to_address = EXCLUDED.to_address,
        tries = EXCLUDED.tries,
        send_at = EXCLUDED.send_at,
        is_sent = EXCLUDED.is_sent,
        is_cancelled = EXCLUDED.is_cancelled,
        is_failed = EXCLUDED.is_failed,
        is_sending = EXCLUDED.is_sending,
        sending_at = EXCLUDED.sending_at,
        template = EXCLUDED.template,
        transport = EXCLUDED.transport,
        concat_subject = EXCLUDED.concat_subject,
        mail_options = EXCLUDED.mail_options,
        updated_at = CURRENT_TIMESTAMP`, [
      this.prefix,
      task.uuid,
      typeof task.to === 'string' ? task.to : null,
      task.tries,
      task.sendAt,
      task.isSent,
      task.isCancelled,
      task.isFailed,
      task.isSending === true,
      typeof task.sendingAt === 'number' ? task.sendingAt : 0,
      task.template || null,
      task.transport,
      task.concatSubject || null,
      JSON.stringify(task.mailOptions || []),
    ]);
  }

  /**
   * @async
   * @memberOf PostgresQueue
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

    await this.ready();

    const task = normalizeRow((await this.client.query(`SELECT id, uuid, to_address, tries, send_at, is_sent, is_cancelled, is_failed,
             template, transport, concat_subject, mail_options
      FROM mail_time_queue
      WHERE prefix = $1
        AND uuid = $2
      LIMIT 1`, [this.prefix, uuid])).rows?.[0]);

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
   * @memberOf PostgresQueue
   * @name remove
   * @description remove task from queue
   * @param task {object} - task's object
   * @returns {Promise<boolean>} returns `true` if removed or `false` if not found
   */
  async remove(task) {
    this.__debug('[remove]', task?.uuid);
    if (!task || typeof task !== 'object') {
      return false;
    }

    await this.ready();

    const where = task.id ? 'id = $2' : 'uuid = $2';
    const value = task.id || task.uuid;
    const res = await this.client.query(`DELETE FROM mail_time_queue
      WHERE prefix = $1
        AND ${where}`, [this.prefix, value]);
    return (res.rowCount || 0) >= 1;
  }

  /**
   * @async
   * @memberOf PostgresQueue
   * @name update
   * @description update task in queue
   * @param task {object} - task's object
   * @param updateObj {object} - fields with new values to update
   * @returns {Promise<boolean>} returns `true` if updated or `false` if not found or no changes was made
   */
  async update(task, updateObj) {
    this.__debug('[update]', task?.uuid);
    if (!task || typeof task !== 'object' || !updateObj || typeof updateObj !== 'object') {
      return false;
    }

    await this.ready();

    const sets = [];
    const values = [];
    for (const key of Object.keys(updateObj)) {
      if (!fieldMap[key]) {
        continue;
      }

      let value = updateObj[key];
      if (key === 'sendAt' && value instanceof Date) {
        value = +value;
      }
      if (key === 'mailOptions') {
        value = JSON.stringify(value);
      }

      values.push(value);
      sets.push(`${fieldMap[key]} = $${values.length}`);
    }

    if (!sets.length) {
      return false;
    }

    let claimWhere = '';
    if (isSendClaimUpdate(updateObj)) {
      const now = typeof updateObj.sendingAt === 'number' ? updateObj.sendingAt : Date.now();
      const sendingTimeout = this.mailTimeInstance?.sendingTimeout || 300000;
      values.push(task.tries);
      const triesIndex = values.length;
      values.push(now - sendingTimeout);
      const staleIndex = values.length;
      claimWhere = `
        AND is_sent = false
        AND is_failed = false
        AND is_cancelled = false
        AND tries = $${triesIndex}
        AND (is_sending = false OR sending_at <= $${staleIndex})
      `;
    }

    values.push(this.prefix);
    const prefixIndex = values.length;
    values.push(task.id || task.uuid);
    const taskIndex = values.length;
    const where = task.id ? 'id' : 'uuid';

    const res = await this.client.query(`UPDATE mail_time_queue
      SET ${sets.join(', ')},
          updated_at = CURRENT_TIMESTAMP
      WHERE prefix = $${prefixIndex}
        AND ${where} = $${taskIndex}
        ${claimWhere}`, values);

    return (res.rowCount || 0) >= 1;
  }
}

/**
 * Default `onError` hook used by every built-in preset. Logs via the
 * shared `logError` helper and tags the line with the MailTime instance
 * `prefix` (or `'default'` when unset) so multi-queue deployments can
 * tell their streams apart. Defined as a regular function so `this`
 * resolves to the MailTime instance at call time — `this.onError(...)`
 * in `index.js` binds the receiver. Users override by passing their own
 * `onError` through `mailTimePreset(name, { onError })` or the
 * constructor.
 */
function defaultPresetOnError(error, email, info) {
  logError(`[${this?.prefix || 'default'}] [onError]`, { error, email, info });
}

/**
 * @typedef {object} MailTimePresetConfig
 * @property {boolean} [concatEmails]
 * @property {number} [concatDelay]
 * @property {string} [concatSubject]
 * @property {number} [retries]
 * @property {number} [retryDelay]
 * @property {number} [revolvingInterval]
 * @property {number} [sendingTimeout]
 * @property {'one' | 'batch'} [mode]
 * @property {number} [concurrency]
 * @property {(error: unknown, email: object, details?: object) => void} [onError]
 * @property {object} [josk]
 */

/**
 * Built-in MailTime presets keyed by use-case. Each value is a partial
 * MailTime constructor options object — pass it through `mailTimePreset`
 * (or spread directly) and supply your own `queue` / `transports` /
 * `josk.adapter` / `prefix`. Presets only set the knobs that differ from
 * MailTime defaults so the rest of the constructor stays in your hands.
 *
 * | Preset          | Shape | Best for |
 * |-----------------|-------|----------|
 * | `transactional` | High retries, single SMTP per instance, no concat | Receipts, password resets, account changes, welcome emails. |
 * | `otp`           | Few retries, fast retryDelay, snappy polling, parallel SMTPs | Sign-in codes, 2FA, verification codes — stale OTPs aren't worth resending forever. |
 * | `newsletter`    | `concatEmails: true` with 5-min fold window | Scheduled digests / weekly updates / "what's new" emails. |
 * | `marketing`     | High concurrency, moderate retries, no concat | Promotional / campaign blasts where each letter is unique. |
 * | `notifications` | `concatEmails: true` with 60-s fold window | App / social activity (likes, mentions) where bursts collapse into one letter. |
 * | `alerts`        | Many retries, fast retryDelay, modest concurrency | Ops / admin alerts: monitoring, error reports, escalations. |
 *
 * @type {Readonly<Record<'transactional' | 'otp' | 'newsletter' | 'marketing' | 'notifications' | 'alerts', Readonly<MailTimePresetConfig>>>}
 */
// Every preset pins `mode: 'batch'` explicitly. `'one'` would trade per-tick
// throughput for cluster-wide fairness across pods on the same `prefix`, but:
// - urgent classes (`otp`, `alerts`, `transactional`) want all due rows claimed
//   immediately, not spread one-per-tick;
// - bulk classes (`newsletter`, `marketing`, `notifications`) are bursty and
//   need fast drains during the send window;
// - multiple `server` pods on the same `prefix` is already an anti-pattern in
//   this library (one JoSk lease per prefix), so the fairness payoff is moot.
// If you do want `'one'`, pass it via `mailTimePreset(name, { mode: 'one' })`.
const PRESETS = Object.freeze({
  transactional: Object.freeze({
    concatEmails: false,
    retries: 30,
    retryDelay: 10_000,
    mode: 'batch',
    concurrency: 1,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      zombieTime: 120_000,
    }),
  }),
  otp: Object.freeze({
    concatEmails: false,
    retries: 5,
    retryDelay: 2000,
    revolvingInterval: 1024,
    sendingTimeout: 60_000,
    mode: 'batch',
    concurrency: 4,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      minRevolvingDelay: 256,
      maxRevolvingDelay: 1024,
      zombieTime: 60_000,
    }),
  }),
  newsletter: Object.freeze({
    concatEmails: true,
    concatDelay: 5 * 60_000,
    concatSubject: 'Your updates',
    retries: 5,
    retryDelay: 60_000,
    sendingTimeout: 600_000,
    mode: 'batch',
    concurrency: 2,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      zombieTime: 300_000,
    }),
  }),
  marketing: Object.freeze({
    concatEmails: false,
    retries: 10,
    retryDelay: 30_000,
    mode: 'batch',
    concurrency: 5,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      zombieTime: 180_000,
    }),
  }),
  notifications: Object.freeze({
    concatEmails: true,
    concatDelay: 60_000,
    concatSubject: 'New activity',
    retries: 8,
    retryDelay: 30_000,
    mode: 'batch',
    concurrency: 3,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      zombieTime: 180_000,
    }),
  }),
  alerts: Object.freeze({
    concatEmails: false,
    retries: 20,
    retryDelay: 5000,
    revolvingInterval: 1024,
    sendingTimeout: 60_000,
    mode: 'batch',
    concurrency: 2,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      minRevolvingDelay: 256,
      maxRevolvingDelay: 1024,
      zombieTime: 60_000,
    }),
  }),
});

/**
 * Read-only map of preset name → partial MailTime config. Use
 * `mailTimePreset(name, overrides)` to materialize a merged copy; use
 * this object directly only when you want to introspect or compose
 * presets manually.
 */
const presets = PRESETS;

/**
 * @typedef {keyof typeof PRESETS} MailTimePresetName
 */

/**
 * Names of every built-in preset.
 * @type {ReadonlyArray<MailTimePresetName>}
 */
const presetNames = Object.freeze(/** @type {MailTimePresetName[]} */ (Object.keys(PRESETS)));

/**
 * Materialize a MailTime constructor config from a built-in preset.
 * The named preset is deep-cloned (so the result is freely mutable) and
 * `overrides` is deep-merged on top — overrides win for scalar keys, and
 * nested objects like `josk` are merged so the preset's defaults compose
 * with the caller's `adapter`, `lockOwnerId`, `onError`, etc.
 *
 * ```js
 * import { MailTime, RedisQueue, mailTimePreset } from 'mail-time';
 * const mailTime = new MailTime(mailTimePreset('otp', {
 *   prefix: 'otp',
 *   queue: new RedisQueue({ client }),
 *   transports: [otpTransport],
 *   josk: { adapter: { type: 'redis', client } },
 * }));
 * ```
 *
 * @param {MailTimePresetName} name - one of `presetNames`
 * @param {object} [overrides] - additional MailTime constructor options
 * @returns {object} fresh, mutable MailTime constructor options
 * @throws {Error} when `name` is unknown
 * @throws {TypeError} when `overrides` is provided but not a plain object
 */
const mailTimePreset = (name, overrides) => {
  if (typeof name !== 'string' || !Object.hasOwn(PRESETS, name)) {
    throw new Error(`[mail-time] [mailTimePreset] unknown preset "${name}". Available: ${presetNames.join(', ')}`);
  }
  if (overrides !== void 0 && !isPlainObject(overrides)) {
    throw new TypeError('[mail-time] [mailTimePreset] {overrides} must be a plain object when provided');
  }
  const cloned = deepMerge({}, PRESETS[name]);
  return overrides ? deepMerge(cloned, overrides) : cloned;
};

const noop = () => {};
const queueMethods = ['ping', 'iterate', 'getPendingTo', 'push', 'remove', 'update', 'cancel'];

const createPool = (concurrency) => {
  const limit = Math.max(1, concurrency | 0);
  const queue = [];
  let active = 0;
  let drainResolvers = [];

  const tryStart = () => {
    while (active < limit && queue.length > 0) {
      const job = queue.shift();
      active++;
      job.resolveSlot();
      Promise.resolve()
        .then(job.fn)
        .catch(() => {})
        .finally(() => {
          active--;
          if (active === 0 && queue.length === 0 && drainResolvers.length > 0) {
            const resolvers = drainResolvers;
            drainResolvers = [];
            for (const r of resolvers) r();
          }
          tryStart();
        });
    }
  };

  return {
    /**
     * Queue `fn` for execution under the concurrency limit.
     * The returned Promise resolves as soon as a slot is acquired and `fn` has started.
     * It does NOT wait for `fn` to finish. Use `drain()` to wait for all running jobs to settle.
     * @param {() => Promise<void>} fn
     * @returns {Promise<void>}
     */
    dispatch(fn) {
      return new Promise((resolveSlot) => {
        queue.push({ fn, resolveSlot });
        tryStart();
      });
    },
    drain() {
      if (active === 0 && queue.length === 0) {
        return Promise.resolve();
      }
      return new Promise((resolve) => drainResolvers.push(resolve));
    },
    get size() {
      return active + queue.length;
    },
  };
};

const mailOptionRecipients = (mailOption) => {
  if (!mailOption) {
    return [];
  }
  return [
    ...toAddressList(mailOption.to),
    ...toAddressList(mailOption.cc),
    ...toAddressList(mailOption.bcc),
  ];
};

const collectAcceptedSet = (task) => {
  const set = new Set();
  for (const mo of (task?.mailOptions || [])) {
    if (Array.isArray(mo.accepted)) {
      for (const addr of mo.accepted) {
        if (typeof addr === 'string') {
          set.add(addr.toLowerCase());
        }
      }
    }
  }
  return set;
};

const collectAllRecipients = (task) => {
  const set = new Set();
  for (const mo of (task?.mailOptions || [])) {
    for (const addr of mailOptionRecipients(mo)) {
      set.add(addr);
    }
  }
  return set;
};

const buildRejectionErrorMap = (info) => {
  const map = new Map();
  const rejected = Array.isArray(info?.rejected) ? info.rejected : [];
  const rejectedErrors = Array.isArray(info?.rejectedErrors) ? info.rejectedErrors : [];
  for (let i = 0; i < rejected.length; i++) {
    const addr = extractEmail(rejected[i]);
    if (!addr) {
      continue;
    }
    const err = rejectedErrors[i];
    map.set(addr, err ? `${err.message || err}` : 'Recipient rejected by transport');
  }
  return map;
};

let DEFAULT_TEMPLATE = '<!DOCTYPE html><html xmlns=http://www.w3.org/1999/xhtml><meta content="text/html; charset=utf-8"http-equiv=Content-Type><meta content="width=device-width,initial-scale=1"name=viewport><title>{{subject}}</title><style>body{-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:none;font-family:Tiempos,Georgia,Times,serif;font-weight:400;width:100%;height:100%;background:#fff;font-size:15px;color:#000;line-height:1.5}a{text-decoration:underline;border:0;color:#000;outline:0;color:inherit}a:hover{text-decoration:none}a[href^=sms],a[href^=tel]{text-decoration:none;color:#000;cursor:default}a img{border:none;text-decoration:none}td{font-family:Tiempos,Georgia,Times,serif;font-weight:400}hr{height:1px;border:none;width:100%;margin:0;margin-top:25px;margin-bottom:25px;background-color:#ECECEC}h1,h2,h3,h4,h5,h6{font-family:HelveticaNeue,"Helvetica Neue",Helvetica,Arial,sans-serif;font-weight:300;line-height:normal;margin-top:35px;margin-bottom:4px;margin-left:0;margin-right:0}h1{margin:23px 15px;font-size:25px}h2{margin-top:15px;font-size:21px}h3{font-weight:400;font-size:19px;border-bottom:1px solid #ECECEC}h4{font-weight:400;font-size:18px}h5{font-weight:400;font-size:17px}h6{font-weight:600;font-size:16px}h1 a,h2 a,h3 a,h4 a,h5 a,h6 a{text-decoration:none}pre{font-family:Consolas,Menlo,Monaco,Lucida Console,Liberation Mono,DejaVu Sans Mono,Bitstream Vera Sans Mono,Courier New,monospace,sans-serif;display:block;font-size:13px;padding:9.5px;margin:0 0 10px;line-height:1.42;color:#333;word-break:break-all;word-wrap:break-word;background-color:#f5f5f5;border:1px solid #ccc;border-radius:4px;text-align:left!important;max-width:100%;white-space:pre-wrap;width:auto;overflow:auto}code{font-size:13px;font-family:font-family: Consolas,Menlo,Monaco,Lucida Console,Liberation Mono,DejaVu Sans Mono,Bitstream Vera Sans Mono,Courier New,monospace,sans-serif;border:1px solid rgba(0,0,0,.223);border-radius:2px;padding:1px 2px;word-break:break-all;word-wrap:break-word}pre code{padding:0;font-size:inherit;color:inherit;white-space:pre-wrap;background-color:transparent;border:none;border-radius:0;word-break:break-all;word-wrap:break-word}td{text-align:center}table{border-collapse:collapse!important}.force-full-width{width:100%!important}</style><style media=screen>@media screen{h1,h2,h3,h4,h5,h6{font-family:\'Helvetica Neue\',Arial,sans-serif!important}td{font-family:Tiempos,Georgia,Times,serif!important}code,pre{font-family:Consolas,Menlo,Monaco,\'Lucida Console\',\'Liberation Mono\',\'DejaVu Sans Mono\',\'Bitstream Vera Sans Mono\',\'Courier New\',monospace,sans-serif!important}}</style><style media="only screen and (max-width:480px)">@media only screen and (max-width:480px){table[class=w320]{width:100%!important}}</style><body bgcolor=#FFFFFF class=body style=padding:0;margin:0;display:block;background:#fff;-webkit-text-size-adjust:none><table cellpadding=0 cellspacing=0 width=100% align=center><tr><td align=center valign=top bgcolor=#FFFFFF width=100%><center><table cellpadding=0 cellspacing=0 width=600 style="margin:0 auto"class=w320><tr><td align=center valign=top><table cellpadding=0 cellspacing=0 width=100% style="margin:0 auto;border-bottom:1px solid #ddd"bgcolor=#ECECEC><tr><td><h1>{{{subject}}}</h1></table><table cellpadding=0 cellspacing=0 width=100% style="margin:0 auto"bgcolor=#F2F2F2><tr><td><center><table cellpadding=0 cellspacing=0 width=100% style="margin:0 auto"><tr><td align=left style="text-align:left;padding:30px 25px">{{{html}}}</table></center></table></table></center></table>';

/**
 * @typedef {import('./presets.js').MailTimePresetName} MailTimePresetName
 */

/**
 * @typedef {import('./presets.js').MailTimePresetConfig} MailTimePresetConfig
 */

/**
 * @typedef {{ status: string, code: number, statusCode: number, error?: unknown }} MailTimePingResult
 */

/**
 * @typedef {{ [key: string]: any, query?: (queryText: string, values?: unknown[]) => Promise<{ rows?: unknown[], rowCount?: number | null }> }} MailTimeStorageClient
 */

/**
 * @typedef {{ [key: string]: any }} MailTimeMongoDb
 */

/**
 * @typedef {{ [key: string]: any }} MailTimeTransport
 */

/**
 * @typedef {{ [key: string]: any, type?: 'mongo' | 'redis' | 'postgres', client?: MailTimeStorageClient, db?: MailTimeMongoDb, prefix?: string, resetOnInit?: boolean }} MailTimeJoSkAdapterOptions
 */

/**
 * @typedef {{ [key: string]: any, adapter: MailTimeJoSkAdapterOptions | object, debug?: boolean, autoClear?: boolean, zombieTime?: number, minRevolvingDelay?: number, maxRevolvingDelay?: number, execute?: 'batch' | 'one', concurrency?: number, lockOwnerId?: string, resetOnInit?: boolean, onError?: (title: string, details: object) => void }} MailTimeJoSkOptions
 */

/**
 * @typedef {{ uuid: string, to?: string | string[], tries: number, sendAt: number, isSent: boolean, isCancelled: boolean, isFailed: boolean, isSending?: boolean, sendingAt?: number, template?: string | false, transport: number, concatSubject?: string | false, mailOptions: MailTimeMailOptions[] }} MailTimeTask
 */

/**
 * @typedef {{ limit?: number, sendingTimeout?: number }} MailTimeIterateOptions
 */

/**
 * @typedef {{ ping: () => Promise<MailTimePingResult>, iterate: (opts?: MailTimeIterateOptions) => Promise<void> | void, getPendingTo: (to: string, sendAt: number) => Promise<MailTimeTask | object | null>, push: (email: MailTimeTask) => Promise<void> | void, cancel: (uuid: string) => Promise<boolean>, remove: (email: MailTimeTask | object) => Promise<boolean>, update: (email: MailTimeTask | object, updateObj: object) => Promise<boolean>, ready?: () => Promise<void> }} CustomQueue
 */

/**
 * @typedef {{ address: string, error: string }} MailTimeRejectedRecipient
 */

/**
 * @typedef {{ [key: string]: any, to: string | string[], sendAt?: Date | number, template?: string, concatSubject?: string, text?: string | false, html?: string | false, subject?: string, accepted?: string[], rejected?: MailTimeRejectedRecipient[] }} MailTimeMailOptions
 */

/**
 * @typedef {{ subject?: string }} MailTimeConcatEmailsOptions
 */

/**
 * @typedef {{ queue: RedisQueue | MongoQueue | PostgresQueue | CustomQueue, type?: 'server' | 'client', from?: string | ((transport: MailTimeTransport) => string), transports?: MailTimeTransport[], strategy?: 'backup' | 'balancer', failsToNext?: number, retries?: number, maxTries?: number, retryDelay?: number, interval?: number, keepHistory?: boolean, concatEmails?: boolean | MailTimeConcatEmailsOptions, concatSubject?: string, concatDelimiter?: string, concatDelay?: number, concatThrottling?: number, revolvingInterval?: number, mode?: 'one' | 'batch', concurrency?: number, sendingTimeout?: number, verifyTransports?: boolean, template?: string, prefix?: string, debug?: boolean, josk?: MailTimeJoSkOptions, onError?: (error: unknown, email: MailTimeTask | null, details?: object) => void, onSent?: (email: MailTimeTask, details?: object) => void }} MailTimeOptions
 */

/** Class of MailTime */
class MailTime {
  /**
   * Create a MailTime instance
   * @param {MailTimeOptions} opts - configuration object
   */
  constructor (opts) {
    if (!opts || typeof opts !== 'object') {
      throw new TypeError('[mail-time] Configuration object must be passed into MailTime constructor');
    }

    if (!opts.queue || typeof opts.queue !== 'object') {
      throw new Error('[mail-time] {queue} option is required: provide a MongoQueue, RedisQueue, PostgresQueue, or CustomQueue instance');
    }

    this.queue = opts.queue;

    for (let i = queueMethods.length - 1; i >= 0; i--) {
      if (typeof this.queue[queueMethods[i]] !== 'function') {
        throw new Error(`[mail-time] {queue} instance is missing {${queueMethods[i]}} method that is required!`);
      }
    }

    this.debug = opts.debug === true;
    this.__debug = (...args) => {
      debug(this.debug, `[${this.prefix || 'default'}]`, ...args);
    };

    this.type = (opts.type === 'client' || opts.type === 'server') ? opts.type : 'server';
    this.prefix = (typeof opts.prefix === 'string') ? opts.prefix : '';

    if (typeof opts.retries === 'number') {
      if (opts.retries < 0) {
        throw new Error('[mail-time] {retries} must be a non-negative number');
      }
      this.maxTries = opts.retries + 1;
    } else if (typeof opts.maxTries === 'number') {
      this.maxTries = (opts.maxTries < 1) ? 1 : opts.maxTries;
    } else {
      this.maxTries = 60;
    }

    if (typeof opts.retryDelay === 'number') {
      this.retryDelay = opts.retryDelay;
    } else if (typeof opts.interval === 'number') {
      this.retryDelay = opts.interval * 1000;
    } else {
      this.retryDelay = 60000;
    }

    this.template = (typeof opts.template === 'string') ? opts.template : '{{{html}}}';
    this.keepHistory = opts.keepHistory === true;
    this.onSent = (typeof opts.onSent === 'function') ? opts.onSent.bind(this) : noop;
    this.onError = (typeof opts.onError === 'function') ? opts.onError.bind(this) : noop;

    this.revolvingInterval = (typeof opts.revolvingInterval === 'number' && opts.revolvingInterval > 0) ? opts.revolvingInterval : 1536;
    this.mode = (opts.mode === 'one' || opts.mode === 'batch') ? opts.mode : 'batch';
    this.concurrency = (typeof opts.concurrency === 'number' && opts.concurrency > 0 && Number.isFinite(opts.concurrency)) ? Math.floor(opts.concurrency) : 1;
    this.sendingTimeout = (typeof opts.sendingTimeout === 'number' && opts.sendingTimeout > 0) ? opts.sendingTimeout : 300000;
    this.__isDestroyed = false;
    this.__readyPromise = null;
    this.__schedulerTimer = null;
    this.__inFlight = new Set();
    this.__pool = createPool(this.concurrency);

    this.failsToNext = (typeof opts.failsToNext === 'number' && opts.failsToNext > 0) ? opts.failsToNext : 4;
    this.strategy = (opts.strategy === 'backup' || opts.strategy === 'balancer') ? opts.strategy : 'backup';
    this.transports = Array.isArray(opts.transports) ? opts.transports : [];
    this.transport = 0;
    this.verifyTransports = opts.verifyTransports !== false;
    this.__unhealthyTransports = new Set();

    if (typeof opts.from === 'string') {
      const fromStr = opts.from;
      this.from = () => fromStr;
    } else if (typeof opts.from === 'function') {
      this.from = opts.from;
    } else {
      this.from = false;
    }

    this.queue.mailTimeInstance = this;

    /** @type {string} */
    this.concatSubject = (typeof opts.concatSubject === 'string' && opts.concatSubject) ? opts.concatSubject : 'Multiple notifications';
    if (opts.concatEmails === true) {
      this.concatEmails = true;
    } else if (isPlainObject(opts.concatEmails)) {
      this.concatEmails = true;
      if (typeof opts.concatEmails.subject === 'string' && opts.concatEmails.subject) {
        this.concatSubject = opts.concatEmails.subject;
      }
    } else {
      this.concatEmails = false;
    }
    this.concatDelimiter = (typeof opts.concatDelimiter === 'string' && opts.concatDelimiter) ? opts.concatDelimiter : '<hr>';

    if (typeof opts.concatDelay === 'number') {
      this.concatDelay = opts.concatDelay;
    } else if (typeof opts.concatThrottling === 'number') {
      this.concatDelay = opts.concatThrottling * 1000;
    } else {
      this.concatDelay = 60000;
    }

    this.__debug('DEBUG ON {debug: true}');
    this.__debug(`INITIALIZING [type: ${this.type}]`);
    this.__debug(`INITIALIZING [strategy: ${this.strategy}]`);
    this.__debug(`INITIALIZING [josk.adapter.type: ${opts?.josk?.adapter?.type || 'custom'}]`);
    this.__debug(`INITIALIZING [prefix: ${this.prefix}]`);
    this.__debug(`INITIALIZING [retries: ${this.maxTries - 1}]`);
    this.__debug(`INITIALIZING [failsToNext: ${this.failsToNext}]`);
    this.__debug(`INITIALIZING [mode: ${this.mode}]`);
    this.__debug(`INITIALIZING [concurrency: ${this.concurrency}]`);
    this.__debug(`INITIALIZING [sendingTimeout: ${this.sendingTimeout}]`);

    /** SERVER-SPECIFIC CHECKS AND CONFIG */
    if (this.type === 'server') {
      if (!this.transports.length) {
        throw new Error('[mail-time] {transports} is required for {type: "server"} and must be a non-empty Array, like one returned from `nodemailer.createTransport`');
      }

      if (!opts.josk || typeof opts.josk !== 'object') {
        throw new Error('[mail-time] {josk} option is required {object} for {type: "server"}');
      }

      if (!opts.josk.adapter || typeof opts.josk.adapter !== 'object') {
        throw new Error('[mail-time] {josk.adapter} option is required {object} *or* custom adapter Class');
      }

      this.josk = { ...opts.josk };
      const buildAdapterOptions = () => {
        const adapterOptions = {
          prefix: `mailTimeQueue${this.prefix}`,
          ...opts.josk.adapter,
        };

        if (typeof opts.josk.resetOnInit === 'boolean' && typeof adapterOptions.resetOnInit !== 'boolean') {
          adapterOptions.resetOnInit = opts.josk.resetOnInit;
        }

        return adapterOptions;
      };

      const adapterType = opts.josk.adapter.type;
      if (adapterType === 'mongo') {
        if (!opts.josk.adapter.db) {
          throw new Error('[mail-time] {josk.adapter.db} option required for {josk.adapter.type: "mongo"}');
        }
        this.josk.adapter = new josk.MongoAdapter(buildAdapterOptions());
      } else if (adapterType === 'redis') {
        if (!opts.josk.adapter.client) {
          throw new Error('[mail-time] {josk.adapter.client} option required for {josk.adapter.type: "redis"}');
        }
        this.josk.adapter = new josk.RedisAdapter(buildAdapterOptions());
      } else if (adapterType === 'postgres') {
        if (!opts.josk.adapter.client) {
          throw new Error('[mail-time] {josk.adapter.client} option required for {josk.adapter.type: "postgres"}');
        }
        this.josk.adapter = new josk.PostgresAdapter(buildAdapterOptions());
      }

      this.josk.minRevolvingDelay = (typeof opts.josk.minRevolvingDelay === 'number') ? opts.josk.minRevolvingDelay : 512;
      this.josk.maxRevolvingDelay = (typeof opts.josk.maxRevolvingDelay === 'number') ? opts.josk.maxRevolvingDelay : 2048;
      this.josk.zombieTime = (typeof opts.josk.zombieTime === 'number') ? opts.josk.zombieTime : 60000;
      this.josk.execute = (opts.josk.execute === 'one' || opts.josk.execute === 'batch') ? opts.josk.execute : 'batch';
      this.josk.concurrency = (typeof opts.josk.concurrency === 'number' && opts.josk.concurrency > 0) ? opts.josk.concurrency : Infinity;
      this.josk.autoClear = opts.josk.autoClear === true;

      if (typeof opts.josk.lockOwnerId === 'string' && opts.josk.lockOwnerId.length > 0) {
        this.josk.lockOwnerId = opts.josk.lockOwnerId;
      }

      if (typeof opts.josk.onError !== 'function') {
        this.josk.onError = (title, details) => {
          logError(`[scheduler] ${title}`, details);
        };
      }

      this.scheduler = new josk.JoSk({
        debug: this.debug,
        ...this.josk,
      });

      this.__schedulerTimer = this.scheduler.setInterval(this.___iterate.bind(this), this.revolvingInterval, `mailTimeQueue${this.prefix}`);
    }

    this.__readyPromise = this.___ready();
    this.__readyPromise.catch(() => void 0);
  }

  static get Template() {
    return DEFAULT_TEMPLATE;
  }

  static set Template(newVal) {
    DEFAULT_TEMPLATE = newVal;
  }

  /**
   * @async
   * @memberOf MailTime
   * @name ping
   * @description Check package readiness and connection to Storage
   * @returns {Promise<MailTimePingResult>}
   * @throws {Error}
   */
  async ping() {
    this.__debug('[ping]');
    if (this.scheduler) {
      const schedulerPing = await this.scheduler.ping();
      if (schedulerPing.status !== 'OK') {
        return schedulerPing;
      }
    }
    return await this.queue.ping();
  }

  /**
   * @async
   * @memberOf MailTime
   * @name ready
   * @description Wait until queue and scheduler storage are ready
   * @returns {Promise<MailTime>}
   */
  async ready() {
    this.__debug('[ready]');
    return await this.__readyPromise;
  }

  /**
   * @memberOf MailTime
   * @name destroy
   * @description Destroy scheduler instance and stop future queue iterations
   * @returns {boolean}
   */
  destroy() {
    this.__debug('[destroy]');
    if (this.__isDestroyed) {
      return false;
    }

    this.__isDestroyed = true;
    if (this.scheduler && typeof this.scheduler.destroy === 'function') {
      this.scheduler.destroy();
    }
    return true;
  }

  /**
   * @async
   * @memberOf MailTime
   * @name drain
   * @description Wait for all in-flight email send attempts to settle
   * @returns {Promise<void>}
   */
  async drain() {
    this.__debug('[drain]');
    if (this.__pool) {
      await this.__pool.drain();
    }
  }

  /**
   * @memberOf MailTime
   * @name send
   * @description alias of `sendMail`
   * @param {MailTimeMailOptions} opts - email options
   * @returns {Promise<string>} uuid of the email
   */
  async send(opts) {
    this.__debug('[send]', opts);
    return await this.sendMail(opts);
  }

  /**
   * @async
   * @memberOf MailTime
   * @name sendMail
   * @description add email to the queue or append to existing letter if {concatEmails: true}
   * @param {MailTimeMailOptions} opts - email options
   * @returns {Promise<string>} uuid of the email
   * @throws {Error}
   */
  async sendMail(opts = {}) {
    this.__debug('[sendMail]', opts);
    if (!opts.html && !opts.text) {
      throw new Error('[mail-time] [sendMail] `html` nor `text` field is present, at least one of those fields is required');
    }

    let sendAt = opts.sendAt;
    if (sendAt instanceof Date) {
      sendAt = +sendAt;
    }
    if (typeof sendAt !== 'number' || !Number.isFinite(sendAt)) {
      sendAt = Date.now();
    }

    const template = (typeof opts.template === 'string') ? opts.template : false;
    const concatSubject = (typeof opts.concatSubject === 'string') ? opts.concatSubject : false;

    const mailOptions = { ...opts };
    delete mailOptions.sendAt;
    delete mailOptions.template;
    delete mailOptions.concatSubject;

    if (typeof mailOptions.to !== 'string' && (!Array.isArray(mailOptions.to) || !mailOptions.to.length)) {
      throw new Error('[mail-time] [sendMail] `mailOptions.to` is required and must be a string or non-empty Array');
    }

    if (this.concatEmails) {
      sendAt = sendAt + this.concatDelay;
      const task = await this.queue.getPendingTo(mailOptions.to, sendAt);

      if (task) {
        const pendingMailOptions = task.mailOptions || [];

        for (let i = 0; i < pendingMailOptions.length; i++) {
          if (equals(pendingMailOptions[i], mailOptions)) {
            return task.uuid;
          }
        }

        pendingMailOptions.push(mailOptions);
        await this.queue.update(task, {
          mailOptions: pendingMailOptions,
        });
        return task.uuid;
      }
    }

    return await this.___addToQueue({
      sendAt,
      template,
      concatSubject,
      mailOptions,
    });
  }

  /**
   * @async
   * @memberOf MailTime
   * @name cancel
   * @description alias of `cancelMail`
   * @param {string|Promise<string>} uuid - uuid returned from `send` or `sendMail`
   * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found was sent or was cancelled previously
   */
  async cancel(uuid) {
    this.__debug('[cancel]', uuid);
    return await this.cancelMail(uuid);
  }

  /**
   * @async
   * @memberOf MailTime
   * @name cancelMail
   * @description remove email from the queue or mark as `isCancelled`
   * @param {string|Promise<string>} uuid - uuid returned from `send` or `sendMail`
   * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found was sent or was cancelled previously
   */
  async cancelMail(uuid) {
    this.__debug('[cancelMail]', uuid);
    const resolved = (uuid && typeof uuid.then === 'function') ? await uuid : uuid;
    return await this.queue.cancel(resolved);
  }

  /**
   * @async
   * @internal
   * @memberOf MailTime
   * @name ___handleError
   * @description Handle runtime errors and pass to `onError` callback
   * @param {MailTimeTask} task - Email task record from Storage
   * @param {unknown} error - Error String/Object/Error
   * @param {object} info - Info object returned from nodemailer
   * @returns {Promise<void 0>}
   */
  async ___handleError(task, error, info) {
    this.__debug('[private handleError]', { task, error, info });
    if (!task) {
      return;
    }

    if (task.tries >= this.maxTries) {
      task.isSent = false;
      task.isFailed = true;
      task.isSending = false;
      this.___finalizeRejected(task, info);

      if (!this.keepHistory) {
        await this.queue.remove(task);
      } else {
        await this.queue.update(task, {
          isSent: false,
          isFailed: true,
          isSending: false,
          sendingAt: 0,
          mailOptions: task.mailOptions,
        });
      }

      this.__debug(`[private handleError] Giving up trying send email after ${task.tries} attempts to: `, task.mailOptions[0].to, error);
      this.onError(error, task, info);
      return;
    }

    let transportIndex = task.transport;

    if (this.strategy === 'backup' && this.transports.length > 1 && (task.tries % this.failsToNext) === 0) {
      transportIndex = this.___nextHealthyTransport(transportIndex);
    }

    await this.queue.update(task, {
      isSending: false,
      sendingAt: 0,
      sendAt: Date.now() + this.retryDelay,
      transport: transportIndex,
    });

    this.__debug(`[private handleError] Next re-send attempt at ${new Date(Date.now() + this.retryDelay)}: #${task.tries}/${this.maxTries}, transport #${transportIndex} to: `, task.mailOptions[0].to, error);
  }

  /**
   * @async
   * @internal
   * @memberOf MailTime
   * @name ___addToQueue
   * @description Prepare task's object and push to the queue
   * @param {{ sendAt: number, template: string | false, mailOptions: MailTimeMailOptions, concatSubject: string | false }} opts - Email options
   * @returns {Promise<string>} message uuid
   */
  async ___addToQueue(opts) {
    this.__debug('[private addToQueue]', opts);
    let transportIndex = this.transport;
    if (this.strategy === 'balancer' && this.transports.length > 0) {
      transportIndex = this.___nextHealthyTransport(this.transport);
      this.transport = transportIndex;
    }
    const task = {
      uuid: node_crypto.randomUUID(),
      tries: 0,
      isSent: false,
      sendAt: opts.sendAt,
      isFailed: false,
      isSending: false,
      sendingAt: 0,
      template: opts.template,
      transport: transportIndex,
      isCancelled: false,
      mailOptions: [opts.mailOptions],
      concatSubject: opts.concatSubject,
    };

    if (this.concatEmails) {
      task.to = opts.mailOptions.to;
    }

    await this.queue.push(task);
    return task.uuid;
  }

  /**
   * @internal
   * @memberOf MailTime
   * @name ___render
   * @description Render Mustache-like placeholders
   * @param {string} _string - Template with Mustache-like placeholders
   * @param {Record<string, any>} replacements - Blaze/Mustache-like helpers Object
   * @returns {string}
   */
  ___render(_string, replacements) {
    let string = _string;
    const matchHTML = string.match(/\{{3}\s?([a-zA-Z0-9\-_]+)\s?\}{3}/g);
    if (matchHTML) {
      for (let i = 0; i < matchHTML.length; i++) {
        const key = matchHTML[i].slice(3, -3).trim();
        if (Object.hasOwn(replacements, key) && replacements[key] !== null && replacements[key] !== void 0) {
          string = string.replace(matchHTML[i], `${replacements[key]}`);
        }
      }
    }

    const matchStr = string.match(/\{{2}\s?([a-zA-Z0-9\-_]+)\s?\}{2}/g);
    if (matchStr) {
      for (let i = 0; i < matchStr.length; i++) {
        const key = matchStr[i].slice(2, -2).trim();
        if (Object.hasOwn(replacements, key) && replacements[key] !== null && replacements[key] !== void 0) {
          string = string.replace(matchStr[i], `${replacements[key]}`.replace(/<(?:.|\n)*?>/gm, ''));
        }
      }
    }
    return string;
  }

  /**
   * @internal
   * @memberOf MailTime
   * @name ___compileMailOpts
   * @description Run various checks, compile options, and render template
   * @param {MailTimeTransport} transport - Current transport
   * @param {MailTimeTask} task - Email task record from Storage
   * @returns {MailTimeMailOptions}
   */
  ___compileMailOpts(transport, task) {
    if (!transport) {
      throw new Error('[mail-time] [sendMail] [___compileMailOpts] {transport} is not available or misconfigured!');
    }

    let compiledOpts = {};

    if (isPlainObject(transport._options) && isPlainObject(transport._options.mailOptions)) {
      compiledOpts = deepMerge(compiledOpts, transport._options.mailOptions);
    }

    if (isPlainObject(transport.options) && isPlainObject(transport.options.mailOptions)) {
      compiledOpts = deepMerge(compiledOpts, transport.options.mailOptions);
    }

    compiledOpts.html ??= '';
    compiledOpts.text ??= '';
    compiledOpts.subject ??= '';

    const mailOptionsList = task.mailOptions || [];
    const isMulti = mailOptionsList.length > 1;

    for (let i = 0; i < mailOptionsList.length; i++) {
      const mailOption = { ...mailOptionsList[i] };

      if (mailOption.html) {
        const rendered = this.___render(mailOption.html, mailOption);
        if (isMulti) {
          compiledOpts.html += this.___render(this.concatDelimiter, mailOption) + rendered;
        } else {
          compiledOpts.html = rendered;
        }
        delete mailOption.html;
      }

      if (mailOption.text) {
        const rendered = this.___render(mailOption.text, mailOption);
        if (isMulti) {
          compiledOpts.text += '\r\n' + rendered;
        } else {
          compiledOpts.text = rendered;
        }
        delete mailOption.text;
      }

      compiledOpts = deepMerge(compiledOpts, mailOption);
    }

    if (compiledOpts.html && (task.template || this.template)) {
      compiledOpts.html = this.___render((task.template || this.template), compiledOpts);
    }

    if (isMulti) {
      const rawSubject = task.concatSubject || this.concatSubject || compiledOpts.subject;
      compiledOpts.subject = this.___render(rawSubject, { count: mailOptionsList.length });
    }

    if (!compiledOpts.from && this.from) {
      compiledOpts.from = this.from(transport);
    }

    const acceptedSet = collectAcceptedSet(task);
    if (acceptedSet.size > 0) {
      compiledOpts.to = filterAddressField(compiledOpts.to, acceptedSet);
      compiledOpts.cc = filterAddressField(compiledOpts.cc, acceptedSet);
      compiledOpts.bcc = filterAddressField(compiledOpts.bcc, acceptedSet);
    }

    return compiledOpts;
  }

  /**
   * @internal
   * @memberOf MailTime
   * @name ___trackAcceptedRecipients
   * @description Append newly-accepted addresses to each mailOption's `accepted` list
   * @param {MailTimeTask} task - Email task record from Storage
   * @param {string[]} acceptedAddrs - Lowercased addresses confirmed by transport
   * @returns {void}
   */
  ___trackAcceptedRecipients(task, acceptedAddrs) {
    if (!Array.isArray(task?.mailOptions) || acceptedAddrs.length === 0) {
      return;
    }
    const acceptedSet = new Set(acceptedAddrs);
    for (const mo of task.mailOptions) {
      if (!Array.isArray(mo.accepted)) {
        mo.accepted = [];
      }
      const moRecipients = new Set(mailOptionRecipients(mo));
      if (moRecipients.size === 0) {
        continue;
      }
      const alreadyAccepted = new Set(mo.accepted.map((a) => typeof a === 'string' ? a.toLowerCase() : a));
      for (const addr of acceptedSet) {
        if (moRecipients.has(addr) && !alreadyAccepted.has(addr)) {
          mo.accepted.push(addr);
          alreadyAccepted.add(addr);
        }
      }
    }
  }

  /**
   * @internal
   * @memberOf MailTime
   * @name ___finalizeRejected
   * @description Populate each mailOption's `rejected` list with addresses that never delivered
   * @param {MailTimeTask} task - Email task record from Storage
   * @param {object} info - Info object from the last nodemailer attempt
   * @returns {void}
   */
  ___finalizeRejected(task, info) {
    if (!Array.isArray(task?.mailOptions)) {
      return;
    }
    const errorMap = buildRejectionErrorMap(info);
    for (const mo of task.mailOptions) {
      const moAccepted = new Set((mo.accepted || []).map((a) => typeof a === 'string' ? a.toLowerCase() : a));
      const seen = new Set();
      const rejected = [];
      for (const addr of mailOptionRecipients(mo)) {
        if (moAccepted.has(addr) || seen.has(addr)) {
          continue;
        }
        seen.add(addr);
        rejected.push({
          address: addr,
          error: errorMap.get(addr) || 'Recipient rejected by transport',
        });
      }
      mo.rejected = rejected;
    }
  }

  /**
   * @async
   * @internal
   * @memberOf MailTime
   * @name ___dispatch
   * @description Queue full-lifecycle send for `task` under the bounded send pool. Resolves as soon as a pool slot is acquired and the send has started — the SMTP roundtrip continues in the background so the adapter's `iterate` can move on to the next due row and the JoSk lease can be released. Use `mailTime.drain()` (or `destroy()`) to await in-flight sends.
   * @param {MailTimeTask} task - email's task object from Storage
   * @returns {Promise<void 0>}
   */
  async ___dispatch(task) {
    if (this.__isDestroyed) {
      return;
    }
    if (!task || task.isSent === true || task.isFailed === true || task.isCancelled === true) {
      return;
    }
    if (this.__inFlight.has(task.uuid)) {
      this.__debug('[private dispatch] already in-flight on this instance, skipping', task.uuid);
      return;
    }
    this.__inFlight.add(task.uuid);
    await this.__pool.dispatch(async () => {
      try {
        await this.___send(task);
      } finally {
        this.__inFlight.delete(task.uuid);
      }
    });
  }

  /**
   * @async
   * @internal
   * @memberOf MailTime
   * @name ___send
   * @description Full send lifecycle for a single task: atomic claim (`isSending=true, sendingAt=now, tries=tries+1`), SMTP roundtrip, completion. Returns when the lifecycle ends.
   * @param {MailTimeTask} task - email's task object from Storage
   * @returns {Promise<void 0>}
   */
  async ___send(task) {
    this.__debug('[private send]', task);
    try {
      if (!task || task.isSent === true || task.isFailed === true || task.isCancelled === true) {
        return;
      }

      const tries = task.tries + 1;
      const sendingAt = Date.now();
      let isClaimed = false;
      try {
        isClaimed = await this.queue.update(task, {
          isSending: true,
          sendingAt,
          tries,
        });
      } catch (claimError) {
        logError('[private send] [claim] storage error during atomic claim', claimError);
        return;
      }

      if (!isClaimed) {
        this.__debug('[private send] [queue.update] Stale claim, skipping', task.uuid);
        return;
      }

      task.tries = tries;
      task.isSending = true;
      task.sendingAt = sendingAt;

      let transportIndex = task.transport;
      if (!this.___isHealthyTransport(transportIndex)) {
        transportIndex = this.___nextHealthyTransport(transportIndex);
        task.transport = transportIndex;
      }
      const transport = this.transports[transportIndex];

      const compiledOpts = this.___compileMailOpts(transport, task);

      await new Promise((resolve) => {
        transport.sendMail(compiledOpts, async (error, info) => {
          this.__debug('[private send] [sending]', { error, info });
          try {
            if (error) {
              await this.___handleError(task, error, info);
              return;
            }

            const acceptedAddrs = Array.isArray(info?.accepted)
              ? info.accepted.map(extractEmail).filter((addr) => typeof addr === 'string')
              : [];

            if (acceptedAddrs.length === 0) {
              await this.___handleError(task, new Error('Message not accepted or Greeting never received'), info);
              return;
            }

            this.___trackAcceptedRecipients(task, acceptedAddrs);

            const allRecipients = collectAllRecipients(task);
            const allAccepted = collectAcceptedSet(task);
            let isFullyDelivered = true;
            for (const addr of allRecipients) {
              if (!allAccepted.has(addr)) {
                isFullyDelivered = false;
                break;
              }
            }

            if (isFullyDelivered) {
              this.__debug(`email successfully sent, attempts: #${task.tries}, transport #${transportIndex} to: `, compiledOpts.to);

              task.isSent = true;
              task.isSending = false;
              task.sendingAt = 0;

              if (!this.keepHistory) {
                await this.queue.remove(task);
              } else {
                await this.queue.update(task, {
                  isSent: true,
                  isSending: false,
                  sendingAt: 0,
                  mailOptions: task.mailOptions,
                });
              }

              this.onSent(task, info);
              return;
            }

            if (task.tries >= this.maxTries) {
              task.isSent = false;
              task.isFailed = true;
              task.isSending = false;
              this.___finalizeRejected(task, info);

              if (!this.keepHistory) {
                await this.queue.remove(task);
              } else {
                await this.queue.update(task, {
                  isSent: false,
                  isFailed: true,
                  isSending: false,
                  sendingAt: 0,
                  mailOptions: task.mailOptions,
                });
              }

              const rejectedAddrs = [];
              for (const mo of task.mailOptions) {
                for (const r of (mo.rejected || [])) {
                  rejectedAddrs.push(r.address);
                }
              }
              const partialError = new Error(`Recipients rejected after ${task.tries} attempts: ${rejectedAddrs.join(', ')}`);
              this.__debug('[private send] Partial delivery exhausted retries; rejected: ', rejectedAddrs);
              this.onError(partialError, task, info);
              return;
            }

            const nextSendAt = Date.now() + this.retryDelay;
            await this.queue.update(task, {
              isSending: false,
              sendingAt: 0,
              sendAt: nextSendAt,
              mailOptions: task.mailOptions,
            });
            this.__debug(`[private send] Partial delivery, next attempt at ${new Date(nextSendAt)}: #${task.tries}/${this.maxTries} for remaining recipients`);
          } finally {
            resolve();
          }
        });
      });
    } catch (e) {
      logError('Exception during runtime:', e);
      await this.___handleError(task, e, {});
    }
  }

  /**
   * @internal
   * @memberOf MailTime
   * @name ___iterate
   * @description JoSk handler — claim and dispatch due tasks. Returns as soon as the scan finishes so the JoSk lease is released; in-flight SMTP work continues in the background pool.
   * @returns {Promise<void>|void}
   */
  async ___iterate() {
    this.__debug('[private iterate]');
    if (this.__isDestroyed) {
      return;
    }
    const limit = this.mode === 'one' ? 1 : Infinity;
    return await this.queue.iterate({
      limit,
      sendingTimeout: this.sendingTimeout,
    });
  }

  /**
   * @async
   * @internal
   * @memberOf MailTime
   * @name ___ready
   * @description Internal storage readiness gate
   * @returns {Promise<MailTime>}
   */
  async ___ready() {
    if (typeof this.queue.ready === 'function') {
      await this.queue.ready();
    }

    if (this.__schedulerTimer) {
      await this.__schedulerTimer;
    }

    const pingResult = await this.ping();
    if (pingResult.status !== 'OK') {
      throw new Error('[mail-time] [MailTime#ready] can not connect to storage, make sure it is available and properly configured', { cause: pingResult.error });
    }

    if (this.type === 'server' && this.verifyTransports && this.transports.length > 0) {
      await this.___verifyTransports();
    }

    return this;
  }

  /**
   * @async
   * @internal
   * @memberOf MailTime
   * @name ___verifyTransports
   * @description Probe each transport's `verify()` once at startup. Failing transports are marked unusable and skipped during rotation; the failure is surfaced through `onError(error, null, { transportIndex, phase: 'verify' })`. Throws if every transport fails — there is nothing left that could deliver.
   * @returns {Promise<void>}
   */
  async ___verifyTransports() {
    this.__debug('[private verifyTransports]');
    const results = await Promise.all(this.transports.map(async (transport, index) => {
      if (!transport || typeof transport.verify !== 'function') {
        return { index, ok: true };
      }
      try {
        await Promise.resolve(transport.verify());
        return { index, ok: true };
      } catch (error) {
        return { index, ok: false, error };
      }
    }));

    for (const r of results) {
      if (r.ok) {
        continue;
      }
      this.__unhealthyTransports.add(r.index);
      logError(`[mail-time] [verifyTransports] transport #${r.index} failed verification`, r.error);
      this.onError(r.error, null, { transportIndex: r.index, phase: 'verify' });
    }

    if (this.__unhealthyTransports.size === this.transports.length) {
      throw new Error(`[mail-time] [MailTime#ready] all ${this.transports.length} transport(s) failed verification — nothing can be delivered`);
    }

    if (this.__unhealthyTransports.has(this.transport)) {
      this.transport = this.___nextHealthyTransport(this.transport);
    }
  }

  /**
   * @internal
   * @memberOf MailTime
   * @name ___isHealthyTransport
   * @description Return true when the transport at `index` has not been marked unusable by verification.
   * @param {number} index
   * @returns {boolean}
   */
  ___isHealthyTransport(index) {
    return !this.__unhealthyTransports.has(index);
  }

  /**
   * @internal
   * @memberOf MailTime
   * @name ___nextHealthyTransport
   * @description Advance at least one position from `fromIdx` and return the next healthy transport index (wrapping). Falls back to `fromIdx` if no healthy transport exists.
   * @param {number} fromIdx
   * @returns {number}
   */
  ___nextHealthyTransport(fromIdx) {
    if (this.transports.length === 0) {
      return fromIdx;
    }
    let next = fromIdx;
    for (let i = 0; i < this.transports.length; i++) {
      next = (next + 1) % this.transports.length;
      if (this.___isHealthyTransport(next)) {
        return next;
      }
    }
    return fromIdx;
  }
}

exports.MailTime = MailTime;
exports.MongoQueue = MongoQueue;
exports.PostgresQueue = PostgresQueue;
exports.RedisQueue = RedisQueue;
exports.mailTimePreset = mailTimePreset;
exports.presetNames = presetNames;
exports.presets = presets;

'use strict';

const josk = require('josk');
const crypto = require('crypto');

const hasOwn = Object.prototype.hasOwnProperty;

/**
 * @name hasOwnProp - `Object.hasOwn` (ES2022) polyfill.
 * @function
 * @param {object} obj
 * @param {PropertyKey} key
 * @returns {boolean} `true` if the object has the property, `false` otherwise.
 */
const hasOwnProp = (obj, key) => hasOwn.call(obj, key);

/**
 * @name debug - Debug logging.
 * @function
 * @param {boolean} isDebug
 * @param {...any} args
 * @returns {void}
 */
const debug = (isDebug, ...args) => {
  if (isDebug) {
    console.info('[DEBUG] [mail-time]', `${new Date()}`, ...args);
  }
};

/**
 * @name logError - Error logging.
 * @function
 * @param {...any} args
 * @returns {void}
 */
const logError = (...args) => {
  console.error('[ERROR] [mail-time]', `${new Date()}`, ...args);
};

/**
 * @name isPlainObject - Check whether a value is a plain object (literal or `Object.create(null)`).
 * @function
 * @param {any} value
 * @returns {boolean} `true` for plain objects, `false` for `null`, arrays, class instances, and primitives.
 */
const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
};

/**
 * @name deepMerge - Minimal deep-merge sufficient for nodemailer-shaped mail options:
 * - plain objects merge key-by-key
 * - arrays concatenate
 * - other values (strings, numbers, Date, Buffer, streams, classes) replace
 * Source values override target values.
 * @function
 * @param {any} target - Base value; merged into a shallow clone when a plain object, otherwise ignored.
 * @param {any} source - Overriding value; returns `target` unchanged when not a plain object.
 * @returns {any} The merged result (a new object), or `target` when `source` is not a plain object.
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
 * @name equals - Order-insensitive deep equality. Treats arrays as multisets and
 * objects as unordered maps. Designed for the small `mailOptions`
 * shape used by MailTime's email concatenation dedup.
 * @function
 * @param {any} a
 * @param {any} b
 * @returns {boolean} `true` when `a` and `b` are deeply equal ignoring array/key order.
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
 * @name extractEmail - Extract the email part of a nodemailer-shaped recipient entry.
 * Accepts `'a@x.com'`, `'Name <a@x.com>'`, or `{ name, address }`.
 * @function
 * @param {string|{name?: string, address?: string}|null|undefined} entry
 * @returns {string|null} The address lowercased and trimmed, or `null` when none can be parsed.
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
 * @name toAddressList - Normalize a `to`/`cc`/`bcc` field into a flat list of lowercase addresses.
 * @function
 * @param {string|Array<string|{name?: string, address?: string}>|null|undefined} field
 * @returns {string[]} Flat list of parsed lowercase addresses; empty when `field` is falsy or unparseable.
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
 * @name filterAddressField - Remove entries whose extracted address is in `acceptedSet` from a
 * nodemailer `to`/`cc`/`bcc` field.
 * @function
 * @param {string|Array<string|{name?: string, address?: string}>|null|undefined} field
 * @param {Set<string>} acceptedSet - Lowercase addresses to drop.
 * @returns {string|Array|undefined} The filtered field, or `void 0` when the filtered array would be
 * empty or the single string is dropped. Returns `field` unchanged when `acceptedSet` is empty.
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

const HTML_ESCAPES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
};

/**
 * @name escapeHtml - Escape the five HTML-significant characters.
 * @function
 * @param {string} value
 * @returns {string} `value` safe to interpolate into HTML text or an attribute value.
 */
const escapeHtml = (value) => {
  return `${value}`.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
};

/**
 * @name isSendClaimUpdate - Detect an atomic send-claim update (`{ isSending: true, tries: N }`).
 * @function
 * @param {object} updateObj
 * @returns {boolean} `true` when `updateObj` claims a row for sending.
 */
const isSendClaimUpdate = (updateObj) => {
  return updateObj && updateObj.isSending === true && typeof updateObj.tries === 'number';
};

/**
 * @name isSendLeaseGuardedUpdate - Detect an update guarded by a send lease
 * (carries `leaseTries` and `leaseSendingAt`).
 * @function
 * @param {object} updateObj
 * @returns {boolean} `true` when both lease guard fields are present numbers.
 */
const isSendLeaseGuardedUpdate = (updateObj) => {
  return updateObj && typeof updateObj.leaseTries === 'number' && typeof updateObj.leaseSendingAt === 'number';
};

/**
 * @name isAppendMailOptionUpdate - Detect an update that appends a mail option (for email concatenation).
 * @function
 * @param {object} updateObj
 * @returns {boolean} `true` when `updateObj.appendMailOption` is set.
 */
const isAppendMailOptionUpdate = (updateObj) => {
  return updateObj && updateObj.appendMailOption !== void 0;
};

/**
 * @name stripInternalUpdateMeta - Strip MailTime-internal update keys before persisting to storage.
 * @function
 * @param {object} updateObj
 * @returns {object} A shallow clone without `leaseTries`, `leaseSendingAt`, and `appendMailOption`.
 */
const stripInternalUpdateMeta = (updateObj) => {
  const out = { ...updateObj };
  delete out.leaseTries;
  delete out.leaseSendingAt;
  delete out.appendMailOption;
  return out;
};

/**
 * @name isSendLeaseRemove - Detect a remove guarded by a send lease
 * (carries `leaseTries` and `leaseSendingAt`).
 * @function
 * @param {object} opts
 * @returns {boolean} `true` when both lease guard fields are present numbers.
 */
const isSendLeaseRemove = (opts) => {
  return opts && typeof opts.leaseTries === 'number' && typeof opts.leaseSendingAt === 'number';
};

const DEFAULT_PREFIX$2 = '';

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
    this.supportsRecipientPolicies = true;
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
      ensureIndex(this.collection, { isSettled: 1, isSent: 1, isFailed: 1, isCancelled: 1, to: 1, sendAt: 1 }, { name: 'mailtime_policy_pending_to_v1', background: false }),
      ensureIndex(this.collection, { isSettled: 1, isSent: 1, isFailed: 1, isCancelled: 1, isSending: 1, sendingAt: 1, sendAt: 1, tries: 1 }, { name: 'mailtime_policy_due_v1', background: false }),
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
        isSettled: { $ne: true },
        $and: [
          { $or: [{ isSending: { $ne: true } }, { sendingAt: { $lte: now - sendingTimeout } }] },
          { $or: [
            { tries: { $lt: this.mailTimeInstance.maxTries } },
            { recipientResults: { $type: 'array' }, isSending: true, sendingAt: { $lte: now - sendingTimeout } },
          ] },
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
          isSettled: 1,
          recipientResults: 1,
        },
      });

      if (limit > 0) {
        cursor.limit(limit);
      }

      try {
        while (!this.mailTimeInstance.___isStopped && await cursor.hasNext()) {
          await this.mailTimeInstance.___dispatch(await cursor.next());
        }
      } finally {
        await cursor.close().catch(() => {});
      }
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
      isSending: { $ne: true },
      isSettled: { $ne: true },
      recipientResults: { $exists: false },
      tries: { $lt: this.mailTimeInstance.maxTries },
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
        isSettled: 1,
        recipientResults: 1,
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
        isSettled: 1,
      },
    });

    if (!task || task.isSent === true || task.isCancelled === true || task.isSettled === true) {
      return false;
    }
    const query = { _id: task._id, isSent: false, isCancelled: false, isSettled: { $ne: true },
      $or: [{ recipientResults: { $exists: false } }, { isFailed: false }] };
    if (!this.mailTimeInstance.keepHistory) {
      return ((await this.collection.deleteOne(query))?.deletedCount || 0) >= 1;
    }
    const result = await this.collection.updateOne(query, { $set: { isCancelled: true } });
    return (result?.matchedCount || result?.modifiedCount || 0) >= 1;
  }

  /**
   * @async
   * @memberOf MongoQueue
   * @name remove
   * @description remove task from queue
   * @param task {object} - task's object
   * @param {{ leaseTries: number, leaseSendingAt: number }} [opts] - lease guard: only remove if this worker still holds the lease (tries + sendingAt match, row not cancelled/failed)
   * @returns {Promise<boolean>} returns `true` if removed or `false` if not found
   */
  async remove(task, opts) {
    this.__debug('[remove]', task?.uuid);
    if (!task || typeof task !== 'object') {
      return false;
    }
    this.__ensurePrefix();

    const query = { _id: task._id };
    if (isSendLeaseRemove(opts)) {
      query.isSent = false;
      query.isSettled = { $ne: true };
      query.tries = opts.leaseTries;
      query.isSending = true;
      query.sendingAt = opts.leaseSendingAt;
      query.isCancelled = false;
      query.isFailed = false;
    }

    const res = await this.collection.deleteOne(query);
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
    if ((hasOwnProp(updateObj, 'recipientResults') || hasOwnProp(updateObj, 'isSettled'))
      && !isSendClaimUpdate(updateObj) && !isSendLeaseGuardedUpdate(updateObj)) return false;

    if (isAppendMailOptionUpdate(updateObj)) {
      const res = await this.collection.updateOne({
        _id: task._id,
        isSent: false,
        isFailed: false,
        isCancelled: false,
        isSending: { $ne: true },
        isSettled: { $ne: true },
        recipientResults: { $exists: false },
      }, {
        $push: {
          mailOptions: updateObj.appendMailOption,
        },
      });
      return (res?.modifiedCount || 0) >= 1;
    }

    const query = {
      _id: task._id,
    };

    if (isSendClaimUpdate(updateObj)) {
      const now = typeof updateObj.sendingAt === 'number' ? updateObj.sendingAt : Date.now();
      const sendingTimeout = this.mailTimeInstance?.sendingTimeout || 300000;
      query.isSent = false;
      query.isFailed = false;
      query.isCancelled = false;
      query.isSettled = { $ne: true };
      query.tries = task.tries;
      query.$or = [
        { isSending: { $ne: true } },
        { sendingAt: { $lte: now - sendingTimeout } },
      ];
    } else if (isSendLeaseGuardedUpdate(updateObj)) {
      query.isSent = false;
      query.isSettled = { $ne: true };
      query.tries = updateObj.leaseTries;
      query.isSending = true;
      query.sendingAt = updateObj.leaseSendingAt;
      query.isCancelled = false;
      query.isFailed = false;
    }

    const res = await this.collection.updateOne(query, {
      $set: stripInternalUpdateMeta(updateObj),
    });
    if (isSendClaimUpdate(updateObj) || isSendLeaseGuardedUpdate(updateObj)) {
      return (res?.modifiedCount || res?.matchedCount || 0) >= 1;
    }
    return (res?.modifiedCount || 0) >= 1;
  }
}

/**
 * @typedef {object} RedisClient
 * @property {(key: string) => Promise<number>} exists
 * @property {(key: string) => Promise<string|null>} get
 * @property {(key: string, value: string, options?: object) => Promise<unknown>} set
 * @property {(key: string|string[]) => Promise<number>} del
 * @property {() => Promise<string>} [ping]
 * @property {() => unknown} [getRandomNode]
 * @property {(...args: any[]) => any} [nodeClient]
 * @property {(firstKey: string, isReadonly: boolean, args: string[]) => Promise<unknown>} [sendCommand]
 * @property {(options: object) => AsyncIterable<string|string[]>} [scanIterator]
 * @property {(key: string, field: string) => Promise<string|null|undefined>} [hGet]
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
const DEFAULT_PREFIX$1 = 'default';
const VALID_PREFIX = /^[A-Za-z0-9_\-:.]+$/;
const TAGGED_ITERATE_LIMIT = 100;
const clientTransactions = new WeakMap();

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
      if task.isSent or task.isFailed or task.isCancelled or task.isSettled then
        redis.call('ZREM', KEYS[2], uuid)
      elseif tonumber(task.tries or 0) >= maxTries and not (type(task.recipientResults) == 'table' and task.isSending) then
        redis.call('ZREM', KEYS[2], uuid)
      elseif task.isSending then
        local eligibleAt = tonumber(task.sendingAt or 0) + sendingTimeout
        if eligibleAt > now then
          redis.call('ZADD', KEYS[2], eligibleAt, uuid)
        else
          table.insert(tasks, payload)
        end
      elseif tonumber(task.sendAt or 0) <= now then
        table.insert(tasks, payload)
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
  if payload ~= ARGV[8] then return -1 end

  if mode == 'claim' then
    if task.isSent or task.isFailed or task.isCancelled or task.isSettled or tonumber(task.tries or 0) ~= expectedTries then
      return 0
    end
    if task.isSending and tonumber(task.sendingAt or 0) > now - sendingTimeout then
      return 0
    end
  elseif mode == 'lease' then
    if task.isSent or task.isSettled or task.isCancelled or task.isFailed or not task.isSending
      or tonumber(task.tries or 0) ~= expectedTries
      or tonumber(task.sendingAt or 0) ~= leaseSendingAt then
      return 0
    end
  end

  if mode == 'cancel' and (task.isSent or task.isSettled or task.isCancelled
    or (type(task.recipientResults) == 'table' and task.isFailed)) then
    return 0
  end
  for key, value in pairs(update) do
    task[key] = value
  end
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[9])

  if task.isSent or task.isFailed or task.isCancelled or task.isSettled then
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
  if task.isSending or task.isSent or task.isFailed or task.isCancelled or task.isSettled or type(task.recipientResults) == 'table' then
    return 0
  end
  if payload ~= ARGV[3] then return -1 end
  redis.call('HSET', KEYS[1], ARGV[1], ARGV[4])
  return 1
`;

const REMOVE_TAGGED_TASK_SCRIPT = `
  local payload = redis.call('HGET', KEYS[1], ARGV[1])
  if not payload then
    redis.call('ZREM', KEYS[2], ARGV[1])
    return 0
  end
  local task = cjson.decode(payload)
  if ARGV[2] == 'cancel' and (task.isSent or task.isSettled or task.isCancelled
    or (type(task.recipientResults) == 'table' and task.isFailed)) then return 0 end
  if ARGV[2] == 'lease' and (task.isSent or task.isSettled or task.isCancelled or task.isFailed or not task.isSending
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

const normalizePolicyArrays = (task) => {
  if (task.recipientResults && !Array.isArray(task.recipientResults) && Object.keys(task.recipientResults).length === 0) task.recipientResults = [];
  if (Array.isArray(task.recipientResults)) {
    for (const result of task.recipientResults) {
      for (const field of ['sources', 'reasons']) {
        if (result[field] && !Array.isArray(result[field]) && Object.keys(result[field]).length === 0) result[field] = [];
      }
    }
  }
  return task;
};

const sha1Hex = (string) => crypto.createHash('sha1').update(string).digest('hex');

const isNoScriptError = (error) => {
  return !!error && (error.code === 'NOSCRIPT' || (typeof error.message === 'string' && error.message.includes('NOSCRIPT')));
};

const canReleaseLease = (currentTask, updateObj) => {
  return currentTask
    && currentTask.tries === updateObj.leaseTries
    && currentTask.isSending === true
    && (typeof currentTask.sendingAt === 'number' ? currentTask.sendingAt : 0) === updateObj.leaseSendingAt
    && currentTask.isCancelled !== true
    && currentTask.isSent !== true
    && currentTask.isSettled !== true
    && currentTask.isFailed !== true;
};

const canClaimTask = (currentTask, task, now, sendingTimeout) => {
  if (!currentTask) {
    return false;
  }
  if (currentTask.isSent === true || currentTask.isFailed === true || currentTask.isCancelled === true || currentTask.isSettled === true) {
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
  if (candidate.isSent === true || candidate.isFailed === true || candidate.isCancelled === true || candidate.isSettled === true) {
    return false;
  }
  const tries = typeof candidate.tries === 'number' ? candidate.tries : 0;
  if (tries >= maxTries && !(Array.isArray(candidate.recipientResults) && candidate.isSending === true)) {
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
    this.supportsRecipientPolicies = true;
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
      this.__applyPrefix(this.mailTimeInstance?.prefix || DEFAULT_PREFIX$1);
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

    if (this.useHashTags && typeof this.client.nodeClient === 'function' && typeof this.client.sendCommand === 'function') {
      const key = options.keys[0];
      const args = [`${options.keys.length}`, ...options.keys, ...options.arguments];
      try {
        return await this.client.sendCommand(key, false, ['EVALSHA', sha, ...args]);
      } catch (error) {
        if (!isNoScriptError(error)) throw error;
      }
      return await this.client.sendCommand(key, false, ['EVAL', source, ...args]);
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
      const pingClient = typeof this.client.ping === 'function' ? this.client
        : await this.client.nodeClient(this.client.getRandomNode());
      const ping = await pingClient.ping();
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
        for (const value of candidates) {
          if (this.mailTimeInstance.___isStopped) {
            break;
          }
          const candidate = normalizePolicyArrays(typeof value === 'string' ? JSON.parse(value) : value);
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
          if (this.mailTimeInstance.___isStopped) {
            break outer;
          }
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
    if (!task || task.isSettled === true || task.recipientResults != null || task.isSent === true || task.isCancelled === true || task.isFailed === true || task.sendAt > sendAt || task.isSending === true || task.tries >= this.mailTimeInstance.maxTries) {
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
    return await this.__serialize(() => this.__cancel(uuid));
  }

  /** @internal */
  async __serialize(operation) {
    if (this.useHashTags) return await operation();
    const previous = clientTransactions.get(this.client) || Promise.resolve();
    const pending = previous.then(operation);
    const settled = pending.catch(() => void 0);
    clientTransactions.set(this.client, settled);
    try { return await pending; }
    finally { if (clientTransactions.get(this.client) === settled) clientTransactions.delete(this.client); }
  }

  /** @internal */
  async __cancel(uuid) {
    this.__debug('[cancel]', uuid);
    if (typeof uuid !== 'string') {
      return false;
    }

    this.__ensurePrefix();
    const atomic = typeof this.client.watch === 'function' && typeof this.client.multi === 'function';
    const letterKey = this.__getKey(uuid);
    try {
      if (!this.useHashTags && atomic) await this.client.watch(letterKey);
      const payload = this.useHashTags ? await this.client.hGet(this.lettersKey, uuid) : await this.client.get(letterKey);
      const task = payload ? JSON.parse(payload) : null;
      if (!task || task.isSent || task.isCancelled || task.isSettled || (task.recipientResults != null && task.isFailed)) return false;
      if (this.useHashTags) {
        const keys = [this.lettersKey, this.scheduleKey];
        if (task.to) keys.push(this.__getTaggedConcatKey(task.to), this.concatKeysKey);
        const keep = this.mailTimeInstance.keepHistory;
        const args = keep
          ? [uuid, JSON.stringify({ isCancelled: true }), 'cancel', `${Date.now()}`, `${this.mailTimeInstance.sendingTimeout || 300000}`, '0', '0', payload, JSON.stringify({ ...task, isCancelled: true })]
          : [uuid, 'cancel', '0', '0'];
        return Number(await this.__runScript(keep ? 'update' : 'remove', { keys, arguments: args })) >= 1;
      }
      if (!atomic) {
        if (task.recipientResults != null) return false;
        return this.mailTimeInstance.keepHistory ? await this.__update(task, { isCancelled: true }) : await this.__remove(task);
      }
      const multi = this.client.multi();
      if (this.mailTimeInstance.keepHistory) multi.set(letterKey, JSON.stringify({ ...task, isCancelled: true }));
      else multi.del(letterKey);
      multi.del(this.__getKey(uuid, 'sendat'));
      return (await multi.exec()) !== null;
    } catch (error) {
      logError('[cancel] storage error', error);
      return false;
    } finally {
      if (!this.useHashTags && atomic) await this.client.unwatch?.();
    }
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
    return await this.__serialize(() => this.__remove(task, opts));
  }

  /** @internal */
  async __remove(task, opts) {
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
          || currentTask.isSent === true
          || currentTask.isSettled === true
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
    return await this.__serialize(() => this.__update(task, updateObj));
  }

  /** @internal */
  async __update(task, updateObj) {
    this.__debug('[update]', task?.uuid);
    if (!task || typeof task !== 'object' || typeof task.uuid !== 'string' || !updateObj || typeof updateObj !== 'object') {
      return false;
    }

    const letterKey = this.__getKey(task.uuid, 'letter');
    const sendatKey = this.__getKey(task.uuid, 'sendat');
    const isClaim = isSendClaimUpdate(updateObj);
    const isAppend = isAppendMailOptionUpdate(updateObj);
    const isLeaseRelease = isSendLeaseGuardedUpdate(updateObj);
    if ((hasOwnProp(updateObj, 'recipientResults') || hasOwnProp(updateObj, 'isSettled')) && !isClaim && !isLeaseRelease) return false;
    const now = isClaim && typeof updateObj.sendingAt === 'number' ? updateObj.sendingAt : Date.now();
    const sendingTimeout = this.mailTimeInstance?.sendingTimeout || 300000;

    try {
      if (this.useHashTags) {
        // JS serialization preserves empty arrays and scalar values that Lua cjson changes.
        // The script compares the exact payload as well as the claim/lease predicates.
        for (let attempt = 0; attempt < 3; attempt++) {
          const payload = await this.client.hGet(this.lettersKey, task.uuid);
          if (!payload) return false;
          const current = normalizePolicyArrays(JSON.parse(payload));
          const persist = stripInternalUpdateMeta(updateObj);
          const next = isAppend
            ? { ...current, mailOptions: [...(current.mailOptions || []), updateObj.appendMailOption] }
            : { ...current, ...persist };
          if (isAppend) {
            const result = Number(await this.__runScript('append', {
              keys: [this.lettersKey],
              arguments: [task.uuid, JSON.stringify(updateObj.appendMailOption), payload, JSON.stringify(next)],
            }));
            if (result === -1) continue;
            return result >= 1;
          }
          const keys = [this.lettersKey, this.scheduleKey];
          if (current.to) keys.push(this.__getTaggedConcatKey(current.to), this.concatKeysKey);
          const result = Number(await this.__runScript('update', {
            keys,
            arguments: [task.uuid, JSON.stringify(persist), isClaim ? 'claim' : (isLeaseRelease ? 'lease' : 'plain'),
              `${now}`, `${sendingTimeout}`, `${isClaim ? task.tries : (updateObj.leaseTries || 0)}`,
              `${updateObj.leaseSendingAt || 0}`, payload, JSON.stringify(next)],
          }));
          if (result !== -1) return result >= 1;
        }
        return false;
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
          if (currentTask.isSending === true || currentTask.isSent === true || currentTask.isFailed === true || currentTask.isCancelled === true || currentTask.isSettled === true || Array.isArray(currentTask.recipientResults)) {
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
        if (currentTask.isSending === true || currentTask.isSent === true || currentTask.isFailed === true || currentTask.isCancelled === true || currentTask.isSettled === true || Array.isArray(currentTask.recipientResults)) {
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
        if (updatedTask.isSent === true || updatedTask.isFailed === true || updatedTask.isCancelled === true || updatedTask.isSettled === true) {
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

      if (updatedTask.isSent === true || updatedTask.isFailed === true || updatedTask.isCancelled === true || updatedTask.isSettled === true) {
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

// Two-key advisory lock, mirroring josk's PostgresAdapter: a stable MailTime namespace
// plus a per-prefix hash. `pg_advisory_lock(int4, int4)` lives in its own keyspace, isolated
// from single-int callers in the same database; distinct prefixes get distinct lock IDs, so
// co-tenant MailTime queues no longer serialize each other's schema setup.
const ADVISORY_LOCK_NAMESPACE = 0x4D61696C; // 'Mail' in ASCII as int32

/**
 * @internal
 * @param {string} prefix
 * @returns {number} signed int32 hash of the prefix string
 */
const advisoryLockKeyFor = (prefix) => {
  return crypto.createHash('sha256').update(prefix).digest().readInt32BE(0);
};

const fieldMap = {
  to: 'to_address',
  tries: 'tries',
  sendAt: 'send_at',
  isSent: 'is_sent',
  isSettled: 'is_settled',
  recipientResults: 'recipient_results',
  isCancelled: 'is_cancelled',
  isFailed: 'is_failed',
  isSending: 'is_sending',
  sendingAt: 'sending_at',
  template: 'template',
  transport: 'transport',
  concatSubject: 'concat_subject',
  mailOptions: 'mail_options',
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
    isSettled: row.is_settled === true,
    recipientResults: row.recipient_results == null ? void 0 : parseMailOptions(row.recipient_results),
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
    this.supportsRecipientPolicies = true;
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
    const advisoryLockKey = advisoryLockKeyFor(this.prefix);
    await this.client.query('SELECT pg_advisory_lock($1, $2)', [ADVISORY_LOCK_NAMESPACE, advisoryLockKey]);

    try {
      await this.client.query(`CREATE TABLE IF NOT EXISTS mail_time_queue (
          id BIGSERIAL PRIMARY KEY,
          prefix TEXT NOT NULL DEFAULT 'default',
          uuid TEXT NOT NULL,
          to_address TEXT,
          tries INTEGER NOT NULL DEFAULT 0,
          send_at BIGINT NOT NULL,
          is_sent BOOLEAN NOT NULL DEFAULT false,
          is_settled BOOLEAN NOT NULL DEFAULT false,
          recipient_results JSONB,
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
      await this.client.query('ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS is_settled BOOLEAN NOT NULL DEFAULT false');
      await this.client.query('ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS recipient_results JSONB');
      await this.client.query(`CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_time_queue_prefix_uuid
        ON mail_time_queue (prefix, uuid)`);

      await this.client.query(`CREATE INDEX IF NOT EXISTS idx_mail_time_queue_policy_due_v1
        ON mail_time_queue (prefix, is_settled, is_sent, is_failed, is_cancelled, is_sending, sending_at, send_at, tries)`);

      await this.client.query(`CREATE INDEX IF NOT EXISTS idx_mail_time_queue_policy_pending_to_v1
        ON mail_time_queue (prefix, to_address, is_settled, is_sent, is_failed, is_cancelled, send_at)`);
    } finally {
      await this.client.query('SELECT pg_advisory_unlock($1, $2)', [ADVISORY_LOCK_NAMESPACE, advisoryLockKey]);
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
               is_sending, sending_at, template, transport, concat_subject, mail_options, is_settled, recipient_results
        FROM mail_time_queue
        WHERE prefix = $1
          AND is_sent = false
          AND is_failed = false
          AND is_cancelled = false
          AND is_settled = false
          AND send_at <= $2
          AND (tries < $3 OR (recipient_results IS NOT NULL AND is_sending = true AND sending_at <= $4))
          AND (is_sending = false OR sending_at <= $4)
        ORDER BY send_at ASC
        LIMIT $5`, [this.prefix, now, this.mailTimeInstance.maxTries, now - sendingTimeout, limit]);

      for (const row of res.rows || []) {
        if (this.mailTimeInstance.___isStopped) {
          break;
        }
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
             is_sending, sending_at, template, transport, concat_subject, mail_options, is_settled, recipient_results
      FROM mail_time_queue
      WHERE prefix = $1
        AND to_address = $2
        AND is_sent = false
        AND is_failed = false
        AND is_cancelled = false
        AND is_sending = false
        AND is_settled = false
        AND recipient_results IS NULL
        AND tries < $4
        AND send_at <= $3
      ORDER BY send_at DESC
      LIMIT 1`, [this.prefix, to, sendAt, this.mailTimeInstance.maxTries]);

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
        is_sending, sending_at, template, transport, concat_subject, mail_options, is_settled, recipient_results, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
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
        is_settled = EXCLUDED.is_settled,
        recipient_results = EXCLUDED.recipient_results,
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
      task.isSettled === true,
      task.recipientResults === void 0 ? null : JSON.stringify(task.recipientResults),
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
             template, transport, concat_subject, mail_options, is_settled, recipient_results
      FROM mail_time_queue
      WHERE prefix = $1
        AND uuid = $2
      LIMIT 1`, [this.prefix, uuid])).rows?.[0]);

    if (!task || task.isSent === true || task.isCancelled === true || task.isSettled === true) return false;
    const operation = this.mailTimeInstance.keepHistory
      ? 'UPDATE mail_time_queue SET is_cancelled = true, updated_at = CURRENT_TIMESTAMP'
      : 'DELETE FROM mail_time_queue';
    const result = await this.client.query(`${operation}
      WHERE prefix = $1 AND uuid = $2 AND is_sent = false AND is_cancelled = false
        AND is_settled = false AND (recipient_results IS NULL OR is_failed = false)`, [this.prefix, uuid]);
    return (result.rowCount || 0) >= 1;
  }

  /**
   * @async
   * @memberOf PostgresQueue
   * @name remove
   * @description remove task from queue
   * @param task {object} - task's object
   * @param {{ leaseTries: number, leaseSendingAt: number }} [opts] - lease guard: only remove if this worker still holds the lease (tries + sendingAt match, row not cancelled/failed)
   * @returns {Promise<boolean>} returns `true` if removed or `false` if not found
   */
  async remove(task, opts) {
    this.__debug('[remove]', task?.uuid);
    if (!task || typeof task !== 'object') {
      return false;
    }

    await this.ready();

    const where = task.id ? 'id = $2' : 'uuid = $2';
    const value = task.id || task.uuid;
    let leaseWhere = '';
    const params = [this.prefix, value];
    if (isSendLeaseRemove(opts)) {
      params.push(opts.leaseTries, opts.leaseSendingAt);
      leaseWhere = ` AND tries = $3 AND is_sending = true AND sending_at = $4 AND is_cancelled = false AND is_failed = false AND is_sent = false AND is_settled = false`;
    }

    const res = await this.client.query(`DELETE FROM mail_time_queue
      WHERE prefix = $1
        AND ${where}${leaseWhere}`, params);
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
    if ((hasOwnProp(updateObj, 'recipientResults') || hasOwnProp(updateObj, 'isSettled'))
      && !isSendClaimUpdate(updateObj) && !isSendLeaseGuardedUpdate(updateObj)) return false;

    if (isAppendMailOptionUpdate(updateObj)) {
      const where = task.id ? 'id = $3' : 'uuid = $3';
      const value = task.id || task.uuid;
      const res = await this.client.query(`UPDATE mail_time_queue
        SET mail_options = mail_options || $1::jsonb,
            updated_at = CURRENT_TIMESTAMP
        WHERE prefix = $2
          AND ${where}
          AND is_sent = false
          AND is_failed = false
          AND is_cancelled = false
          AND is_sending = false
          AND is_settled = false
          AND recipient_results IS NULL`, [
        JSON.stringify([updateObj.appendMailOption]),
        this.prefix,
        value,
      ]);
      return (res.rowCount || 0) >= 1;
    }

    const persistObj = stripInternalUpdateMeta(updateObj);
    const sets = [];
    const values = [];
    for (const key of Object.keys(persistObj)) {
      if (!fieldMap[key]) {
        continue;
      }

      let value = persistObj[key];
      if (key === 'sendAt' && value instanceof Date) {
        value = +value;
      }
      if (key === 'mailOptions' || key === 'recipientResults') {
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
        AND is_settled = false
        AND tries = $${triesIndex}
        AND (is_sending = false OR sending_at <= $${staleIndex})
      `;
    } else if (isSendLeaseGuardedUpdate(updateObj)) {
      values.push(updateObj.leaseTries);
      const triesIndex = values.length;
      values.push(updateObj.leaseSendingAt);
      const sendingAtIndex = values.length;
      claimWhere = `
        AND is_sent = false
        AND is_settled = false
        AND tries = $${triesIndex}
        AND is_sending = true
        AND sending_at = $${sendingAtIndex}
        AND is_cancelled = false
        AND is_failed = false
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
 * @property {(error: unknown, email: any, details?: object) => void} [onError]
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
    retryDelay: 10000,
    mode: 'batch',
    concurrency: 1,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      zombieTime: 120000,
    }),
  }),
  otp: Object.freeze({
    concatEmails: false,
    retries: 5,
    retryDelay: 2000,
    revolvingInterval: 1024,
    sendingTimeout: 120000,
    mode: 'batch',
    concurrency: 4,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      minRevolvingDelay: 256,
      maxRevolvingDelay: 1024,
      zombieTime: 60000,
    }),
  }),
  newsletter: Object.freeze({
    concatEmails: true,
    concatDelay: 5 * 60000,
    concatSubject: 'Your updates',
    retries: 5,
    retryDelay: 60000,
    sendingTimeout: 600000,
    mode: 'batch',
    concurrency: 2,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      zombieTime: 300000,
    }),
  }),
  marketing: Object.freeze({
    concatEmails: false,
    retries: 10,
    retryDelay: 30000,
    mode: 'batch',
    concurrency: 5,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      zombieTime: 180000,
    }),
  }),
  notifications: Object.freeze({
    concatEmails: true,
    concatDelay: 60000,
    concatSubject: 'New activity',
    retries: 8,
    retryDelay: 30000,
    mode: 'batch',
    concurrency: 3,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      zombieTime: 180000,
    }),
  }),
  alerts: Object.freeze({
    concatEmails: false,
    retries: 20,
    retryDelay: 5000,
    revolvingInterval: 1024,
    sendingTimeout: 120000,
    mode: 'batch',
    concurrency: 2,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      minRevolvingDelay: 256,
      maxRevolvingDelay: 1024,
      zombieTime: 60000,
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
 * @returns {MailTimePresetConfig} fresh, mutable MailTime constructor options (preset deep-cloned + overrides merged)
 * @throws {Error} when `name` is unknown
 * @throws {TypeError} when `overrides` is provided but not a plain object
 */
const mailTimePreset = (name, overrides) => {
  if (typeof name !== 'string' || !hasOwnProp(PRESETS, name)) {
    throw new Error(`[mail-time] [mailTimePreset] unknown preset "${name}". Available: ${presetNames.join(', ')}`);
  }
  if (overrides !== void 0 && !isPlainObject(overrides)) {
    throw new TypeError('[mail-time] [mailTimePreset] {overrides} must be a plain object when provided');
  }
  const cloned = deepMerge({}, PRESETS[name]);
  return overrides ? deepMerge(cloned, overrides) : cloned;
};

const policyError = (message) => new Error(`[mail-time] [recipientPolicies] ${message}`);
const SIMPLE_MAILBOX = /^[^\s<>,;:"()\\\[\]@]+@[^\s<>,;:"()\\\[\]@]+$/u;
// RFC 5322 specials that are unambiguous only inside a quoted display name.
const PHRASE_SPECIALS = '<>()[]:;@\\,';
const UNSAFE_CHARS = /[\r\n\u0000]/u;

/**
 * Error for an address that cannot be parsed into exactly one mailbox. The message names
 * the field and the rule that failed, never the address or display name itself.
 */
const addressError = (field, reason) => {
  const error = policyError(`\`${field}\` ${reason}`);
  error.code = 'MAIL_TIME_INVALID_ADDRESS';
  error.field = field;
  return error;
};

const isAddressError = (error) => error?.code === 'MAIL_TIME_INVALID_ADDRESS';

const toMailbox = (address, field) => {
  const trimmed = address.trim();
  if (!SIMPLE_MAILBOX.test(trimmed)) throw addressError(field, 'must contain one address such as user@example.com; quoted local parts are not supported');
  return trimmed.toLowerCase();
};

/**
 * Parse one Nodemailer mailbox string: `addr`, `<addr>`, or `display name <addr>`, where the
 * display name is any mix of atoms and quoted strings with backslash escapes. Groups,
 * comments, and comma-separated lists are rejected rather than guessed at.
 */
const parseMailboxString = (input, field) => {
  let display = '';
  let angle = null;
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '\\') {
        if (++i >= input.length) break;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === '<') {
      const close = input.indexOf('>', i + 1);
      if (close === -1) throw addressError(field, 'has an unclosed angle bracket');
      angle = input.slice(i + 1, close);
      if (input.slice(close + 1).trim()) throw addressError(field, 'must end after the angle-bracket address; use an array for multiple recipients');
      break;
    } else if (char === ',') {
      throw addressError(field, 'must contain one mailbox; use an array for multiple recipients or quote a display name that contains a comma');
    } else if (char === ';' || char === ':') {
      throw addressError(field, 'must not use group syntax');
    } else if (char === '(' || char === ')') {
      throw addressError(field, 'must not contain comments; quote a display name that contains parentheses');
    } else {
      display += char;
    }
  }
  if (quoted) throw addressError(field, 'has an unterminated quoted display name');
  if (angle === null) {
    if (display !== input) throw addressError(field, 'must contain one address such as user@example.com; quoted local parts are not supported');
    return toMailbox(input, field);
  }
  for (const char of display) {
    if (PHRASE_SPECIALS.includes(char)) throw addressError(field, 'has an unquoted special character in its display name; wrap the name in double quotes');
  }
  return toMailbox(angle, field);
};

/**
 * Normalize exactly one mailbox (string or `{ name?, address }`) to its lowercase address.
 * @param {unknown} value
 * @param {string} [field] - Field label used in errors, e.g. `to[1]` or `envelope.from`.
 * @returns {string}
 */
const normalizePolicyAddress = (value, field = 'address') => {
  if (typeof value === 'string') {
    if (UNSAFE_CHARS.test(value)) throw addressError(field, 'must not contain line breaks or NUL characters');
    if (!value.trim()) throw addressError(field, 'must not be empty');
    return parseMailboxString(value.trim(), field);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw addressError(field, 'must be an address string or a { name, address } object');
  if (typeof value.address !== 'string') throw addressError(field, 'object requires a string `address`');
  if (value.name !== void 0 && typeof value.name !== 'string') throw addressError(field, 'object `name` must be a string');
  if (UNSAFE_CHARS.test(value.address) || (value.name && UNSAFE_CHARS.test(value.name))) {
    throw addressError(field, 'must not contain line breaks or NUL characters');
  }
  return toMailbox(value.address, field);
};

const preparePolicyEnvelope = (compiled, previousResults = []) => {
  const recipients = new Map();
  const explicit = compiled.envelope && hasOwnProp(compiled.envelope, 'to');
  const add = (value, source, authoritative, label = source) => {
    const list = Array.isArray(value);
    const entries = list ? value : [value];
    for (let i = 0; i < entries.length; i++) {
      let address;
      try { address = normalizePolicyAddress(entries[i], list ? `${label}[${i}]` : label); }
      catch (error) { if (authoritative) throw error; else continue; }
      if (!recipients.has(address)) {
        if (!authoritative) continue;
        recipients.set(address, { address, sources: [] });
      }
      const sources = recipients.get(address).sources;
      if (!sources.includes(source)) sources.push(source);
    }
  };
  if (explicit) add(compiled.envelope.to, 'envelope', true, 'envelope.to');
  for (const source of ['to', 'cc', 'bcc']) {
    if (hasOwnProp(compiled, source) && compiled[source] !== void 0) add(compiled[source], source, !explicit);
  }
  if (!recipients.size) throw policyError('envelope must contain at least one recipient');
  if (previousResults.length && (previousResults.length !== recipients.size || previousResults.some((r) => !recipients.has(r.address)))) {
    throw policyError('envelope recipient set changed between attempts');
  }
  const envelope = { to: [...recipients.keys()] };
  if (compiled.envelope && hasOwnProp(compiled.envelope, 'from')) {
    envelope.from = compiled.envelope.from === '' ? '' : normalizePolicyAddress(compiled.envelope.from, 'envelope.from');
  } else {
    // Same precedence as Nodemailer's getEnvelope(): From, then Sender, then Reply-To.
    const field = ['from', 'sender', 'replyTo'].find((key) => compiled[key]);
    if (field) envelope.from = normalizePolicyAddress(compiled[field], field);
  }
  return { envelope, recipients: [...recipients.values()] };
};

const validateRecipientPolicies = (value, queue) => {
  if (value === void 0) return null;
  if (!Array.isArray(value) || !value.length) throw policyError('recipientPolicies must be a nonempty array');
  if (queue.supportsRecipientPolicies !== true) throw policyError('queue must declare recipient policy support');
  const names = new Set();
  return value.map((provider) => {
    if (!isPlainObject(provider)) throw policyError('each provider must be a plain object');
    const name = typeof provider.name === 'string' ? provider.name.trim() : '';
    if (!name || name.length > 128 || names.has(name)) throw policyError('provider names must be unique and contain 1-128 characters');
    names.add(name);
    const failureMode = provider.failureMode === void 0 ? 'retry' : provider.failureMode;
    if (failureMode !== 'retry' && failureMode !== 'continue') throw policyError('failureMode must be retry or continue');
    const normalized = { name, failureMode };
    let count = 0;
    for (const hook of ['beforeSend', 'classifyRejections', 'observeAttempt']) {
      if (hasOwnProp(provider, hook)) {
        if (typeof provider[hook] !== 'function') throw policyError(`${hook} must be a function`);
        normalized[hook] = provider[hook].bind(provider);
        count++;
      }
    }
    if (!count) throw policyError('provider requires at least one supported hook');
    return normalized;
  });
};

const validatePolicyResult = (raw, hook, context) => {
  if (raw === void 0) return [];
  if (!isPlainObject(raw)) throw policyError('hook must return a result object or nothing');
  if (raw.decisions === void 0) return [];
  if (!Array.isArray(raw.decisions)) throw policyError('decisions must be an array');
  const batch = new Set(context.recipients.map((r) => r.address));
  const attributable = new Set((context.rejections || []).map((r) => r.address).filter(Boolean));
  const decisions = new Map();
  for (const item of raw.decisions) {
    if (!isPlainObject(item)) throw policyError('decision must be an object');
    const address = normalizePolicyAddress(item.address, 'decision.address');
    if (!batch.has(address)) throw policyError('decision address is outside the input batch');
    const allowed = hook === 'beforeSend' ? item.status === 'suppressed' : (item.status === 'retry' || item.status === 'rejected');
    if (!allowed) throw policyError('invalid decision status for this phase');
    if (item.status === 'rejected' && !attributable.has(address)) throw policyError('permanent rejection requires an attributable record');
    if (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 512) throw policyError('reason must contain 1-512 characters');
    const previous = decisions.get(address);
    if (previous && (previous.status !== item.status || previous.reason !== item.reason)) throw policyError('conflicting duplicate decisions');
    decisions.set(address, { address, status: item.status, reason: item.reason });
  }
  return [...decisions.values()];
};

const evaluatePolicyPhase = async (providers, hook, context, report) => {
  const decisions = [];
  let retryFailure = false;
  for (const provider of providers) {
    if (typeof provider[hook] !== 'function') continue;
    try {
      const validated = validatePolicyResult(await provider[hook](context), hook, context);
      for (const decision of validated) decisions.push({ ...decision, provider: provider.name });
    } catch (error) {
      report(error, provider.name, hook);
      if (provider.failureMode !== 'continue') retryFailure = true;
    }
  }
  return { retryFailure, decisions };
};

const mergePolicyResults = (previous, recipients, evaluated, details) => {
  const results = new Map(previous.map((r) => [r.address, r]));
  const accepted = new Set(details.accepted || []);
  const decisions = new Map();
  for (const decision of evaluated.decisions) {
    if (!decisions.has(decision.address)) decisions.set(decision.address, []);
    decisions.get(decision.address).push(decision);
  }
  const diagnostics = new Map();
  for (const record of details.rejections || []) {
    if (record.address && !diagnostics.has(record.address)) diagnostics.set(record.address, record);
  }
  for (const recipient of recipients) {
    const prior = results.get(recipient.address);
    if (prior && prior.status !== 'error') continue;
    const candidates = decisions.get(recipient.address) || [];
    const terminal = details.phase === 'beforeSend' ? 'suppressed' : 'rejected';
    let status = 'error';
    if (accepted.has(recipient.address)) status = 'sent';
    else if (!evaluated.retryFailure && candidates.some((d) => d.status === terminal)) status = terminal;
    const reasons = [];
    if (!evaluated.retryFailure && status !== 'sent') {
      for (const candidate of candidates) {
        if (candidate.status === (status === 'error' ? 'retry' : status)) reasons.push({ provider: candidate.provider, reason: candidate.reason });
      }
    }
    const result = { address: recipient.address, status, sources: [...recipient.sources], reasons, attempt: details.attempt, transportIndex: details.transportIndex };
    if (typeof details.transportName === 'string') result.transportName = details.transportName.slice(0, 128);
    const record = diagnostics.get(recipient.address);
    if (record) {
      for (const key of ['command', 'response', 'message']) {
        if (typeof record[key] === 'string') result[key] = record[key].slice(0, 2048);
      }
      if (Number.isFinite(record.responseCode)) result.responseCode = record.responseCode;
    }
    results.set(recipient.address, result);
  }
  return [...results.values()];
};

const summarizePolicyTask = (task, isSettled) => {
  const recipients = { sent: [], error: [], suppressed: [], rejected: [] };
  for (const result of task.recipientResults || []) recipients[result.status].push(result);
  return { uuid: task.uuid, tries: task.tries, isSettled, recipients };
};

const diagnosticFields = (record) => {
  const result = {};
  for (const key of ['command', 'response', 'message']) {
    if (typeof record?.[key] === 'string') result[key] = record[key].slice(0, 2048);
  }
  if (Number.isFinite(record?.responseCode)) result.responseCode = record.responseCode;
  return result;
};

const normalizeRejections = (error, info, transport) => {
  const records = [];
  const ancestors = new WeakSet();
  const addressOf = (value) => {
    try { return normalizePolicyAddress(value); }
    catch { return null; }
  };
  const append = (node, address) => {
    const record = { address, ...diagnosticFields(node), transportIndex: transport.index };
    if (typeof transport.name === 'string') record.transportName = transport.name.slice(0, 128);
    if (typeof node === 'string') record.message = node.slice(0, 2048);
    records.push(record);
  };
  const visit = (node, positional = null, root = false, errorRoot = false) => {
    if (node === null || node === void 0) {
      if (!root) append(node, positional);
      return;
    }
    if (typeof node !== 'object') {
      append(node, positional);
      return;
    }
    if (ancestors.has(node)) return;
    ancestors.add(node);
    const start = records.length;
    const rejected = Array.isArray(node.rejected) ? node.rejected.map(addressOf) : [];
    for (const key of ['errors', 'rejectedErrors']) {
      if (Array.isArray(node[key])) {
        for (let i = 0; i < node[key].length; i++) visit(node[key][i], rejected[i] || null);
      }
    }
    if (records.length === start) {
      let address = positional;
      for (const key of ['recipient', 'address', 'to']) {
        if (hasOwnProp(node, key)) { address = addressOf(node[key]); break; }
      }
      if (!root || errorRoot || address || Object.keys(diagnosticFields(node)).length) append(node, address);
    }
    const attributed = new Set(records.slice(start).map((r) => r.address));
    for (const address of rejected) {
      if (address && !attributed.has(address)) append({ message: 'Recipient rejected by transport' }, address);
    }
    ancestors.delete(node);
  };
  visit(error, null, true, true);
  visit(info, null, true);
  return records;
};

class RecipientPolicyLease {
  constructor({ task, queue, interval, maxRenewals, shouldAbort, report }) {
    this.__task = task;
    this.__queue = queue;
    this.__shouldAbort = shouldAbort;
    this.__report = report;
    this.__closed = false;
    this.__finishing = false;
    this.__tail = Promise.resolve();
    this.__timer = null;
    let pending = false;
    let renewals = 0;
    if (interval && maxRenewals) {
      this.__timer = setInterval(() => {
        if (!this.active || this.__finishing || renewals >= maxRenewals) {
          this.__clearTimer();
          return;
        }
        if (pending) return;
        pending = true;
        renewals++;
        this.__enqueue(async (guard) => {
          const fields = { isSending: true, sendingAt: Math.max(Date.now(), this.__task.sendingAt + 1) };
          return await this.__write(fields, guard);
        }).finally(() => { pending = false; });
      }, interval);
      this.__timer.unref?.();
    }
  }

  get active() { return !this.__closed && !this.__shouldAbort(); }

  __clearTimer() {
    if (this.__timer) clearInterval(this.__timer);
    this.__timer = null;
  }

  __halt() {
    this.__clearTimer();
    this.__closed = true;
  }

  __enqueue(operation) {
    const pending = this.__tail.then(async () => {
      if (!this.active) return false;
      const guard = { leaseTries: this.__task.tries, leaseSendingAt: this.__task.sendingAt };
      try {
        const ok = await operation(guard);
        if (!ok) this.__halt();
        return ok;
      } catch (error) {
        this.__halt();
        if (!this.__shouldAbort()) this.__report(error);
        return false;
      }
    });
    this.__tail = pending.then(() => void 0);
    return pending;
  }

  async __write(fields, guard) {
    const ok = await this.__queue.update(this.__task, { ...fields, ...guard });
    if (ok) Object.assign(this.__task, fields);
    return ok;
  }

  update(fields) {
    if (this.__finishing) return Promise.resolve(false);
    return this.__enqueue((guard) => this.__write(fields, guard));
  }

  finish(fields, remove) {
    if (this.__finishing) return Promise.resolve(false);
    this.__finishing = true;
    this.__clearTimer();
    return this.__enqueue(async (guard) => {
      const ok = remove ? await this.__queue.remove(this.__task, guard) : await this.__queue.update(this.__task, { ...fields, ...guard });
      if (ok) Object.assign(this.__task, fields);
      this.__halt();
      return ok;
    });
  }

  async stop() {
    this.__halt();
    await this.__tail;
  }
}

const noop = () => {};
const queueMethods = ['ping', 'iterate', 'getPendingTo', 'push', 'remove', 'update', 'cancel'];

const callHook = (name, callback, ...args) => {
  try {
    const result = callback(...args);
    if (result && typeof result.then === 'function') {
      Promise.resolve(result).catch((hookError) => {
        logError(`[${name}] callback failed`, hookError);
      });
    }
  } catch (hookError) {
    logError(`[${name}] callback failed`, hookError);
  }
};

/**
 * Floor below which `sendingTimeout` is likely shorter than a real SMTP roundtrip
 * (connect + greeting + STARTTLS + envelope + DATA, times MX rollover). A claim that
 * expires mid-send is re-claimed by a peer, which delivers the same letter twice.
 */
const MIN_SAFE_SENDING_TIMEOUT = 120000;
const DEFAULT_MAX_RENEWALS = 10;

/**
 * Fields a queued task may set under `{strictPayload: true}`. Everything else —
 * `attachments`, `envelope`, `dkim`, `raw`, `icalEvent`, … — is dropped, because a
 * process with queue-write access would otherwise inherit nodemailer's whole
 * capability surface (local file read, URL fetch, sender/DKIM override).
 */
const STRICT_MAIL_FIELDS = [
  'to',
  'cc',
  'bcc',
  'replyTo',
  'subject',
  'text',
  'html',
  'headers',
  'list',
  'priority',
  'encoding',
  'textEncoding',
  'inReplyTo',
  'references',
  'date',
];

const __withLease = (task, updateObj) => {
  if (task?.isSending === true && typeof task.tries === 'number' && typeof task.sendingAt === 'number') {
    return { ...updateObj, leaseTries: task.tries, leaseSendingAt: task.sendingAt };
  }
  return updateObj;
};

const __leaseRemoveOpts = (task) => {
  if (task?.isSending === true && typeof task.tries === 'number' && typeof task.sendingAt === 'number') {
    return { leaseTries: task.tries, leaseSendingAt: task.sendingAt };
  }
  return void 0;
};

const createPool = (concurrency) => {
  const limit = Math.max(1, concurrency | 0);
  const queue = [];
  let active = 0;
  let drainResolvers = [];

  const settleDrain = () => {
    if (active === 0 && queue.length === 0 && drainResolvers.length > 0) {
      const resolvers = drainResolvers;
      drainResolvers = [];
      for (const r of resolvers) r();
    }
  };

  const tryStart = () => {
    while (active < limit && queue.length > 0) {
      const job = queue.shift();
      active++;
      job.resolveSlot(true);
      Promise.resolve()
        .then(job.fn)
        .catch((poolError) => {
          logError('[pool] unhandled send error', poolError);
        })
        .finally(() => {
          active--;
          settleDrain();
          tryStart();
        });
    }
  };

  return {
    /**
     * Queue `fn` for execution under the concurrency limit.
     * The returned Promise resolves `true` as soon as a slot is acquired and `fn` has started,
     * or `false` if `cancelQueued()` dropped the job before it started (`fn` never runs).
     * It does NOT wait for `fn` to finish. Use `drain()` to wait for all running jobs to settle.
     * @param {() => Promise<void>} fn
     * @returns {Promise<boolean>}
     */
    dispatch(fn) {
      return new Promise((resolveSlot) => {
        queue.push({ fn, resolveSlot });
        tryStart();
      });
    },
    /**
     * Drop every job still waiting for a slot. Running jobs are untouched.
     * @returns {number} dropped jobs
     */
    cancelQueued() {
      const dropped = queue.splice(0);
      for (const job of dropped) job.resolveSlot(false);
      settleDrain();
      return dropped.length;
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

let DEFAULT_TEMPLATE = '<!DOCTYPE html><html xmlns=http://www.w3.org/1999/xhtml><meta content="text/html; charset=utf-8"http-equiv=Content-Type><meta content="width=device-width,initial-scale=1"name=viewport><title>{{subject}}</title><style>body{-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:none;font-family:Tiempos,Georgia,Times,serif;font-weight:400;width:100%;height:100%;background:#fff;font-size:15px;color:#000;line-height:1.5}a{text-decoration:underline;border:0;color:#000;outline:0;color:inherit}a:hover{text-decoration:none}a[href^=sms],a[href^=tel]{text-decoration:none;color:#000;cursor:default}a img{border:none;text-decoration:none}td{font-family:Tiempos,Georgia,Times,serif;font-weight:400}hr{height:1px;border:none;width:100%;margin:0;margin-top:25px;margin-bottom:25px;background-color:#ECECEC}h1,h2,h3,h4,h5,h6{font-family:HelveticaNeue,"Helvetica Neue",Helvetica,Arial,sans-serif;font-weight:300;line-height:normal;margin-top:35px;margin-bottom:4px;margin-left:0;margin-right:0}h1{margin:23px 15px;font-size:25px}h2{margin-top:15px;font-size:21px}h3{font-weight:400;font-size:19px;border-bottom:1px solid #ECECEC}h4{font-weight:400;font-size:18px}h5{font-weight:400;font-size:17px}h6{font-weight:600;font-size:16px}h1 a,h2 a,h3 a,h4 a,h5 a,h6 a{text-decoration:none}pre{font-family:Consolas,Menlo,Monaco,Lucida Console,Liberation Mono,DejaVu Sans Mono,Bitstream Vera Sans Mono,Courier New,monospace,sans-serif;display:block;font-size:13px;padding:9.5px;margin:0 0 10px;line-height:1.42;color:#333;word-break:break-all;word-wrap:break-word;background-color:#f5f5f5;border:1px solid #ccc;border-radius:4px;text-align:left!important;max-width:100%;white-space:pre-wrap;width:auto;overflow:auto}code{font-size:13px;font-family:font-family: Consolas,Menlo,Monaco,Lucida Console,Liberation Mono,DejaVu Sans Mono,Bitstream Vera Sans Mono,Courier New,monospace,sans-serif;border:1px solid rgba(0,0,0,.223);border-radius:2px;padding:1px 2px;word-break:break-all;word-wrap:break-word}pre code{padding:0;font-size:inherit;color:inherit;white-space:pre-wrap;background-color:transparent;border:none;border-radius:0;word-break:break-all;word-wrap:break-word}td{text-align:center}table{border-collapse:collapse!important}.force-full-width{width:100%!important}</style><style media=screen>@media screen{h1,h2,h3,h4,h5,h6{font-family:\'Helvetica Neue\',Arial,sans-serif!important}td{font-family:Tiempos,Georgia,Times,serif!important}code,pre{font-family:Consolas,Menlo,Monaco,\'Lucida Console\',\'Liberation Mono\',\'DejaVu Sans Mono\',\'Bitstream Vera Sans Mono\',\'Courier New\',monospace,sans-serif!important}}</style><style media="only screen and (max-width:480px)">@media only screen and (max-width:480px){table[class=w320]{width:100%!important}}</style><body bgcolor=#FFFFFF class=body style=padding:0;margin:0;display:block;background:#fff;-webkit-text-size-adjust:none><table cellpadding=0 cellspacing=0 width=100% align=center><tr><td align=center valign=top bgcolor=#FFFFFF width=100%><center><table cellpadding=0 cellspacing=0 width=600 style="margin:0 auto"class=w320><tr><td align=center valign=top><table cellpadding=0 cellspacing=0 width=100% style="margin:0 auto;border-bottom:1px solid #ddd"bgcolor=#ECECEC><tr><td><h1>{{subject}}</h1></table><table cellpadding=0 cellspacing=0 width=100% style="margin:0 auto"bgcolor=#F2F2F2><tr><td><center><table cellpadding=0 cellspacing=0 width=100% style="margin:0 auto"><tr><td align=left style="text-align:left;padding:30px 25px">{{{html}}}</table></center></table></table></center></table>';

/**
 * @typedef {import('./presets.js').MailTimePresetName} MailTimePresetName
 */

/**
 * @typedef {import('./presets.js').MailTimePresetConfig} MailTimePresetConfig
 */

/**
 * @typedef {{ status: string, code: number, statusCode: number, paused?: boolean, error?: unknown }} MailTimePingResult
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
 * @typedef {{ [key: string]: any, type?: 'mongo' | 'redis' | 'postgres', client?: MailTimeStorageClient, db?: MailTimeMongoDb, prefix?: string, resetOnInit?: boolean, useHashTags?: boolean }} MailTimeJoSkAdapterOptions
 */

/**
 * @typedef {{ [key: string]: any, adapter: MailTimeJoSkAdapterOptions | object, debug?: boolean, autoClear?: boolean, zombieTime?: number, lockLeaseTime?: number, minRevolvingDelay?: number, maxRevolvingDelay?: number, execute?: 'batch' | 'one', concurrency?: number, lockOwnerId?: string, resetOnInit?: boolean, onError?: (title: string, details: object) => void, onExecuted?: (uid: string, details: object) => void }} MailTimeJoSkOptions
 */

/**
 * @typedef {{ [key: string]: any, ping: () => Promise<MailTimePingResult>, setInterval: (func: (...args: any[]) => unknown, delay: number, uid: string) => Promise<string>, destroy: () => boolean, shutdown: (opts?: { timeout?: number }) => Promise<boolean>, pause: (timerId?: string) => boolean, resume: (timerId?: string) => boolean }} MailTimeScheduler
 */

/**
 * @typedef {string | { address: string, name?: string }} MailTimeMailbox
 */

/**
 * @typedef {{ address: string, sources: Array<'envelope' | 'to' | 'cc' | 'bcc'> }} MailTimePolicyRecipient
 * @typedef {{ address: string, status: 'suppressed' | 'rejected' | 'retry', reason: string }} MailTimePolicyDecision
 * @typedef {{ decisions?: MailTimePolicyDecision[] }} MailTimePolicyResult
 * @typedef {{ index: number, name?: string }} MailTimePolicyTransport
 * @typedef {{ from?: string, to: string[] }} MailTimePolicyEnvelope
 * @typedef {{ task: MailTimeTask, attempt: number, transport: MailTimePolicyTransport, envelope: MailTimePolicyEnvelope, recipients: MailTimePolicyRecipient[] }} MailTimePolicyContext
 * @typedef {MailTimePolicyContext} MailTimeBeforeSendPolicyContext
 * @typedef {{ address: string | null, command?: string, responseCode?: number, response?: string, message?: string, transportIndex: number, transportName?: string }} MailTimeStructuredRejection
 * @typedef {MailTimePolicyContext & { error?: unknown, info?: unknown, rejections: MailTimeStructuredRejection[] }} MailTimeRejectionPolicyContext
 * @typedef {{ address: string, status: 'sent' | 'error' | 'suppressed' | 'rejected', sources?: Array<'envelope' | 'to' | 'cc' | 'bcc'>, reasons: Array<{ provider: string, reason: string }>, attempt: number, transportIndex?: number, transportName?: string, command?: string, responseCode?: number, response?: string, message?: string }} MailTimeRecipientResult
 * @typedef {MailTimeRejectionPolicyContext & { decisions: MailTimeRecipientResult[] }} MailTimeRecipientAttemptContext
 * @typedef {{ uuid: string, tries: number, isSettled: boolean, recipients: { sent: MailTimeRecipientResult[], error: MailTimeRecipientResult[], suppressed: MailTimeRecipientResult[], rejected: MailTimeRecipientResult[] } }} MailTimeRecipientSummary
 * @typedef {{ name: string, failureMode?: 'retry' | 'continue', beforeSend?: (context: MailTimeBeforeSendPolicyContext) => void | MailTimePolicyResult | Promise<void | MailTimePolicyResult>, classifyRejections?: (context: MailTimeRejectionPolicyContext) => void | MailTimePolicyResult | Promise<void | MailTimePolicyResult>, observeAttempt?: (context: MailTimeRecipientAttemptContext) => void | Promise<void> }} MailTimeRecipientPolicy
 * @description Policy contexts are read-only by contract. Providers must bound their own I/O; renewal budgets do not limit hook duration.
 */

/**
 * @typedef {{ uuid: string, to?: MailTimeMailbox | MailTimeMailbox[], tries: number, sendAt: number, isSent: boolean, isSettled?: boolean, recipientResults?: MailTimeRecipientResult[], isCancelled: boolean, isFailed: boolean, isSending?: boolean, sendingAt?: number, template?: string | false, transport: number, concatSubject?: string | false, mailOptions: MailTimeMailOptions[] }} MailTimeTask
 */

/**
 * @typedef {{ limit?: number, sendingTimeout?: number }} MailTimeIterateOptions
 */

/**
 * @typedef {{ ping: () => Promise<MailTimePingResult>, iterate: (opts?: MailTimeIterateOptions) => Promise<void> | void, getPendingTo: (to: string, sendAt: number) => Promise<MailTimeTask | object | null>, push: (email: MailTimeTask) => Promise<void> | void, cancel: (uuid: string) => Promise<boolean>, remove: (email: MailTimeTask | object, opts?: { leaseTries: number, leaseSendingAt: number }) => Promise<boolean>, update: (email: MailTimeTask | object, updateObj: object) => Promise<boolean>, ready?: () => Promise<void>, supportsRecipientPolicies?: boolean }} CustomQueue
 */

/**
 * @typedef {{ address: string, error: string }} MailTimeRejectedRecipient
 */

/**
 * @typedef {{ [key: string]: any, to: MailTimeMailbox | MailTimeMailbox[], cc?: MailTimeMailbox | MailTimeMailbox[], bcc?: MailTimeMailbox | MailTimeMailbox[], sendAt?: Date | number, template?: string, concatSubject?: string, text?: string | false, html?: string | false, subject?: string, accepted?: string[], rejected?: MailTimeRejectedRecipient[] }} MailTimeMailOptions
 */

/**
 * @typedef {{ subject?: string }} MailTimeConcatEmailsOptions
 */

/**
 * @typedef {{ index: number, from: string | undefined }} MailTimeFromDetails
 */

/**
 * @typedef {{ queue: RedisQueue | MongoQueue | PostgresQueue | CustomQueue, type?: 'server' | 'client', from?: string | ((transport: MailTimeTransport, details: MailTimeFromDetails) => string), transports?: MailTimeTransport[], strategy?: 'backup' | 'balancer', failsToNext?: number, shouldFailOver?: (error: unknown, info: object | undefined, email: MailTimeTask) => boolean, retries?: number, maxTries?: number, retryDelay?: number, interval?: number, keepHistory?: boolean, concatEmails?: boolean | MailTimeConcatEmailsOptions, concatSubject?: string, concatDelimiter?: string, concatDelay?: number, concatThrottling?: number, revolvingInterval?: number, mode?: 'one' | 'batch', concurrency?: number, sendingTimeout?: number, renewClaim?: boolean | number, maxRenewals?: number, strictPayload?: boolean, allowedMailFields?: string[], verifyTransports?: boolean, template?: string, prefix?: string, debug?: boolean, josk?: MailTimeJoSkOptions, recipientPolicies?: MailTimeRecipientPolicy[], onError?: (error: unknown, email: MailTimeTask | null, details?: object, recipients?: MailTimeRecipientResult[], summary?: MailTimeRecipientSummary) => void | Promise<void>, onSent?: (email: MailTimeTask, details?: object, recipients?: MailTimeRecipientResult[], summary?: MailTimeRecipientSummary) => void | Promise<void>, onSuppressed?: (email: MailTimeTask, recipients: MailTimeRecipientResult[], summary: MailTimeRecipientSummary) => void | Promise<void>, onRejected?: (email: MailTimeTask, recipients: MailTimeRecipientResult[], summary: MailTimeRecipientSummary) => void | Promise<void> }} MailTimeOptions
 */

/**
 * Class of MailTime.
 * With recipientPolicies, terminal callbacks receive grouped recipients and a complete summary after persistence.
 * isSettled includes exhausted errors; isSent means all accepted; isFailed means an error or permanent rejection.
 * Unparseable terminal preparation failures invoke onError with an empty recipient group.
 * Hooks must bound their own I/O. Callback notifications are best-effort, not durable exactly-once delivery.
 */
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

    this.__recipientPolicies = validateRecipientPolicies(opts.recipientPolicies, opts.queue);
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
    this.onSuppressed = (typeof opts.onSuppressed === 'function') ? opts.onSuppressed.bind(this) : noop;
    this.onRejected = (typeof opts.onRejected === 'function') ? opts.onRejected.bind(this) : noop;

    this.revolvingInterval = (typeof opts.revolvingInterval === 'number' && opts.revolvingInterval > 0) ? opts.revolvingInterval : 1536;
    this.mode = (opts.mode === 'one' || opts.mode === 'batch') ? opts.mode : 'batch';
    this.concurrency = (typeof opts.concurrency === 'number' && opts.concurrency > 0 && Number.isFinite(opts.concurrency)) ? Math.floor(opts.concurrency) : 1;
    this.sendingTimeout = (typeof opts.sendingTimeout === 'number' && Number.isFinite(opts.sendingTimeout) && opts.sendingTimeout > 0) ? opts.sendingTimeout : 300000;
    if (this.sendingTimeout < MIN_SAFE_SENDING_TIMEOUT) {
      logError(`{sendingTimeout: ${this.sendingTimeout}} is below the ${MIN_SAFE_SENDING_TIMEOUT}ms safe floor — a claim that expires while SMTP is still in flight is re-claimed by a peer and the letter is delivered twice. Raise {sendingTimeout} above the worst-case SMTP roundtrip.`);
    }

    // Claim renewal: MailTime has no way to know how long a transport will take, so a
    // long-but-healthy send used to lose its lock to a "recovery" worker. While a send
    // is in flight the claim is re-stamped every {renewClaim} ms — bounded by
    // {maxRenewals} so a genuinely wedged send is still recovered, just later.
    if (opts.renewClaim === false || opts.renewClaim === 0) {
      this.renewClaim = 0;
    } else if (typeof opts.renewClaim === 'number' && Number.isFinite(opts.renewClaim) && opts.renewClaim > 0) {
      this.renewClaim = Math.floor(opts.renewClaim);
    } else {
      this.renewClaim = Math.max(1000, Math.floor(this.sendingTimeout / 3));
    }
    this.maxRenewals = (typeof opts.maxRenewals === 'number' && Number.isFinite(opts.maxRenewals) && opts.maxRenewals >= 0) ? Math.floor(opts.maxRenewals) : DEFAULT_MAX_RENEWALS;

    // Transport fail-over policy. Rotating on *any* error can resubmit a letter the
    // MX already accepted; a transport that knows better says so.
    this.shouldFailOver = (typeof opts.shouldFailOver === 'function') ? opts.shouldFailOver.bind(this) : null;

    this.strictPayload = opts.strictPayload === true;
    this.allowedMailFields = new Set([
      ...STRICT_MAIL_FIELDS,
      ...(Array.isArray(opts.allowedMailFields) ? opts.allowedMailFields.filter((field) => typeof field === 'string') : []),
    ]);

    this.__isDestroyed = false;
    this.__abortInFlight = false;
    this.__isPaused = false;
    this.__schedulerScans = 0;
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
    this.__debug(`INITIALIZING [renewClaim: ${this.renewClaim}]`);
    this.__debug(`INITIALIZING [strictPayload: ${this.strictPayload}]`);

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

      /** @type {MailTimeScheduler | undefined} */
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
        return { ...schedulerPing, paused: this.__isPaused };
      }
    }
    const queuePing = await this.queue.ping();
    return { ...queuePing, paused: this.__isPaused };
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
   * @description Stop the scheduler and block future dispatches. Sends still waiting for a `concurrency` slot are dropped at once; their rows stay unclaimed for the next scan. Without `{ drain: true }`, in-flight SMTP attempts are neutralized and their claims recover after `sendingTimeout`. With `{ drain: true }`, await JoSk shutdown and in-flight SMTP; resolves false if the queue scan exceeds `schedulerTimeout` (default 10000ms) or JoSk shutdown throws (logged); never rejects. In-flight SMTP does not count against the timeout, and the timeout does not bound SMTP drain time.
   * @param {{ drain?: boolean, schedulerTimeout?: number }} [opts] - schedulerTimeout must be finite and non-negative; used only with drain
   * @returns {boolean | Promise<boolean>}
   */
  destroy(opts) {
    this.__debug('[destroy]', opts);
    if (this.__isDestroyed) {
      return false;
    }
    if (opts?.drain === true && opts.schedulerTimeout !== void 0
      && (typeof opts.schedulerTimeout !== 'number' || !Number.isFinite(opts.schedulerTimeout) || opts.schedulerTimeout < 0)) {
      throw new Error('[mail-time] [destroy] schedulerTimeout must be a finite non-negative number');
    }

    this.__isDestroyed = true;
    this.__isPaused = false;
    // Queued jobs never started SMTP; dropping them lets a scan blocked on a
    // pool slot return, so JoSk shutdown does not wait for in-flight sends.
    this.__pool.cancelQueued();
    if (opts?.drain === true) {
      return (async () => {
        let finished = true;
        try {
          if (this.scheduler) finished = await this.scheduler.shutdown({ timeout: opts.schedulerTimeout });
        } catch (error) {
          logError('[destroy] scheduler shutdown failed', error);
          finished = false;
        } finally {
          await this.__pool.drain();
        }
        return finished;
      })();
    }
    if (this.scheduler) {
      this.scheduler.destroy();
    }
    // No graceful drain requested: neutralize in-flight SMTP completions so a
    // destroyed instance performs no storage writes, no `onSent`/`onError`
    // callbacks, and no logging after teardown. Each claimed row keeps its
    // `isSending` lock, which a peer or a future instance recovers once
    // `sendingTimeout` elapses — identical to a crash mid-send. Use
    // `destroy({ drain: true })` (or `await drain()` before `destroy()`) when
    // in-flight sends must run to completion.
    this.__abortInFlight = true;
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
   * @name pause
   * @description Pause this server instance from competing for the queue-drain lease. In-flight SMTP sends finish; sends still waiting for a `concurrency` slot are dropped and their rows stay unclaimed; peer server instances keep draining. Reversible (unlike `destroy()`). No-op on `client` instances or after `destroy()`. To stop scanning *and* wait for in-flight sends: `mailTime.pause(); await mailTime.drain();`.
   * @returns {boolean} `true` if newly paused; `false` if already paused, a client instance, or destroyed
   */
  pause() {
    this.__debug('[pause]');
    if (this.__isDestroyed || !this.scheduler) {
      return false;
    }
    const paused = this.scheduler.pause();
    if (paused) {
      this.__isPaused = true;
      if (this.__schedulerScans > 0) {
        this.__pool.cancelQueued();
      }
    }
    return paused;
  }

  /**
   * @memberOf MailTime
   * @name resume
   * @description Resume competing for the queue-drain lease after `pause()`; triggers an immediate scan. No-op on `client` instances, after `destroy()`, or when not paused.
   * @returns {boolean} `true` if newly resumed; `false` if not paused, a client instance, or destroyed
   */
  resume() {
    this.__debug('[resume]');
    if (this.__isDestroyed || !this.scheduler) {
      return false;
    }
    const resumed = this.scheduler.resume();
    if (resumed) {
      this.__isPaused = false;
    }
    return resumed;
  }

  /**
   * @memberOf MailTime
   * @name isPaused
   * @description Whether this instance is currently paused from draining the queue. Always `false` on `client` instances.
   * @returns {boolean}
   */
  get isPaused() {
    return this.__isPaused;
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
  async sendMail(opts) {
    opts = (opts && typeof opts === 'object') ? opts : {};
    this.__debug('[sendMail]', opts);
    if (!opts.html && !opts.text) {
      throw new Error('[mail-time] [sendMail] `html` nor `text` field is present, at least one of those fields is required');
    }

    if (opts.raw !== void 0) {
      throw new Error('[mail-time] [sendMail] `raw` is not supported: it bypasses composition, so `template`, `concatEmails`, and the `from()` callback would silently stop applying — and nodemailer historically let a message-level `raw` bypass `disableFileAccess`/`disableUrlAccess`. Pass `html` / `text` instead.');
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

    const isMailbox = isPlainObject(mailOptions.to) && typeof mailOptions.to.address === 'string' && mailOptions.to.address.trim().length > 0;
    if (!isMailbox && typeof mailOptions.to !== 'string' && (!Array.isArray(mailOptions.to) || !mailOptions.to.length)) {
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

        const appended = await this.queue.update(task, {
          appendMailOption: mailOptions,
        });
        if (appended) {
          return task.uuid;
        }
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
    if (this.__abortInFlight) {
      this.__debug('[private handleError] instance destroyed; skipping onError', task?.uuid);
      return;
    }
    if (!task) {
      return;
    }

    if (task.tries >= this.maxTries) {
      this.___finalizeRejected(task, info);

      const leaseRemove = __leaseRemoveOpts(task);
      const leaseUpdate = __withLease(task, {
        isSent: false,
        isFailed: true,
        isSending: false,
        sendingAt: 0,
        mailOptions: task.mailOptions,
      });

      let finalized = false;
      if (!this.keepHistory) {
        finalized = await this.queue.remove(task, leaseRemove);
      } else {
        finalized = await this.queue.update(task, leaseUpdate);
      }

      if (!finalized) {
        this.__debug('[private handleError] lease lost before final failure update, skipping onError', task.uuid);
        return;
      }

      // Persist first, then mirror to in-memory task — a superseded worker must not lie to onError.
      task.isSent = false;
      task.isFailed = true;
      task.isSending = false;

      this.__debug(`[private handleError] Giving up trying send email after ${task.tries} attempts to: `, task.mailOptions[0].to, error);
      callHook('onError', this.onError, error, task, info);
      return;
    }

    let transportIndex = task.transport;

    if (this.strategy === 'backup'
      && this.transports.length > 1
      && (task.tries % this.failsToNext) === 0
      && this.___mayFailOver(error, info, task)) {
      transportIndex = this.___nextHealthyTransport(transportIndex);
    }

    const released = await this.queue.update(task, __withLease(task, {
      isSending: false,
      sendingAt: 0,
      sendAt: Date.now() + this.retryDelay,
      transport: transportIndex,
    }));

    if (!released) {
      this.__debug('[private handleError] lease lost before retry release, skipping', task.uuid);
      return;
    }

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
      uuid: crypto.randomUUID(),
      tries: 0,
      isSent: false,
      isSettled: false,
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
   * @description Render Mustache-like placeholders. `{{{key}}}` is always verbatim.
   * `{{key}}` is HTML-escaped in HTML contexts (`html`, `template`, `concatDelimiter`) —
   * that is what double-brace means everywhere else, and the previous strip-tags pass was
   * not a safety net: it needs a closing `>`, so an unterminated `<a href="…` survived
   * into the rendered body. Text bodies and subject headers are not HTML, so `{{key}}`
   * substitutes verbatim there.
   * @param {string} _string - Template with Mustache-like placeholders
   * @param {Record<string, any>} replacements - Blaze/Mustache-like helpers Object
   * @param {boolean} [isHtml=true] - `false` for text/plain bodies and header values
   * @returns {string}
   */
  ___render(_string, replacements, isHtml = true) {
    let string = _string;
    const matchHTML = string.match(/\{{3}\s?([a-zA-Z0-9\-_]+)\s?\}{3}/g);
    if (matchHTML) {
      for (let i = 0; i < matchHTML.length; i++) {
        const key = matchHTML[i].slice(3, -3).trim();
        if (hasOwnProp(replacements, key) && replacements[key] !== null && replacements[key] !== void 0) {
          string = string.replace(matchHTML[i], `${replacements[key]}`);
        }
      }
    }

    const matchStr = string.match(/\{{2}\s?([a-zA-Z0-9\-_]+)\s?\}{2}/g);
    if (matchStr) {
      for (let i = 0; i < matchStr.length; i++) {
        const key = matchStr[i].slice(2, -2).trim();
        if (hasOwnProp(replacements, key) && replacements[key] !== null && replacements[key] !== void 0) {
          const value = `${replacements[key]}`;
          string = string.replace(matchStr[i], isHtml ? escapeHtml(value) : value);
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

    for (const field of ['html', 'text', 'subject']) {
      if (compiledOpts[field] === void 0 || compiledOpts[field] === null) {
        compiledOpts[field] = '';
      }
    }

    const mailOptionsList = task.mailOptions || [];
    const isMulti = mailOptionsList.length > 1;

    for (let i = 0; i < mailOptionsList.length; i++) {
      const mailOption = this.___applyPayloadPolicy({ ...mailOptionsList[i] });

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
        const rendered = this.___render(mailOption.text, mailOption, false);
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
      compiledOpts.subject = this.___render(rawSubject, { count: mailOptionsList.length }, false);
    }

    if (!compiledOpts.from && this.from) {
      compiledOpts.from = this.from(transport, {
        index: this.transports.indexOf(transport),
        from: MailTime.transportFrom(transport),
      });
    }

    const acceptedSet = collectAcceptedSet(task);
    if (!this.__recipientPolicies && acceptedSet.size > 0) {
      compiledOpts.to = filterAddressField(compiledOpts.to, acceptedSet);
      compiledOpts.cc = filterAddressField(compiledOpts.cc, acceptedSet);
      compiledOpts.bcc = filterAddressField(compiledOpts.bcc, acceptedSet);
    }

    if (this.strictPayload) {
      compiledOpts.disableFileAccess = true;
      compiledOpts.disableUrlAccess = true;
    }

    return compiledOpts;
  }

  /**
   * @internal
   * @memberOf MailTime
   * @name ___applyPayloadPolicy
   * @description Narrow one queued mail option to what a task is allowed to set. `raw` is
   * always dropped: it bypasses composition (so `template`, `concatEmails` and the
   * `from()` callback silently stop applying) and historically bypassed nodemailer's
   * `disableFileAccess`/`disableUrlAccess` with it. Under `{strictPayload: true}` only
   * `allowedMailFields` survive.
   * @param {MailTimeMailOptions} mailOption - a single queued mail option object
   * @returns {MailTimeMailOptions}
   */
  ___applyPayloadPolicy(mailOption) {
    if (mailOption.raw !== void 0) {
      delete mailOption.raw;
      logError('[___compileMailOpts] dropped {raw} from a queued task — `raw` bypasses composition and is never sent by MailTime');
    }

    if (!this.strictPayload) {
      return mailOption;
    }

    const allowed = {};
    for (const key of Object.keys(mailOption)) {
      if (this.allowedMailFields.has(key)) {
        allowed[key] = mailOption[key];
      } else {
        this.__debug('[___applyPayloadPolicy] dropped non-allowlisted field', key);
      }
    }
    return allowed;
  }

  /**
   * @static
   * @memberOf MailTime
   * @name transportFrom
   * @description Best-effort sender address for a transport. `nodemailer.createTransport()`
   * only exposes `.options` for *plain-object* configs — for a class-instance transporter
   * (anything with its own `.send()`) nodemailer's internal `Mail.options` is always `{}`,
   * so `transport.options.from` silently reads `undefined`. This walks the places the
   * address can actually live.
   * @param {MailTimeTransport} transport
   * @returns {string | undefined}
   */
  static transportFrom(transport) {
    const candidates = [
      transport?.options?.from,
      transport?.transporter?.options?.from,
      transport?._defaults?.from,
      transport?._options?.from,
    ];

    for (const candidate of candidates) {
      // nodemailer accepts `from` as a string or as `{ name, address }`. Resolve the
      // first candidate that yields a usable address — not the first truthy slot, so a
      // malformed `{ name }` object cannot mask a real address further down the chain.
      const address = (typeof candidate === 'string')
        ? candidate
        : (candidate && typeof candidate === 'object' && typeof candidate.address === 'string')
          ? candidate.address
          : '';
      if (address.trim()) {
        return address;
      }
    }

    return void 0;
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
   * @internal
   * @memberOf MailTime
   * @name ___mayFailOver
   * @description Whether this failure may be retried on the *next* transport. Rotating on
   * any error can resubmit a letter the receiving MTA already accepted (or may have
   * accepted — a socket that died during `DATA` is indistinguishable from one that died
   * before it). A transport signals "do not fail over" with `error.mayFailOver = false`;
   * the `shouldFailOver(error, info, task)` option overrides both.
   * @param {unknown} error - error returned by the transport
   * @param {object|undefined} info - info object returned by the transport
   * @param {MailTimeTask} task - email's task object from Storage
   * @returns {boolean}
   */
  ___mayFailOver(error, info, task) {
    if (this.shouldFailOver) {
      try {
        return this.shouldFailOver(error, info, task) !== false;
      } catch (policyError) {
        logError('[shouldFailOver] callback failed; keeping the current transport', policyError);
        return false;
      }
    }
    return !(error && typeof error === 'object' && error.mayFailOver === false);
  }

  /**
   * @internal
   * @memberOf MailTime
   * @name ___startClaimRenewal
   * @description Hold a claim alive while its SMTP roundtrip runs. MailTime 4.x stamped
   * `sendingAt` once at claim time, so any send slower than `sendingTimeout` lost its lock
   * to a "recovery" worker and the letter went out twice. The renewal is a lease-guarded
   * update — it succeeds only while *this* worker still owns the row — and is bounded by
   * `maxRenewals` so a genuinely wedged send is still recovered.
   * @param {MailTimeTask} task - claimed task, with `isSending`/`sendingAt`/`tries` set
   * @returns {{ stop: () => Promise<void> }}
   */
  ___startClaimRenewal(task) {
    if (!this.renewClaim || !this.maxRenewals || this.type !== 'server') {
      return { stop: async () => {} };
    }

    let stopped = false;
    let renewals = 0;
    let timer = null;
    let activeRenewal = null;
    const halt = () => {
      if (stopped) {
        return;
      }
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    };
    const stop = async () => {
      halt();
      if (activeRenewal) {
        await activeRenewal;
      }
    };

    const renew = async () => {
      if (stopped || this.__abortInFlight) {
        halt();
        return;
      }

      if (renewals >= this.maxRenewals) {
        this.__debug('[private renewClaim] renewal budget exhausted; letting the claim go stale', task.uuid);
        halt();
        return;
      }
      renewals += 1;

      // Strictly greater than the current stamp: storages that report "modified" only on
      // an actual value change would otherwise read a same-millisecond renewal as a no-op.
      const renewedAt = Math.max(Date.now(), (typeof task.sendingAt === 'number' ? task.sendingAt : 0) + 1);
      let renewed = false;
      try {
        renewed = await this.queue.update(task, __withLease(task, {
          isSending: true,
          sendingAt: renewedAt,
        }));
      } catch (renewError) {
        logError('[private renewClaim] storage error during claim renewal', renewError);
        halt();
        return;
      }

      if (!renewed) {
        this.__debug('[private renewClaim] lease lost; stopping renewal', task.uuid);
        halt();
        return;
      }

      task.sendingAt = renewedAt;
      this.__debug(`[private renewClaim] renewed ${renewals}/${this.maxRenewals}`, task.uuid);
    };

    timer = setInterval(() => {
      if (activeRenewal) {
        return;
      }
      activeRenewal = renew().finally(() => {
        activeRenewal = null;
      });
    }, this.renewClaim);

    if (typeof timer.unref === 'function') {
      timer.unref();
    }

    return { stop };
  }

  /** @internal Serialize every policy checkpoint with this attempt's claim renewal. */
  async ___sendWithRecipientPolicies(task) {
    if (!task || task.isSent || task.isFailed || task.isCancelled || task.isSettled || this.__abortInFlight) return;
    const recoveryOnly = Array.isArray(task.recipientResults) && (task.tries >= this.maxTries
      || (task.recipientResults.length > 0 && task.recipientResults.every((r) => r.status === 'sent' || r.status === 'suppressed' || r.status === 'rejected')));
    const fields = { tries: recoveryOnly ? task.tries : task.tries + 1, isSending: true, sendingAt: Math.max(Date.now(), (task.sendingAt || 0) + 1), recipientResults: task.recipientResults || [] };
    try {
      if (!await this.queue.update(task, fields)) return;
    } catch (error) {
      if (!this.__abortInFlight) logError('[recipientPolicies] claim failed', error);
      return;
    }
    Object.assign(task, fields);
    const lease = new RecipientPolicyLease({
      task, queue: this.queue, interval: this.renewClaim, maxRenewals: this.maxRenewals,
      shouldAbort: () => this.__abortInFlight,
      report: (error) => logError('[recipientPolicies] lease persistence failed', error),
    });
    try {
      if (!lease.active) return;
      if (recoveryOnly) {
        let preparationFailure = false;
        if (!task.recipientResults.length) {
          try {
            const compiled = this.___compileMailOpts(this.transports[task.transport], task);
            const prepared = preparePolicyEnvelope(compiled);
            task.recipientResults = mergePolicyResults([], prepared.recipients, { retryFailure: false, decisions: [] }, {
              phase: 'beforeSend', attempt: task.tries, transportIndex: task.transport, accepted: [...collectAcceptedSet(task)],
            });
          } catch { preparationFailure = true; }
        }
        await this.___completePolicyTask(task, lease, policyError('last attempt interrupted; completing durable recipient state'), void 0, preparationFailure);
        return;
      }
      if (!this.___isHealthyTransport(task.transport)) task.transport = this.___nextHealthyTransport(task.transport);
      const transport = this.transports[task.transport];
      const compiled = this.___compileMailOpts(transport, task);
      if (!compiled.from) compiled.from = MailTime.transportFrom(transport);
      const prepared = preparePolicyEnvelope(compiled, task.recipientResults);
      const transportName = typeof transport.name === 'string' ? transport.name : transport.options?.name;
      const details = { phase: 'beforeSend', attempt: task.tries, transportIndex: task.transport, transportName, accepted: [...collectAcceptedSet(task)] };
      task.recipientResults = mergePolicyResults(task.recipientResults, prepared.recipients, { retryFailure: false, decisions: [] }, details);
      const pending = new Set(task.recipientResults.filter((r) => r.status === 'error').map((r) => r.address));
      const context = {
        task, attempt: task.tries, transport: { index: task.transport, ...(typeof transportName === 'string' ? { name: transportName.slice(0, 128) } : {}) },
        envelope: { ...prepared.envelope, to: prepared.envelope.to.filter((a) => pending.has(a)) },
        recipients: prepared.recipients.filter((r) => pending.has(r.address)),
      };
      if (!pending.size) {
        await this.___completePolicyTask(task, lease);
        return;
      }
      const evaluated = await evaluatePolicyPhase(this.__recipientPolicies, 'beforeSend', context, (error, name, hook) => {
        if (!this.__abortInFlight) logError(`[recipientPolicies] ${name}.${hook} failed`, error);
      });
      if (!lease.active) return;
      task.recipientResults = mergePolicyResults(task.recipientResults, context.recipients, evaluated, details);
      if (!await lease.update({ recipientResults: task.recipientResults, mailOptions: task.mailOptions })) return;
      if (!lease.active) return;
      if (evaluated.retryFailure) {
        await this.___retryPolicyTask(task, lease, policyError('beforeSend provider failed'), void 0, true);
        return;
      }
      const eligible = new Set(task.recipientResults.filter((r) => r.status === 'error').map((r) => r.address));
      if (!eligible.size) {
        await this.___completePolicyTask(task, lease);
        return;
      }
      context.envelope = { ...context.envelope, to: context.envelope.to.filter((a) => eligible.has(a)) };
      context.recipients = context.recipients.filter((r) => eligible.has(r.address));
      await this.___attemptPolicyTransport(task, lease, compiled, context);
    } catch (error) {
      if (!lease.active) return;
      if (isAddressError(error)) {
        // Unparseable addresses fail identically on every attempt, so settle now instead of
        // spending the retry budget. The message names the field, never the address.
        if (!this.__abortInFlight) logError(`[recipientPolicies] task ${task.uuid} failed without retry:`, error.message);
        await this.___completePolicyTask(task, lease, error, void 0, true);
      } else {
        await this.___retryPolicyTask(task, lease, error, void 0, true, true);
      }
    } finally {
      await lease.stop();
    }
  }

  /** @internal Persist SMTP acceptance before awaiting rejection classification or observation. */
  async ___attemptPolicyTransport(task, lease, compiled, context) {
    const transport = this.transports[context.transport.index];
    const outgoing = { ...compiled, envelope: context.envelope };
    const { error, info } = await new Promise((resolve) => {
      let called = false;
      const done = (error, info) => {
        if (called) return;
        called = true;
        resolve({ error, info });
      };
      try { transport.sendMail(outgoing, done); }
      catch (error) { done(error, void 0); }
    });
    if (!lease.active) return;
    const attempted = new Set(context.envelope.to);
    const accepted = new Set();
    for (const source of [info, error]) {
      for (const value of Array.isArray(source?.accepted) ? source.accepted : []) {
        try {
          const address = normalizePolicyAddress(value);
          if (attempted.has(address)) accepted.add(address);
        } catch { /* Transport records outside supported address forms remain unresolved. */ }
      }
    }
    const details = { phase: 'classifyRejections', attempt: task.tries, transportIndex: context.transport.index, transportName: context.transport.name, accepted: [...accepted] };
    task.recipientResults = mergePolicyResults(task.recipientResults, context.recipients, { retryFailure: false, decisions: [] }, details);
    this.___mapPolicyMailOptions(task, false);
    if (!await lease.update({ recipientResults: task.recipientResults, mailOptions: task.mailOptions })) return;
    if (!lease.active) return;
    const unresolved = context.recipients.filter((r) => !accepted.has(r.address));
    if (unresolved.length) {
      const rejections = normalizeRejections(error, info, context.transport);
      const rejectionContext = { ...context, recipients: unresolved, error, info, rejections };
      const evaluated = await evaluatePolicyPhase(this.__recipientPolicies, 'classifyRejections', rejectionContext, (hookError, name, hook) => {
        if (!this.__abortInFlight) logError(`[recipientPolicies] ${name}.${hook} failed`, hookError);
      });
      if (!lease.active) return;
      task.recipientResults = mergePolicyResults(task.recipientResults, unresolved, evaluated, { ...details, rejections });
      const observation = { ...rejectionContext, decisions: task.recipientResults };
      for (const provider of this.__recipientPolicies) {
        if (!lease.active) return;
        if (typeof provider.observeAttempt !== 'function') continue;
        try { await provider.observeAttempt(observation); }
        catch (hookError) {
          if (!this.__abortInFlight) logError(`[recipientPolicies] ${provider.name}.observeAttempt failed`, hookError);
        }
      }
    }
    if (!lease.active) return;
    if (task.recipientResults.some((r) => r.status === 'error')) {
      await this.___retryPolicyTask(task, lease, error || policyError('recipients remain unaccepted'), info, !!error || accepted.size === 0);
    } else {
      await this.___completePolicyTask(task, lease, error, info);
    }
  }

  /** @internal Keep legacy per-mail-option state limited to actual envelope recipients. */
  ___mapPolicyMailOptions(task, terminal) {
    const results = new Map(task.recipientResults.map((r) => [r.address, r]));
    for (const option of task.mailOptions || []) {
      const addresses = new Set();
      for (const field of ['to', 'cc', 'bcc']) {
        const values = Array.isArray(option[field]) ? option[field] : [option[field]];
        for (const value of values) {
          try { addresses.add(normalizePolicyAddress(value)); } catch { /* Explicit envelopes permit complex headers. */ }
        }
      }
      const accepted = new Set(Array.isArray(option.accepted) ? option.accepted : []);
      const rejected = [];
      for (const address of addresses) {
        const result = results.get(address);
        if (result?.status === 'sent') accepted.add(address);
        if (terminal && (result?.status === 'error' || result?.status === 'rejected')) {
          rejected.push({ address, error: result.message || result.response || result.reasons[0]?.reason || 'Recipient not accepted by transport' });
        }
      }
      option.accepted = [...accepted];
      if (terminal) option.rejected = rejected;
    }
  }

  /** @internal Release a policy claim with all durable outcomes, or settle at exhaustion. */
  async ___retryPolicyTask(task, lease, error, info, allowRotation, preparationFailure = false) {
    if (!lease.active) return false;
    if (task.tries >= this.maxTries) return await this.___completePolicyTask(task, lease, error, info, preparationFailure);
    let transport = task.transport;
    if (allowRotation && this.strategy === 'backup' && this.transports.length > 1
      && task.tries % this.failsToNext === 0 && this.___mayFailOver(error, info, task)) transport = this.___nextHealthyTransport(transport);
    return await lease.finish({ isSending: false, sendingAt: 0, sendAt: Date.now() + this.retryDelay, transport,
      recipientResults: task.recipientResults, mailOptions: task.mailOptions }, false);
  }

  /** @internal Settle truthfully before invoking any best-effort terminal notification. */
  async ___completePolicyTask(task, lease, error, info, preparationFailure = false) {
    if (!lease.active) return false;
    this.___mapPolicyMailOptions(task, true);
    const results = task.recipientResults;
    const fields = {
      isSettled: true, isSent: results.length > 0 && results.every((r) => r.status === 'sent'),
      isFailed: preparationFailure || results.some((r) => r.status === 'error' || r.status === 'rejected'),
      isSending: false, sendingAt: 0, recipientResults: results, mailOptions: task.mailOptions,
    };
    const completed = await lease.finish(fields, !this.keepHistory);
    if (completed && !this.__abortInFlight) this.___notifyPolicyGroups(task, error, info, preparationFailure);
    return completed;
  }

  /** @internal Empty groups are silent except unparseable terminal preparation failures. */
  ___notifyPolicyGroups(task, error, info, preparationFailure) {
    const summary = summarizePolicyTask(task, true);
    const groups = summary.recipients;
    if (groups.sent.length) callHook('onSent', this.onSent, task, info, groups.sent, summary);
    if (!this.__abortInFlight && (groups.error.length || (preparationFailure && !task.recipientResults.length))) {
      callHook('onError', this.onError, error || policyError('recipients remain unaccepted'), task, info, groups.error, summary);
    }
    if (!this.__abortInFlight && groups.suppressed.length) callHook('onSuppressed', this.onSuppressed, task, groups.suppressed, summary);
    if (!this.__abortInFlight && groups.rejected.length) callHook('onRejected', this.onRejected, task, groups.rejected, summary);
  }

  /**
   * @async
   * @internal
   * @memberOf MailTime
   * @name ___dispatch
   * @description Queue full-lifecycle send for `task` under the bounded send pool. No-op after `destroy()`, or while paused during a scheduler-driven scan; `destroy()` and `pause()` also drop jobs still waiting for a slot. Resolves as soon as a pool slot is acquired and the send has started — the SMTP roundtrip continues in the background so the adapter's `iterate` can move on to the next due row and the JoSk lease can be released. Call `await mailTime.drain()` to await in-flight sends; use `destroy({ drain: true })` for graceful shutdown.
   * @param {MailTimeTask} task - email's task object from Storage
   * @returns {Promise<void 0>}
   */
  async ___dispatch(task) {
    if (this.___isStopped) {
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
    const started = await this.__pool.dispatch(async () => {
      try {
        if (this.___isStopped) {
          return;
        }
        await this.___send(task);
      } finally {
        this.__inFlight.delete(task.uuid);
      }
    });
    if (!started) {
      this.__inFlight.delete(task.uuid);
    }
  }

  /**
   * @internal
   * @memberOf MailTime
   * @name ___isStopped
   * @description `true` after `destroy()`, or while paused during a scheduler-driven scan. Queue adapters check it to end an `iterate` scan early.
   * @returns {boolean}
   */
  get ___isStopped() {
    return this.__isDestroyed || (this.__isPaused && this.__schedulerScans > 0);
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
    if (this.__recipientPolicies) return await this.___sendWithRecipientPolicies(task);
    if (task?.isSettled === true) return;
    if (Array.isArray(task?.recipientResults)) {
      logError('[recipientPolicies] active policy state requires a policy-configured worker', task.uuid);
      return;
    }
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
      const renewal = this.___startClaimRenewal(task);

      try {
        await new Promise((resolve) => {
          transport.sendMail(compiledOpts, async (error, info) => {
            // The roundtrip has settled — stop extending the lease before any completion
            // write, so the guard below sees the last `sendingAt` this worker persisted.
            await renewal.stop();
            if (this.__abortInFlight) {
              this.__debug('[private send] instance destroyed mid-send; leaving claim for stale-lock recovery', task.uuid);
              resolve();
              return;
            }
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

                const leaseRemove = __leaseRemoveOpts(task);
                const leaseUpdate = __withLease(task, {
                  isSent: true,
                  isSending: false,
                  sendingAt: 0,
                  mailOptions: task.mailOptions,
                });

                let completed = false;
                if (!this.keepHistory) {
                  completed = await this.queue.remove(task, leaseRemove);
                } else {
                  completed = await this.queue.update(task, leaseUpdate);
                }

                if (!completed) {
                  this.__debug('[private send] lease lost before success completion, skipping onSent', task.uuid);
                  return;
                }

                // Persist first, then mirror to in-memory task — a superseded worker must not lie to onSent.
                task.isSent = true;
                task.isSending = false;
                task.sendingAt = 0;
                callHook('onSent', this.onSent, task, info);
                return;
              }

              if (task.tries >= this.maxTries) {
                this.___finalizeRejected(task, info);

                const leaseRemove = __leaseRemoveOpts(task);
                const leaseUpdate = __withLease(task, {
                  isSent: false,
                  isFailed: true,
                  isSending: false,
                  sendingAt: 0,
                  mailOptions: task.mailOptions,
                });

                let finalized = false;
                if (!this.keepHistory) {
                  finalized = await this.queue.remove(task, leaseRemove);
                } else {
                  finalized = await this.queue.update(task, leaseUpdate);
                }

                if (!finalized) {
                  this.__debug('[private send] lease lost before partial-failure completion, skipping onError', task.uuid);
                  return;
                }

                // Persist first, then mirror to in-memory task — a superseded worker must not lie to onError.
                task.isSent = false;
                task.isFailed = true;
                task.isSending = false;

                const rejectedAddrs = [];
                for (const mo of task.mailOptions) {
                  for (const r of (mo.rejected || [])) {
                    rejectedAddrs.push(r.address);
                  }
                }
                const partialError = new Error(`Recipients rejected after ${task.tries} attempts: ${rejectedAddrs.join(', ')}`);
                this.__debug('[private send] Partial delivery exhausted retries; rejected: ', rejectedAddrs);
                callHook('onError', this.onError, partialError, task, info);
                return;
              }

              const nextSendAt = Date.now() + this.retryDelay;
              const released = await this.queue.update(task, __withLease(task, {
                isSending: false,
                sendingAt: 0,
                sendAt: nextSendAt,
                mailOptions: task.mailOptions,
              }));
              if (!released) {
                this.__debug('[private send] lease lost before partial retry release', task.uuid);
                return;
              }
              this.__debug(`[private send] Partial delivery, next attempt at ${new Date(nextSendAt)}: #${task.tries}/${this.maxTries} for remaining recipients`);
            } catch (completionError) {
              logError('[private send] completion error after transport callback', completionError);
            } finally {
              resolve();
            }
          });
        });
      } finally {
        // A transport that throws synchronously never reaches the callback above.
        await renewal.stop();
      }
    } catch (e) {
      if (this.__abortInFlight) {
        this.__debug('[private send] instance destroyed mid-send; suppressing runtime exception', e);
        return;
      }
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
    if (this.__isDestroyed || this.__isPaused) {
      return;
    }
    const limit = this.mode === 'one' ? 1 : Infinity;
    this.__schedulerScans++;
    try {
      return await this.queue.iterate({
        limit,
        sendingTimeout: this.sendingTimeout,
      });
    } finally {
      this.__schedulerScans--;
    }
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
      callHook('onError', this.onError, r.error, null, { transportIndex: r.index, phase: 'verify' });
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

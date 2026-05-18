import { debug, logError } from '../helpers.js';

const DEFAULT_PREFIX = '';

const isSendClaimUpdate = (updateObj) => {
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
      this.__applyPrefix(this.mailTimeInstance?.prefix || DEFAULT_PREFIX);
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
   * @description iterate over queued tasks passing to `mailTimeInstance.___send` method
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

    if (isSendClaimUpdate(updateObj)) {
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

export { MongoQueue };

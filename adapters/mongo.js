import { logError } from '../helpers.js';

const isSendClaimUpdate = (updateObj) => {
  return updateObj.isSent === true && typeof updateObj.tries === 'number';
};

/**
 * @typedef {object} MongoCollection
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

/**
 * Ensure (create) index on MongoDB collection, catch and log exception if thrown
 * @function ensureIndex
 * @param {Collection} collection - Mongo's driver Collection instance
 * @param {object} keys - Field and value pairs where the field is the index key and the value describes the type of index for that field
 * @param {object} opts - Set of options that controls the creation of the index
 * @returns {void 0}
 */
const ensureIndex = async (collection, keys, opts) => {
  try {
    await collection.createIndex(keys, opts);
  } catch (e) {
    if (e.code === 85) {
      let indexName;
      const indexes = await collection.indexes();
      for (const index of indexes) {
        let drop = true;
        for (const indexKey of Object.keys(keys)) {
          if (typeof index.key[indexKey] === 'undefined') {
            drop = false;
            break;
          }
        }

        for (const indexKey of Object.keys(index.key)) {
          if (typeof keys[indexKey] === 'undefined') {
            drop = false;
            break;
          }
        }

        if (drop) {
          indexName = index.name;
          break;
        }
      }

      if (indexName) {
        await collection.dropIndex(indexName);
        await collection.createIndex(keys, opts);
      }
    } else {
      logError(`[ensureIndex] Can not set ${Object.keys(keys).join(' + ')} index on "${collection._name || 'MongoDB'}" collection`, { keys, opts, details: e });
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
    if (!opts || typeof opts !== 'object' || opts === null) {
      throw new TypeError('[mail-time] Configuration object must be passed into MongoQueue constructor');
    }

    if (!opts.db) {
      throw new Error('[mail-time] [MongoQueue] requires MongoDB database {db} option, like returned from `MongoClient.connect`');
    }

    this.prefix = (typeof opts.prefix === 'string') ? opts.prefix : '';
    this.db = opts.db;
    this.collection = opts.db.collection(`__mailTimeQueue__${this.prefix}`);
    this.__readyPromise = Promise.all([
      ensureIndex(this.collection, { uuid: 1 }, { background: false }),
      ensureIndex(this.collection, { isSent: 1, isFailed: 1, isCancelled: 1, to: 1, sendAt: 1 }, { background: false }),
      ensureIndex(this.collection, { isSent: 1, isFailed: 1, isCancelled: 1, sendAt: 1, tries: 1 }, { background: false })
    ]).then(() => void 0);

    // MongoDB Collection Schema:
    // _id
    // uuid        {string}
    // to          {string|[string]}
    // tries       {number}  - qty of send attempts
    // sendAt      {number}  - When letter should be sent
    // isSent      {boolean} - Email status
    // isCancelled {boolean} - `true` if email was cancelled before it was sent
    // isFailed    {boolean} - `true` if email has failed to send
    // template    {string}  - Template for this email
    // transport   {number}  - Last used transport
    // concatSubject {string|boolean} - Email concatenation subject
    // ---
    // mailOptions         {[object]}  - Array of nodeMailer's `mailOptions`
    // mailOptions.to      {string|[string]} - [REQUIRED]
    // mailOptions.from    {string}
    // mailOptions.text    {string|boolean}
    // mailOptions.html    {string}
    // mailOptions.subject {string}
    // mailOptions.Other nodeMailer `sendMail` options...
  }

  /**
   * @async
   * @memberOf MongoQueue
   * @name ready
   * @description Wait until indexes are created
   * @returns {Promise<void 0>}
   */
  async ready() {
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
        error: pingError
      };
    }

    return {
      status: 'Service Unavailable',
      code: 503,
      statusCode: 503,
      error: new Error('Service Unavailable')
    };
  }

  /**
   * @memberOf MongoQueue
   * @name iterate
   * @description iterate over queued tasks passing to `mailTimeInstance.___send` method
   * @returns {Promise<void>}
   */
  async iterate() {
    try {
      const cursor = this.collection.find({
        isSent: false,
        isFailed: false,
        isCancelled: false,
        sendAt: {
          $lte: Date.now()
        },
        tries: {
          $lt: this.mailTimeInstance.maxTries
        }
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
          mailOptions: 1,
          concatSubject: 1,
        }
      });

      while (await cursor.hasNext()) {
        await this.mailTimeInstance.___send(await cursor.next());
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
    if (typeof to !== 'string' || typeof sendAt !== 'number') {
      return null;
    }

    return await this.collection.findOne({
      to: to,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      sendAt: {
        $lte: sendAt
      }
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
      }
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
    if (!task || typeof task !== 'object') {
      return;
    }

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
    if (typeof uuid !== 'string') {
      return false;
    }

    const task = await this.collection.findOne({ uuid }, {
      projection: {
        _id: 1,
        uuid: 1,
        isSent: 1,
        isCancelled: 1,
      }
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
    if (!task || typeof task !== 'object') {
      return false;
    }

    return (await this.collection.deleteOne({ _id: task._id }))?.deletedCount >= 1;
  }

  /**
   * @async
   * @memberOf MongoQueue
   * @name update
   * @description remove task from queue
   * @param task {object} - task's object
   * @param updateObj {object} - fields with new values to update
   * @returns {Promise<boolean>} returns `true` if updated or `false` if not found or no changes was made
   */
  async update(task, updateObj) {
    if (!task || typeof task !== 'object' || !updateObj || typeof updateObj !== 'object') {
      return false;
    }

    const query = {
      _id: task._id
    };

    if (isSendClaimUpdate(updateObj)) {
      Object.assign(query, {
        isSent: false,
        isFailed: false,
        isCancelled: false,
        tries: task.tries
      });
    }

    return (await this.collection.updateOne(query, {
      $set: updateObj
    }))?.modifiedCount >= 1;
  }
}

export { MongoQueue };

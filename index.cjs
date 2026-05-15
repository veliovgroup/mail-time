'use strict';

const josk = require('josk');
const merge = require('deepmerge');
const crypto = require('crypto');

const debug = (isDebug, ...args) => {
  if (isDebug) {
    console.info.call(console, '[DEBUG] [mail-time]', `${new Date}`, ...args);
  }
};

const logError = (...args) => {
  console.error.call(console, '[ERROR] [mail-time]', `${new Date}`, ...args);
};

const isSendClaimUpdate$2 = (updateObj) => {
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

    if (isSendClaimUpdate$2(updateObj)) {
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

const isSendClaimUpdate$1 = (updateObj) => {
  return updateObj.isSent === true && typeof updateObj.tries === 'number';
};

const canClaimTask = (currentTask, task) => {
  return currentTask &&
    currentTask.isSent !== true &&
    currentTask.isFailed !== true &&
    currentTask.isCancelled !== true &&
    currentTask.tries === task.tries;
};

/** Class representing Redis Queue for MailTime */
class RedisQueue {
  /**
   * Create a RedisQueue instance
   * @param {RedisQueueOption} opts - configuration object
   */
  constructor (opts) {
    this.name = 'redis-queue';
    if (!opts || typeof opts !== 'object' || opts === null) {
      throw new TypeError('[mail-time] Configuration object must be passed into RedisQueue constructor');
    }

    if (!opts.client) {
      throw new Error('[mail-time] [RedisQueue] required {client} option is missing, e.g. returned from `redis.createClient()` or `redis.createCluster()` method');
    }

    this.prefix = (typeof opts.prefix === 'string') ? opts.prefix : 'default';
    this.uniqueName = `mailtime:${this.prefix}`;
    this.client = opts.client;

    // 3 types of keys are stored in Redis:
    // 'letter' - JSON with email details
    // 'sendat' - Timestamp used to scan/find/iterate over scheduled emails
    // 'concatletter' — uuid of "pending" email for concatenation used when {concatEmails: true}

    // Stored JSON structure:
    // to          {string|[string]}
    // uuid        {string}
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
   * @memberOf RedisQueue
   * @name ready
   * @description Storage adapter has no async setup
   * @returns {Promise<void 0>}
   */
  async ready() {
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
   * @memberOf RedisQueue
   * @name iterate
   * @description iterate over queued tasks passing to `mailTimeInstance.___send` method
   * @returns {Promise<void>}
   */
  async iterate() {
    try {
      const now = Date.now();
      const cursor = this.client.scanIterator({
        TYPE: 'string',
        MATCH: this.__getKey('*', 'sendat'),
        COUNT: 9999,
      });

      for await (const cursorValue of cursor) {
        const sendatKeys = Array.isArray(cursorValue) ? cursorValue : [cursorValue];
        for (const sendatKey of sendatKeys) {
          if (parseInt(await this.client.get(sendatKey)) <= now) {
            const taskJSON = await this.client.get(this.__getKey(sendatKey.split(':')[3]));
            if (taskJSON) {
              await this.mailTimeInstance.___send(JSON.parse(taskJSON));
            }
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
    if (typeof to !== 'string' || typeof sendAt !== 'number') {
      return null;
    }

    const concatKey = this.__getKey(to, 'concatletter');
    let exists = await this.client.exists(concatKey);
    if (!exists) {
      return null;
    }

    const uuid = await this.client.get(concatKey);
    const letterKey = this.__getKey(uuid, 'letter');
    exists = await this.client.exists(letterKey);
    if (!exists) {
      return null;
    }

    const task = JSON.parse(await this.client.get(letterKey));
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
    if (!task || typeof task !== 'object') {
      return;
    }

    if (task.sendAt instanceof Date) {
      task.sendAt = +task.sendAt;
    }

    await this.client.set(this.__getKey(task.uuid, 'letter'), JSON.stringify(task));
    await this.client.set(this.__getKey(task.uuid, 'sendat'), `${task.sendAt}`);
    if (task.to) {
      await this.client.set(this.__getKey(task.to, 'concatletter'), task.uuid, {
        PXAT: task.sendAt - 128
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
    if (typeof uuid !== 'string') {
      return false;
    }

    await this.client.del(this.__getKey(uuid, 'sendat'));
    const letterKey = this.__getKey(uuid, 'letter');
    const exists = await this.client.exists(letterKey);
    if (!exists) {
      return false;
    }

    const task = JSON.parse(await this.client.get(letterKey));
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
    if (!task || typeof task !== 'object' || typeof task.uuid !== 'string') {
      return false;
    }

    const letterKey = this.__getKey(task.uuid, 'letter');
    const exists = await this.client.exists(letterKey);
    if (!exists) {
      return false;
    }

    await this.client.del([
      letterKey,
      this.__getKey(task.uuid, 'sendat'),
    ]);
    if (task.to) {
      await this.client.del(this.__getKey(task.to, 'concatletter'));
    }
    return true;
  }

  /**
   * @async
   * @memberOf RedisQueue
   * @name update
   * @description remove task from queue
   * @param task {object} - task's object
   * @param updateObj {object} - fields with new values to update
   * @returns {Promise<boolean>} returns `true` if updated or `false` if not found or no changes was made
   */
  async update(task, updateObj) {
    if (!task || typeof task !== 'object' || typeof task.uuid !== 'string' || !updateObj || typeof updateObj !== 'object') {
      return false;
    }

    const letterKey = this.__getKey(task.uuid, 'letter');
    const sendatKey = this.__getKey(task.uuid, 'sendat');
    const isClaim = isSendClaimUpdate$1(updateObj);

    try {
      if (isClaim && typeof this.client.watch === 'function' && typeof this.client.multi === 'function') {
        await this.client.watch(letterKey);
        const taskJSON = await this.client.get(letterKey);
        if (!taskJSON) {
          await this.client.unwatch?.();
          return false;
        }

        const currentTask = JSON.parse(taskJSON);
        if (!canClaimTask(currentTask, task)) {
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
      if (isClaim && !canClaimTask(currentTask, task)) {
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
   * @memberOf RedisQueue
   * @name __getKey
   * @description helper to generate scoped key
   * @param uuid {string} - letter's uuid
   * @param type {string} - "letter" or "sendat" or "concatletter"
   * @returns {string} returns key used by Redis
   */
  __getKey(uuid, type = 'letter') {
    if (!this.__keyTypes.includes(type)) {
      throw new Error(`[mail-time] [RedisQueue] [__getKey] unsupported key "${type}" passed into the second argument`);
    }
    return `${this.uniqueName}:${type}:${uuid}`;
  }

  /**
   * @memberOf RedisQueue
   * @name __keyTypes
   * @description list of supported key type
   * @returns {string} returns key used by Redis
   */
  __keyTypes = ['letter', 'sendat', 'concatletter'];
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

const setupLockId = 93824519;

const fieldMap = {
  to: 'to_address',
  tries: 'tries',
  sendAt: 'send_at',
  isSent: 'is_sent',
  isCancelled: 'is_cancelled',
  isFailed: 'is_failed',
  template: 'template',
  transport: 'transport',
  concatSubject: 'concat_subject',
  mailOptions: 'mail_options'
};

const isSendClaimUpdate = (updateObj) => {
  return updateObj.isSent === true && typeof updateObj.tries === 'number';
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
    template: row.template || false,
    transport: parseInt(row.transport, 10),
    concatSubject: row.concat_subject || false,
    mailOptions: parseMailOptions(row.mail_options)
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
    if (!opts || typeof opts !== 'object' || opts === null) {
      throw new TypeError('[mail-time] Configuration object must be passed into PostgresQueue constructor');
    }

    if (!opts.client) {
      throw new Error('[mail-time] [PostgresQueue] required {client} option is missing');
    }

    this.prefix = (typeof opts.prefix === 'string' && opts.prefix.length > 0) ? opts.prefix : 'default';
    this.client = opts.client;
    this.__readyPromise = this.__setup();
    this.__readyPromise.catch(() => void 0);
  }

  /**
   * @async
   * @memberOf PostgresQueue
   * @name ready
   * @description Wait until PostgreSQL schema is ready
   * @returns {Promise<void 0>}
   */
  async ready() {
    await this.__readyPromise;
  }

  /** @internal */
  async __setup() {
    await this.client.query('SELECT pg_advisory_lock($1)', [setupLockId]);

    try {
      await this.client.query(`
        CREATE TABLE IF NOT EXISTS mail_time_queue (
          id BIGSERIAL PRIMARY KEY,
          prefix TEXT NOT NULL DEFAULT 'default',
          uuid TEXT NOT NULL,
          to_address TEXT,
          tries INTEGER NOT NULL DEFAULT 0,
          send_at BIGINT NOT NULL,
          is_sent BOOLEAN NOT NULL DEFAULT false,
          is_cancelled BOOLEAN NOT NULL DEFAULT false,
          is_failed BOOLEAN NOT NULL DEFAULT false,
          template TEXT,
          transport INTEGER NOT NULL DEFAULT 0,
          concat_subject TEXT,
          mail_options JSONB NOT NULL,
          created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
        )
      `);

      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS prefix TEXT NOT NULL DEFAULT 'default'`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS uuid TEXT NOT NULL DEFAULT ''`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS to_address TEXT`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS tries INTEGER NOT NULL DEFAULT 0`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS send_at BIGINT NOT NULL DEFAULT 0`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS is_sent BOOLEAN NOT NULL DEFAULT false`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS is_cancelled BOOLEAN NOT NULL DEFAULT false`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS is_failed BOOLEAN NOT NULL DEFAULT false`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS template TEXT`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS transport INTEGER NOT NULL DEFAULT 0`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS concat_subject TEXT`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS mail_options JSONB NOT NULL DEFAULT '[]'::jsonb`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`);
      await this.client.query(`ALTER TABLE mail_time_queue ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP`);

      await this.client.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_mail_time_queue_prefix_uuid
        ON mail_time_queue (prefix, uuid)
      `);

      await this.client.query(`
        CREATE INDEX IF NOT EXISTS idx_mail_time_queue_due
        ON mail_time_queue (prefix, is_sent, is_failed, is_cancelled, send_at, tries)
      `);

      await this.client.query(`
        CREATE INDEX IF NOT EXISTS idx_mail_time_queue_pending_to
        ON mail_time_queue (prefix, to_address, is_sent, is_failed, is_cancelled, send_at)
      `);
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
   * @memberOf PostgresQueue
   * @name iterate
   * @description iterate over queued tasks passing to `mailTimeInstance.___send` method
   * @returns {Promise<void>}
   */
  async iterate() {
    await this.ready();

    try {
      const res = await this.client.query(`
        SELECT id, uuid, to_address, tries, send_at, is_sent, is_cancelled, is_failed,
               template, transport, concat_subject, mail_options
        FROM mail_time_queue
        WHERE prefix = $1
          AND is_sent = false
          AND is_failed = false
          AND is_cancelled = false
          AND send_at <= $2
          AND tries < $3
        ORDER BY send_at ASC
        LIMIT 100
      `, [this.prefix, Date.now(), this.mailTimeInstance.maxTries]);

      for (const row of res.rows || []) {
        await this.mailTimeInstance.___send(normalizeRow(row));
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
    if (typeof to !== 'string' || typeof sendAt !== 'number') {
      return null;
    }

    await this.ready();

    const res = await this.client.query(`
      SELECT id, uuid, to_address, tries, send_at, is_sent, is_cancelled, is_failed,
             template, transport, concat_subject, mail_options
      FROM mail_time_queue
      WHERE prefix = $1
        AND to_address = $2
        AND is_sent = false
        AND is_failed = false
        AND is_cancelled = false
        AND send_at <= $3
      ORDER BY send_at DESC
      LIMIT 1
    `, [this.prefix, to, sendAt]);

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
    if (!task || typeof task !== 'object') {
      return;
    }

    await this.ready();

    if (task.sendAt instanceof Date) {
      task.sendAt = +task.sendAt;
    }

    await this.client.query(`
      INSERT INTO mail_time_queue (
        prefix, uuid, to_address, tries, send_at, is_sent, is_cancelled, is_failed,
        template, transport, concat_subject, mail_options, created_at, updated_at
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
      ON CONFLICT (prefix, uuid) DO UPDATE SET
        to_address = EXCLUDED.to_address,
        tries = EXCLUDED.tries,
        send_at = EXCLUDED.send_at,
        is_sent = EXCLUDED.is_sent,
        is_cancelled = EXCLUDED.is_cancelled,
        is_failed = EXCLUDED.is_failed,
        template = EXCLUDED.template,
        transport = EXCLUDED.transport,
        concat_subject = EXCLUDED.concat_subject,
        mail_options = EXCLUDED.mail_options,
        updated_at = CURRENT_TIMESTAMP
    `, [
      this.prefix,
      task.uuid,
      typeof task.to === 'string' ? task.to : null,
      task.tries,
      task.sendAt,
      task.isSent,
      task.isCancelled,
      task.isFailed,
      task.template || null,
      task.transport,
      task.concatSubject || null,
      JSON.stringify(task.mailOptions || [])
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
    if (typeof uuid !== 'string') {
      return false;
    }

    await this.ready();

    const task = normalizeRow((await this.client.query(`
      SELECT id, uuid, to_address, tries, send_at, is_sent, is_cancelled, is_failed,
             template, transport, concat_subject, mail_options
      FROM mail_time_queue
      WHERE prefix = $1
        AND uuid = $2
      LIMIT 1
    `, [this.prefix, uuid])).rows?.[0]);

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
    if (!task || typeof task !== 'object') {
      return false;
    }

    await this.ready();

    const where = task.id ? 'id = $2' : 'uuid = $2';
    const value = task.id || task.uuid;
    const res = await this.client.query(`
      DELETE FROM mail_time_queue
      WHERE prefix = $1
        AND ${where}
    `, [this.prefix, value]);
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
      values.push(task.tries);
      claimWhere = `
        AND is_sent = false
        AND is_failed = false
        AND is_cancelled = false
        AND tries = $${values.length}
      `;
    }

    values.push(this.prefix);
    const prefixIndex = values.length;
    values.push(task.id || task.uuid);
    const taskIndex = values.length;
    const where = task.id ? 'id' : 'uuid';

    const res = await this.client.query(`
      UPDATE mail_time_queue
      SET ${sets.join(', ')},
          updated_at = CURRENT_TIMESTAMP
      WHERE prefix = $${prefixIndex}
        AND ${where} = $${taskIndex}
        ${claimWhere}
    `, values);

    return (res.rowCount || 0) >= 1;
  }
}

const noop = () => {};
const hasOwn = Object.prototype.hasOwnProperty;

const hasAcceptedRecipients = (info) => {
  return Array.isArray(info?.accepted) && info.accepted.length > 0;
};

/**
 * Check if entities of various types are equal
 * including edge cases like unordered Objects and Array
 * @function equals
 * @param {mix} a
 * @param {mix} b
 * @returns {boolean}
 */
const equals = (a, b) => {
  let i;
  if (a === b) {
    return true;
  }

  if (!a || !b) {
    return false;
  }

  if (!(typeof a === 'object' && typeof b === 'object')) {
    return false;
  }

  if (a instanceof Date && b instanceof Date) {
    return a.valueOf() === b.valueOf();
  }

  if (a instanceof Array) {
    if (!(b instanceof Array)) {
      return false;
    }

    if (a.length !== b.length) {
      return false;
    }

    const _a = a.slice();
    const _b = b.slice();
    let j;
    for (i = _a.length - 1; i >= 0; i--) {
      let result = false;
      for (j = _b.length - 1; j >= 0; j--) {
        if (equals(_a[i], _b[j])) {
          result = true;
          _a.splice(i, 1);
          _b.splice(j, 1);
          break;
        }
      }

      if (!result) {
        return false;
      }
    }
    return true;
  }

  i = 0;
  if (typeof a === 'object' && typeof b === 'object') {
    const akeys = Object.keys(a);
    const bkeys = Object.keys(b);

    if (akeys.length !== bkeys.length) {
      return false;
    }

    for (i = akeys.length - 1; i >= 0; i--) {
      if (!hasOwn.call(b, akeys[i])) {
        return  false;
      }

      if (!equals(a[akeys[i]], b[akeys[i]])) {
        return false;
      }
    }

    return true;
  }
  return false;
};

let DEFAULT_TEMPLATE = '<!DOCTYPE html><html xmlns=http://www.w3.org/1999/xhtml><meta content="text/html; charset=utf-8"http-equiv=Content-Type><meta content="width=device-width,initial-scale=1"name=viewport><title>{{subject}}</title><style>body{-webkit-font-smoothing:antialiased;-webkit-text-size-adjust:none;font-family:Tiempos,Georgia,Times,serif;font-weight:400;width:100%;height:100%;background:#fff;font-size:15px;color:#000;line-height:1.5}a{text-decoration:underline;border:0;color:#000;outline:0;color:inherit}a:hover{text-decoration:none}a[href^=sms],a[href^=tel]{text-decoration:none;color:#000;cursor:default}a img{border:none;text-decoration:none}td{font-family:Tiempos,Georgia,Times,serif;font-weight:400}hr{height:1px;border:none;width:100%;margin:0;margin-top:25px;margin-bottom:25px;background-color:#ECECEC}h1,h2,h3,h4,h5,h6{font-family:HelveticaNeue,"Helvetica Neue",Helvetica,Arial,sans-serif;font-weight:300;line-height:normal;margin-top:35px;margin-bottom:4px;margin-left:0;margin-right:0}h1{margin:23px 15px;font-size:25px}h2{margin-top:15px;font-size:21px}h3{font-weight:400;font-size:19px;border-bottom:1px solid #ECECEC}h4{font-weight:400;font-size:18px}h5{font-weight:400;font-size:17px}h6{font-weight:600;font-size:16px}h1 a,h2 a,h3 a,h4 a,h5 a,h6 a{text-decoration:none}pre{font-family:Consolas,Menlo,Monaco,Lucida Console,Liberation Mono,DejaVu Sans Mono,Bitstream Vera Sans Mono,Courier New,monospace,sans-serif;display:block;font-size:13px;padding:9.5px;margin:0 0 10px;line-height:1.42;color:#333;word-break:break-all;word-wrap:break-word;background-color:#f5f5f5;border:1px solid #ccc;border-radius:4px;text-align:left!important;max-width:100%;white-space:pre-wrap;width:auto;overflow:auto}code{font-size:13px;font-family:font-family: Consolas,Menlo,Monaco,Lucida Console,Liberation Mono,DejaVu Sans Mono,Bitstream Vera Sans Mono,Courier New,monospace,sans-serif;border:1px solid rgba(0,0,0,.223);border-radius:2px;padding:1px 2px;word-break:break-all;word-wrap:break-word}pre code{padding:0;font-size:inherit;color:inherit;white-space:pre-wrap;background-color:transparent;border:none;border-radius:0;word-break:break-all;word-wrap:break-word}td{text-align:center}table{border-collapse:collapse!important}.force-full-width{width:100%!important}</style><style media=screen>@media screen{h1,h2,h3,h4,h5,h6{font-family:\'Helvetica Neue\',Arial,sans-serif!important}td{font-family:Tiempos,Georgia,Times,serif!important}code,pre{font-family:Consolas,Menlo,Monaco,\'Lucida Console\',\'Liberation Mono\',\'DejaVu Sans Mono\',\'Bitstream Vera Sans Mono\',\'Courier New\',monospace,sans-serif!important}}</style><style media="only screen and (max-width:480px)">@media only screen and (max-width:480px){table[class=w320]{width:100%!important}}</style><body bgcolor=#FFFFFF class=body style=padding:0;margin:0;display:block;background:#fff;-webkit-text-size-adjust:none><table cellpadding=0 cellspacing=0 width=100% align=center><tr><td align=center valign=top bgcolor=#FFFFFF width=100%><center><table cellpadding=0 cellspacing=0 width=600 style="margin:0 auto"class=w320><tr><td align=center valign=top><table cellpadding=0 cellspacing=0 width=100% style="margin:0 auto;border-bottom:1px solid #ddd"bgcolor=#ECECEC><tr><td><h1>{{{subject}}}</h1></table><table cellpadding=0 cellspacing=0 width=100% style="margin:0 auto"bgcolor=#F2F2F2><tr><td><center><table cellpadding=0 cellspacing=0 width=100% style="margin:0 auto"><tr><td align=left style="text-align:left;padding:30px 25px">{{{html}}}</table></center></table></table></center></table>';

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
 * @typedef {{ [key: string]: any, adapter: MailTimeJoSkAdapterOptions | object, debug?: boolean, autoClear?: boolean, zombieTime?: number, minRevolvingDelay?: number, maxRevolvingDelay?: number, execute?: 'batch' | 'one', lockOwnerId?: string, resetOnInit?: boolean }} MailTimeJoSkOptions
 */

/**
 * @typedef {{ uuid: string, to?: string | string[], tries: number, sendAt: number, isSent: boolean, isCancelled: boolean, isFailed: boolean, template?: string | false, transport: number, concatSubject?: string | false, mailOptions: MailTimeMailOptions[] }} MailTimeTask
 */

/**
 * @typedef {{ ping: () => Promise<MailTimePingResult>, iterate: () => Promise<void> | void, getPendingTo: (to: string, sendAt: number) => Promise<MailTimeTask | object | null>, push: (email: MailTimeTask) => Promise<void> | void, cancel: (uuid: string) => Promise<boolean>, remove: (email: MailTimeTask | object) => Promise<boolean>, update: (email: MailTimeTask | object, updateObj: object) => Promise<boolean>, ready?: () => Promise<void> }} CustomQueue
 */

/**
 * @typedef {{ [key: string]: any, to: string | string[], sendAt?: Date | number, template?: string, concatSubject?: string, text?: string | false, html?: string | false, subject?: string }} MailTimeMailOptions
 */

/**
 * @typedef {{ queue: RedisQueue | MongoQueue | PostgresQueue | CustomQueue, type?: 'server' | 'client', from?: string | ((transport: MailTimeTransport) => string), transports?: MailTimeTransport[], strategy?: 'backup' | 'balancer', failsToNext?: number, retries?: number, maxTries?: number, retryDelay?: number, interval?: number, keepHistory?: boolean, concatEmails?: boolean, concatSubject?: string, concatDelimiter?: string, concatDelay?: number, concatThrottling?: number, revolvingInterval?: number, template?: string, prefix?: string, debug?: boolean, josk?: MailTimeJoSkOptions, onError?: (error: unknown, email: MailTimeTask, details?: object) => void, onSent?: (email: MailTimeTask, details?: object) => void }} MailTimeOptions
 */

/** Class of MailTime */
class MailTime {
  /**
   * Create a MailTime instance
   * @param {MailTimeOptions} opts - configuration object
   */
  constructor (opts) {
    if (!opts || typeof opts !== 'object' || opts === null) {
      throw new TypeError('[mail-time] Configuration object must be passed into MailTime constructor');
    }

    if (!opts.queue || typeof opts.queue !== 'object') {
      throw new Error('[mail-time] {queue} option is required', {
        description: 'MailTime requires MongoQueue, RedisQueue, or CustomQueue to connect to an intermediate database'
      });
    }

    this.queue = opts.queue;
    this.queue.mailTimeInstance = this;
    const queueMethods = ['ping', 'iterate', 'getPendingTo', 'push', 'remove', 'update', 'cancel'];

    for (let i = queueMethods.length - 1; i >= 0; i--) {
      if (typeof this.queue[queueMethods[i]] !== 'function') {
        throw new Error(`{queue} instance is missing {${queueMethods[i]}} method that is required!`);
      }
    }

    this.debug = (opts.debug !== true) ? false : true;
    this._debug = (...args) => {
      debug(this.debug, ...args);
    };

    this.type = (typeof opts.type !== 'string' || (opts.type !== 'client' && opts.type !== 'server')) ? 'server' : opts.type;
    this.prefix = (typeof opts.prefix === 'string') ? opts.prefix : '';

    if (typeof opts.retries === 'number') {
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
    this.keepHistory = (typeof opts.keepHistory === 'boolean') ? opts.keepHistory : false;
    this.onSent = opts.onSent || noop;
    this.onError = opts.onError || noop;

    this.revolvingInterval = opts.revolvingInterval || 1536;
    this.__isDestroyed = false;
    this.__readyPromise = null;
    this.__schedulerTimer = null;

    this.failsToNext = (typeof opts.failsToNext === 'number') ? opts.failsToNext : 4;
    this.strategy = (opts.strategy === 'backup' || opts.strategy === 'balancer') ? opts.strategy : 'backup';
    this.transports = opts.transports || [];
    this.transport = 0;
    this.from = (() => {
      if (typeof opts.from === 'string') {
        return () => {
          return opts.from;
        };
      }

      if (typeof opts.from === 'function') {
        return opts.from;
      }

      return false;
    })();

    this.concatEmails = (opts.concatEmails !== true) ? false : true;
    this.concatSubject = (opts.concatSubject && typeof opts.concatSubject === 'string') ? opts.concatSubject : 'Multiple notifications';
    this.concatDelimiter = (opts.concatDelimiter && typeof opts.concatDelimiter === 'string') ? opts.concatDelimiter : '<hr>';

    if (typeof opts.concatDelay === 'number') {
      this.concatDelay = opts.concatDelay;
    } else if (typeof opts.concatThrottling === 'number') {
      this.concatDelay = opts.concatThrottling * 1000;
    } else {
      this.concatDelay = 60000;
    }

    this._debug('DEBUG ON {debug: true}');
    this._debug(`INITIALIZING [type: ${this.type}]`);
    this._debug(`INITIALIZING [strategy: ${this.strategy}]`);
    this._debug(`INITIALIZING [josk.adapter: ${opts?.josk?.adapter}]`);
    this._debug(`INITIALIZING [prefix: ${this.prefix}]`);
    this._debug(`INITIALIZING [retries: ${this.maxTries - 1}]`);
    this._debug(`INITIALIZING [failsToNext: ${this.failsToNext}]`);
    this._debug(`INITIALIZING [onError: ${this.onError}]`);
    this._debug(`INITIALIZING [onSent: ${this.onSent}]`);

    /** SERVER-SPECIFIC CHECKS AND CONFIG */
    if (this.type === 'server') {
      if (this.transports.constructor !== Array || !this.transports.length) {
        throw new Error('[mail-time] {transports} is required for {type: "server"} and must be an Array, like returned from `nodemailer.createTransport`');
      }

      if (typeof opts.josk !== 'object') {
        throw new Error('[mail-time] {josk} option is required {object} for {type: "server"}');
      }

      if (typeof opts.josk.adapter !== 'object') {
        throw new Error('[mail-time] {josk.adapter} option is required {object} *or* custom adapter Class');
      }

      this.josk = { ...opts.josk };
      const getAdapterOptions = () => {
        const adapterOptions = {
          prefix: `mailTimeQueue${this.prefix}`,
          ...opts.josk.adapter
        };

        if (typeof opts.josk.resetOnInit === 'boolean' && typeof adapterOptions.resetOnInit !== 'boolean') {
          adapterOptions.resetOnInit = opts.josk.resetOnInit;
        }

        return adapterOptions;
      };

      if (typeof opts.josk.adapter?.type === 'string' && opts.josk.adapter?.type === 'mongo') {
        if (!opts.josk.adapter.db) {
          throw new Error('[mail-time] {josk.adapter.db} option required for {josk.adapter.type: "mongo"}');
        }
        this.josk.adapter = new josk.MongoAdapter(getAdapterOptions());
      }

      if (typeof opts.josk.adapter?.type === 'string' && opts.josk.adapter?.type === 'redis') {
        if (!opts.josk.adapter.client) {
          throw new Error('[mail-time] {josk.adapter.client} option required for {josk.adapter.type: "redis"}');
        }
        this.josk.adapter = new josk.RedisAdapter(getAdapterOptions());
      }

      if (typeof opts.josk.adapter?.type === 'string' && opts.josk.adapter?.type === 'postgres') {
        if (!opts.josk.adapter.client) {
          throw new Error('[mail-time] {josk.adapter.client} option required for {josk.adapter.type: "postgres"}');
        }
        this.josk.adapter = new josk.PostgresAdapter(getAdapterOptions());
      }

      this.josk.minRevolvingDelay = (typeof opts.josk.minRevolvingDelay === 'number') ? opts.josk.minRevolvingDelay : 512;
      this.josk.maxRevolvingDelay = (typeof opts.josk.maxRevolvingDelay === 'number') ? opts.josk.maxRevolvingDelay : 2048;
      this.josk.zombieTime = (typeof opts.josk.zombieTime === 'number') ? opts.josk.zombieTime : 32786;

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
   * @throws {mix}
   */
  async ping() {
    this._debug('[ping]');
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
    return await this.__readyPromise;
  }

  /**
   * @memberOf MailTime
   * @name destroy
   * @description Destroy scheduler instance and stop future queue iterations
   * @returns {boolean}
   */
  destroy() {
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
   * @memberOf MailTime
   * @name send
   * @description alias of `sendMail`
   * @param {MailTimeMailOptions} opts - email options
   * @returns {Promise<string>} uuid of the email
   */
  async send(opts) {
    this._debug('[send]', opts);
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
    this._debug('[sendMail]', opts);
    if (!opts.html && !opts.text) {
      throw new Error('`html` nor `text` field is presented, at least one of those fields is required');
    }

    let sendAt = opts.sendAt;
    if (!sendAt) {
      sendAt = Date.now();
    }

    if (sendAt instanceof Date) {
      sendAt = +sendAt;
    }

    if (typeof sendAt !== 'number') {
      sendAt = Date.now();
    }

    let template = opts.template;
    if (typeof template !== 'string') {
      template = false;
    }

    let concatSubject = opts.concatSubject;
    if (typeof concatSubject !== 'string') {
      concatSubject = false;
    }

    const mailOptions = { ...opts };
    delete mailOptions.sendAt;
    delete mailOptions.template;
    delete mailOptions.concatSubject;

    if (typeof mailOptions.to !== 'string' && (!(mailOptions.to instanceof Array) || !mailOptions.to.length)) {
      throw new Error('[mail-time] `mailOptions.to` is required and must be a string or non-empty Array');
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
          mailOptions: pendingMailOptions
        });
        return task.uuid;
      }
    }

    return await this.___addToQueue({
      sendAt,
      template,
      concatSubject,
      mailOptions: mailOptions,
    });
  }

  /**
   * @memberOf MailTime
   * @name cancel
   * @description alias of `cancelMail`
   * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found was sent or was cancelled previously
   */
  async cancel(uuid) {
    this._debug('[cancel]', uuid);
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
    this._debug('[cancelMail]', uuid);
    if (typeof uuid === 'object' && uuid instanceof Promise) {
      return await this.queue.cancel(await uuid);
    }
    return await this.queue.cancel(uuid);
  }

  /**
   * @async
   * @memberOf MailTime
   * @name ___handleError
   * @description Handle runtime errors and pass to `onError` callback
   * @param {MailTimeTask} task - Email task record from Storage
   * @param {unknown} error - Error String/Object/Error
   * @param {object} info - Info object returned from nodemailer
   * @returns {Promise<void 0>}
   */
  async ___handleError(task, error, info) {
    this._debug('[private handleError]', { task, error, info });
    if (!task) {
      return;
    }

    if (task.tries >= this.maxTries) {
      task.isSent = false;
      task.isFailed = true;

      if (!this.keepHistory) {
        await this.queue.remove(task);
      } else {
        await this.queue.update(task, {
          isSent: task.isSent,
          isFailed: task.isFailed,
        });
      }

      this._debug(`[private handleError] Giving up trying send email after ${task.tries} attempts to: `, task.mailOptions[0].to, error);
      this.onError(error, task, info);
      return;
    }

    let transportIndex = task.transport;

    if (this.strategy === 'backup' && this.transports.length > 1 && (task.tries % this.failsToNext) === 0) {
      ++transportIndex;
      if (transportIndex > this.transports.length - 1) {
        transportIndex = 0;
      }
    }

    await this.queue.update(task, {
      isSent: false,
      sendAt: Date.now() + this.retryDelay,
      transport: transportIndex,
    });

    this._debug(`[private handleError] Next re-send attempt at ${new Date(Date.now() + this.retryDelay)}: #${task.tries}/${this.maxTries}, transport #${transportIndex} to: `, task.mailOptions[0].to, error);
  }

  /**
   * @async
   * @memberOf MailTime
   * @name ___addToQueue
   * @description Prepare task's object and push to the queue
   * @param {{ sendAt: number, template: string | false, mailOptions: MailTimeMailOptions, concatSubject: string | false }} opts - Email options
   * @returns {Promise<string>} message uuid
   */
  async ___addToQueue(opts) {
    this._debug('[private addToQueue]', opts);
    const task = {
      uuid: crypto.randomUUID(),
      tries: 0,
      isSent: false,
      sendAt: opts.sendAt,
      isFailed: false,
      template: opts.template,
      transport: this.transport,
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
   * @memberOf MailTime
   * @name ___render
   * @description Render templates
   * @param {string} _string - Template with Mustache-like placeholders
   * @param {Record<string, any>} replacements - Blaze/Mustache-like helpers Object
   * @returns {string}
   */
  ___render(_string, replacements) {
    let i;
    let string = _string;
    const matchHTML = string.match(/\{{3}\s?([a-zA-Z0-9\-\_]+)\s?\}{3}/g);
    if (matchHTML) {
      for (i = 0; i < matchHTML.length; i++) {
        const key = matchHTML[i].replace('{{{', '').replace('}}}', '').trim();
        if (hasOwn.call(replacements, key) && replacements[key] !== null && replacements[key] !== void 0) {
          string = string.replace(matchHTML[i], `${replacements[key]}`);
        }
      }
    }

    const matchStr = string.match(/\{{2}\s?([a-zA-Z0-9\-\_]+)\s?\}{2}/g);
    if (matchStr) {
      for (i = 0; i < matchStr.length; i++) {
        const key = matchStr[i].replace('{{', '').replace('}}', '').trim();
        if (hasOwn.call(replacements, key) && replacements[key] !== null && replacements[key] !== void 0) {
          string = string.replace(matchStr[i], `${replacements[key]}`.replace(/<(?:.|\n)*?>/gm, ''));
        }
      }
    }
    return string;
  }

  /**
   * @memberOf MailTime
   * @name ___compileMailOpts
   * @description Run various checks, compile options, and render template
   * @param {MailTimeTransport} transport - Current transport
   * @param {MailTimeTask} task - Email task record from Storage
   * @returns {MailTimeMailOptions}
   */
  ___compileMailOpts(transport, task) {
    let compiledOpts = {};

    if (!transport) {
      throw new Error('[mail-time] [sendMail] [___compileMailOpts] {transport} is not available or misconfigured!');
    }

    if (transport._options && typeof transport._options === 'object' && transport._options !== null && transport._options.mailOptions) {
      compiledOpts = merge(compiledOpts, transport._options.mailOptions);
    }

    if (transport.options && typeof transport.options === 'object' && transport.options !== null && transport.options.mailOptions) {
      compiledOpts = merge(compiledOpts, transport.options.mailOptions);
    }

    compiledOpts = merge(compiledOpts, {
      html: '',
      text: '',
      subject: ''
    });

    for (let i = 0; i < task.mailOptions.length; i++) {
      const mailOption = { ...task.mailOptions[i] };

      if (mailOption.html) {
        if (task.mailOptions.length > 1) {
          compiledOpts.html += this.___render(this.concatDelimiter, mailOption) + this.___render(mailOption.html, mailOption);
        } else {
          compiledOpts.html = this.___render(mailOption.html, mailOption);
        }
        delete mailOption.html;
      }

      if (mailOption.text) {
        if (task.mailOptions.length > 1) {
          compiledOpts.text += '\r\n' + this.___render(mailOption.text, mailOption);
        } else {
          compiledOpts.text = this.___render(mailOption.text, mailOption);
        }
        delete mailOption.text;
      }

      compiledOpts = merge(compiledOpts, mailOption);
    }

    if (compiledOpts.html && (task.template || this.template)) {
      compiledOpts.html = this.___render((task.template || this.template), compiledOpts);
    }

    if (task.mailOptions.length > 1) {
      compiledOpts.subject = task.concatSubject || this.concatSubject || compiledOpts.subject;
    }

    if (!compiledOpts.from && this.from) {
      compiledOpts.from = this.from(transport);
    }

    return compiledOpts;
  }

  /**
   * @async
   * @memberOf MailTime
   * @name ___send
   * @description send email using nodemailer's transport
   * @param {MailTimeTask} task - email's task object from Storage
   * @returns {Promise<void 0>}
   */
  async ___send(task) {
    this._debug('[private send]', task);
    try {
      if (task.isSent === true || task.isFailed === true || task.isCancelled === true) {
        return;
      }

      const tries = task.tries + 1;
      const isUpdated = await this.queue.update(task, {
        isSent: true,
        tries
      });

      if (!isUpdated) {
        logError('[private send] [queue.update] Not updated!');
        return;
      }

      task.tries = tries;
      task.isSent = true;

      let transport;
      let transportIndex;
      if (this.strategy === 'balancer') {
        this.transport = this.transport + 1;
        if (this.transport >= this.transports.length) {
          this.transport = 0;
        }
        transportIndex = this.transport;
        transport = this.transports[transportIndex];
      } else {
        transportIndex = task.transport;
        transport = this.transports[transportIndex];
      }

      const compiledOpts = this.___compileMailOpts(transport, task);

      await new Promise((resolve) => {
        transport.sendMail(compiledOpts, async (error, info) => {
          this._debug('[private send] [sending]', { error, info });
          if (error) {
            await this.___handleError(task, error, info);
            resolve();
            return;
          }

          if (!hasAcceptedRecipients(info)) {
            await this.___handleError(task, new Error('Message not accepted or Greeting never received'), info);
            resolve();
            return;
          }

          this._debug(`email successfully sent, attempts: #${task.tries}, transport #${transportIndex} to: `, compiledOpts.to);

          if (!this.keepHistory) {
            await this.queue.remove(task);
          }

          task.isSent = true;
          this.onSent(task, info);
          resolve();
        });
      });
    } catch (e) {
      logError('Exception during runtime:', e);
      await this.___handleError(task, e, {});
    }
  }

  /**
   * @memberOf MailTime
   * @name ___iterate
   * @description Iterate over queued tasks
   * @returns {Promise}
   */
  async ___iterate() {
    this._debug('[private iterate]');
    if (this.__isDestroyed) {
      return;
    }
    return await this.queue.iterate();
  }

  /**
   * @async
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
      throw new Error('[mail-time] [MailTime#ready] can not connect to storage, make sure it is available and properly configured');
    }

    return this;
  }
}

exports.MailTime = MailTime;
exports.MongoQueue = MongoQueue;
exports.PostgresQueue = PostgresQueue;
exports.RedisQueue = RedisQueue;

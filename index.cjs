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
   * @param {object} opts - configuration object
   * @param {Db} opts.db - Required, Mongo's `Db` instance, like one returned from `MongoClient#db()` method
   * @param {string} [opts.prefix] - Optional prefix for scope isolation; use when creating multiple MailTime instances within the single application
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
    ensureIndex(this.collection, { uuid: 1 }, { background: false });
    ensureIndex(this.collection, { isSent: 1, isFailed: 1, isCancelled: 1, to: 1, sendAt: 1 }, { background: false });
    ensureIndex(this.collection, { isSent: 1, isFailed: 1, isCancelled: 1, sendAt: 1, tries: 1 }, { background: false });

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
   * @returns {void 0}
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
    if (typeof task !== 'object') {
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
    if (typeof task !== 'object') {
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
    if (typeof task !== 'object' || typeof updateObj !== 'object') {
      return false;
    }

    return (await this.collection.updateOne({
      _id: task._id
    }, {
      $set: updateObj
    }))?.modifiedCount >= 1;
  }
}

/** Class representing Redis Queue for MailTime */
class RedisQueue {
  /**
   * Create a RedisQueue instance
   * @param {object} opts - configuration object
   * @param {RedisClient} opts.client - Required, Redis'es `RedisClient` instance, like one returned from `await redis.createClient().connect()` method
   * @param {string} [opts.prefix] - Optional prefix for scope isolation; use when creating multiple MailTime instances within the single application
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
   * @returns {void 0}
   */
  async iterate() {
    try {
      const now = Date.now();
      const cursor = this.client.scanIterator({
        TYPE: 'string',
        MATCH: this.__getKey('*', 'sendat'),
        COUNT: 9999,
      });

      for await (const sendatKey of cursor) {
        if (parseInt(await this.client.get(sendatKey)) <= now) {
          await this.mailTimeInstance.___send(JSON.parse(await this.client.get(this.__getKey(sendatKey.split(':')[3]))));
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
    if (!task || task.isSent === true || task.isCancelled === true || task.isFailed === true) {
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
    if (typeof task !== 'object') {
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
    if (typeof task !== 'object' || typeof task.uuid !== 'string') {
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
    if (typeof task !== 'object' || typeof task.uuid !== 'string' || typeof updateObj !== 'object') {
      return false;
    }

    const letterKey = this.__getKey(task.uuid, 'letter');

    try {
      const exists = await this.client.exists(letterKey);
      if (!exists) {
        return false;
      }
      const updatedTask = { ...task, ...updateObj };
      await this.client.set(letterKey, JSON.stringify(updatedTask));

      const sendatKey = this.__getKey(task.uuid, 'sendat');
      if (updatedTask.isSent === true || updatedTask.isFailed === true || updatedTask.isCancelled === true) {
        await this.client.del(sendatKey);
      } else if (task.sendAt) {
        await this.client.set(sendatKey, `${+task.sendAt}`);
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

const noop = () => {};

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
      if (!hasOwnProperty.call(b, akeys[i])) {
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

/** Class of MailTime */
class MailTime {
  /**
   * Create a MailTime instance
   * @param {object} opts - configuration object
   * @param {RedisQueue|MongoQueue|CustomQueue} opts.queue - Queue Storage Driver instance
   * @param {string} [opts.type] - "server" or "client" type of MailTime instance
   * @param {function} [opts.from] - A function returning *String* for `from` header, format: `"MyApp" <user@example.com>`
   * @param {[object]} [opts.transports] - An array of `nodemailer`'s transports, returned from `nodemailer.createTransport({})`; Required for `{type: 'server'}`
   * @param {string} [opts.strategy] - `backup` or `balancer`
   * @param {number} [opts.failsToNext] - After how many failed "send attempts" switch to the next transport? Applied only for `backup` strategy, default - `4`
   * @param {number} [opts.retries] - How many times resend failed emails
   * @param {number} [opts.retryDelay] - Interval in milliseconds between send re-tries
   * @param {boolean} [opts.keepHistory] - Keep queue task as it is in the database
   * @param {boolean} [opts.concatEmails] - Concatenate email by `to` field, default - `false`
   * @param {string} [opts.concatSubject] - Email subject used in concatenated email, default - `Multiple notifications`
   * @param {string} [opts.concatDelimiter] - HTML or plain string delimiter used between concatenated email, default - `<hr>`
   * @param {number} [opts.concatDelay] - HTML or plain string delimiter used between concatenated email, default - `<hr>`
   * @param {number} [opts.revolvingInterval] -  Interval in *milliseconds* in between queue checks, default - `256`
   * @param {object|RedisAdapter|MongoAdapter|CustomAdapter} [opts.josk.adapter] - Interval in milliseconds between send re-tries
   * @param {string} [opts.josk.adapter.type] - One of `mongo` or `redis`
   * @param {string} [opts.prefix] - Optional prefix for scope isolation; use when creating multiple MailTime instances within the single application; By default prefix inherited from MailTime instance
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
      this.maxTries = (opts.maxTries < 1) ? 1 : 0;
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
    this._debug(`INITIALIZING [retries: ${this.retries}]`);
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

      if (typeof opts.josk.adapter?.type === 'string' && opts.josk.adapter?.type === 'mongo') {
        if (!opts.josk.adapter.db) {
          throw new Error('[mail-time] {josk.adapter.db} option required for {josk.adapter.type: "mongo"}');
        }
        this.josk.adapter = new josk.MongoAdapter({ prefix: `mailTimeQueue${this.prefix}`, ...opts.josk.adapter });
      }

      if (typeof opts.josk.adapter?.type === 'string' && opts.josk.adapter?.type === 'redis') {
        if (!opts.josk.adapter.client) {
          throw new Error('[mail-time] {josk.adapter.client} option required for {josk.adapter.type: "redis"}');
        }
        this.josk.adapter = new josk.RedisAdapter({ prefix: `mailTimeQueue${this.prefix}`, ...opts.josk.adapter });
      }

      this.josk.minRevolvingDelay = (typeof opts.josk.minRevolvingDelay === 'number') ? opts.josk.minRevolvingDelay : 512;
      this.josk.maxRevolvingDelay = (typeof opts.josk.maxRevolvingDelay === 'number') ? opts.josk.maxRevolvingDelay : 2048;
      this.josk.zombieTime = (typeof opts.josk.zombieTime === 'number') ? opts.josk.zombieTime : 32786;

      this.scheduler = new josk.JoSk({
        debug: this.debug,
        ...this.josk,
      });

      process.nextTick(async () => {
        if ((await this.scheduler.ping()).status !== 'OK') {
          throw new Error('[mail-time] [MailTime#ping] can not connect to storage, make sure it is available and properly configured');
        }
      });

      this.scheduler.setInterval(this.___iterate.bind(this), this.revolvingInterval, `mailTimeQueue${this.prefix}`);
    }
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
   * @returns {Promise<object>}
   * @throws {mix}
   */
  async ping() {
    this._debug('[ping]');
    const schedulerPing = await this.scheduler.ping();
    if (schedulerPing.status !== 'OK') {
      return schedulerPing;
    }
    return await this.queue.ping();
  }

  /**
   * @memberOf MailTime
   * @name send
   * @description alias of `sendMail`
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
   * @param opts {object} - email options
   * @param opts.sendAt {Date|number}  - When email should be sent
   * @param opts.template {string} - Email-specific template
   * @param opts[key] {mix} - Other NodeMailer's options
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

        pendingMailOptions.push(opts);
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
   * @param uuid {string|Promise<string>} - uuid returned from `send` or `sendMail`
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
   * @param task {object} - Email task record form Storage
   * @param error {mix} - Error String/Object/Error
   * @param info {object} - Info object returned from nodemailer
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
   * @param opts {object} - Email options with next properties:
   * @param opts.sendAt {number} - When email should be sent
   * @param opts.template {string} - Email-specific template
   * @param opts.mailOptions {object} - MailOptions according to NodeMailer lib
   * @param opts.concatSubject {string} - Email subject used when sending concatenated email
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
   * @param string {string} - Template with Mustache-like placeholders
   * @param replacements {object} - Blaze/Mustache-like helpers Object
   * @returns {string}
   */
  ___render(_string, replacements) {
    let i;
    let string = _string;
    const matchHTML = string.match(/\{{3}\s?([a-zA-Z0-9\-\_]+)\s?\}{3}/g);
    if (matchHTML) {
      for (i = 0; i < matchHTML.length; i++) {
        if (replacements[matchHTML[i].replace('{{{', '').replace('}}}', '').trim()]) {
          string = string.replace(matchHTML[i], replacements[matchHTML[i].replace('{{{', '').replace('}}}', '').trim()]);
        }
      }
    }

    const matchStr = string.match(/\{{2}\s?([a-zA-Z0-9\-\_]+)\s?\}{2}/g);
    if (matchStr) {
      for (i = 0; i < matchStr.length; i++) {
        if (replacements[matchStr[i].replace('{{', '').replace('}}', '').trim()]) {
          string = string.replace(matchStr[i], replacements[matchStr[i].replace('{{', '').replace('}}', '').trim()].replace(/<(?:.|\n)*?>/gm, ''));
        }
      }
    }
    return string;
  }

  /**
   * @memberOf MailTime
   * @name ___compileMailOpts
   * @description Run various checks, compile options, and render template
   * @param transport {object} - Current transport
   * @param info {object} - Info object returned from NodeMailer's `sendMail` method
   * @returns {void 0}
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
      if (task.mailOptions[i].html) {
        if (task.mailOptions.length > 1) {
          compiledOpts.html += this.___render(this.concatDelimiter, task.mailOptions[i]) + this.___render(task.mailOptions[i].html, task.mailOptions[i]);
        } else {
          compiledOpts.html = this.___render(task.mailOptions[i].html, task.mailOptions[i]);
        }
        delete task.mailOptions[i].html;
      }

      if (task.mailOptions[i].text) {
        if (task.mailOptions.length > 1) {
          compiledOpts.text += '\r\n' + this.___render(task.mailOptions[i].text, task.mailOptions[i]);
        } else {
          compiledOpts.text = this.___render(task.mailOptions[i].text, task.mailOptions[i]);
        }
        delete task.mailOptions[i].text;
      }

      compiledOpts = merge(compiledOpts, task.mailOptions[i]);
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
   * @param task {object} - email's task object from Storage
   * @returns {Promise<void 0>}
   */
  async ___send(task) {
    this._debug('[private send]', task);
    try {
      if (task.isSent === true || task.isFailed === true || task.isCancelled === true) {
        return;
      }

      task.tries++;
      const isUpdated = await this.queue.update(task, {
        isSent: true,
        tries: task.tries
      });

      if (!isUpdated) {
        logError('[private send] [queue.update] Not updated!');
        return;
      }

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

          if (info.accepted && !info.accepted.length) {
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
      this.___handleError(task, e, {});
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
    return await this.queue.iterate();
  }
}

exports.MailTime = MailTime;
exports.MongoQueue = MongoQueue;
exports.RedisQueue = RedisQueue;

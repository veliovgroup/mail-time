import { logError } from '../helpers.js';

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
    // mailOptions.uuid    {string} - [REQUIRED]
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

export { RedisQueue };

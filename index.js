import { JoSk, RedisAdapter, MongoAdapter, PostgresAdapter } from 'josk';
import { randomUUID } from 'node:crypto';

import { MongoQueue } from './adapters/mongo.js';
import { RedisQueue } from './adapters/redis.js';
import { PostgresQueue } from './adapters/postgres.js';
import { mailTimePreset, presets, presetNames } from './presets.js';
import { debug, logError, deepMerge, equals, isPlainObject, extractEmail, toAddressList, filterAddressField } from './helpers.js';

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
        this.josk.adapter = new MongoAdapter(buildAdapterOptions());
      } else if (adapterType === 'redis') {
        if (!opts.josk.adapter.client) {
          throw new Error('[mail-time] {josk.adapter.client} option required for {josk.adapter.type: "redis"}');
        }
        this.josk.adapter = new RedisAdapter(buildAdapterOptions());
      } else if (adapterType === 'postgres') {
        if (!opts.josk.adapter.client) {
          throw new Error('[mail-time] {josk.adapter.client} option required for {josk.adapter.type: "postgres"}');
        }
        this.josk.adapter = new PostgresAdapter(buildAdapterOptions());
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

      this.scheduler = new JoSk({
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
      throw new Error('[mail-time] [sendMail] `html` nor `text` field is presented, at least one of those fields is required');
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
    const task = {
      uuid: randomUUID(),
      tries: 0,
      isSent: false,
      sendAt: opts.sendAt,
      isFailed: false,
      isSending: false,
      sendingAt: 0,
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

      let transportIndex;
      let transport;
      if (this.strategy === 'balancer') {
        this.transport = this.___nextHealthyTransport(this.transport);
        transportIndex = this.transport;
        transport = this.transports[transportIndex];
      } else {
        transportIndex = task.transport;
        if (!this.___isHealthyTransport(transportIndex)) {
          transportIndex = this.___nextHealthyTransport(transportIndex);
          task.transport = transportIndex;
        }
        transport = this.transports[transportIndex];
      }

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

export { MailTime, MongoQueue, RedisQueue, PostgresQueue, mailTimePreset, presets, presetNames };

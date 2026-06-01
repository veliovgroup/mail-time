import {
  logError,
  isSendClaimUpdate,
  isSendLeaseGuardedUpdate,
  isAppendMailOptionUpdate,
  stripInternalUpdateMeta,
  isSendLeaseRemove,
} from '../helpers.js';

/** Class representing Example Queue for MailTime */
class BlankQueue {
  /**
   * Create a BlankQueue instance
   * @param {object} opts - configuration object
   * @param {object} opts.requiredOption - Required option description
   * @param {string} [opts.prefix] - Optional prefix for scope isolation; use when creating multiple MailTime instances within the single application
   */
  constructor (opts) {
    this.name = 'queue-name';
    if (!opts || typeof opts !== 'object' || opts === null) {
      throw new TypeError('[mail-time] Configuration object must be passed into BlankQueue constructor');
    }

    if (!opts.requiredOption) {
      throw new Error('[mail-time] [BlankQueue] required {requiredOption} option is missing');
    }

    this.prefix = (typeof opts.prefix === 'string') ? opts.prefix : 'default';
    this.uniqueName = `mailtime:${this.prefix}`;
    this.requiredOption = opts.requiredOption;

    // Stored JSON structure:
    // uuid        {string}
    // to          {string|[string]}
    // tries       {number}  - qty of send attempts
    // sendAt      {number}  - When letter should be sent
    // isSent      {boolean} - `true` once delivery has fully completed
    // isCancelled {boolean} - `true` if email was cancelled before it was sent
    // isFailed    {boolean} - `true` if email has failed to send
    // isSending   {boolean} - `true` while one worker is performing the SMTP roundtrip; released back to `false` on success/retry/failure
    // sendingAt   {number}  - Timestamp when `isSending` was set; older than `now - sendingTimeout` means the row is recoverable
    // template    {string}  - Template for this email
    // transport   {number}  - Last used transport
    // concatSubject {string|boolean} - Email concatenation subject
    // ---
    // mailOptions         {[object]}  - Array of nodemailer's `mailOptions`
    // mailOptions.to      {string|[string]} - [REQUIRED]
    // mailOptions.from    {string}
    // mailOptions.text    {string|boolean}
    // mailOptions.html    {string}
    // mailOptions.subject {string}
    // mailOptions.Other nodemailer `sendMail` options...
  }

  /**
   * @async
   * @memberOf BlankQueue
   * @name ping
   * @description Check connection to Storage
   * @returns {Promise<object>}
   */
  async ping() {
    // LEAVE THIS if BLOCK UNCHANGED
    if (!this.mailTimeInstance) {
      return {
        status: 'Service Unavailable',
        code: 503,
        statusCode: 503,
        error: new Error('MailTime instance not yet assigned to {mailTimeInstance} of Queue Adapter context'),
      };
    }

    try {
      const ping = await this.requiredOption.ping();
      if (ping === 'PONG') {
        return {
          status: 'OK',
          code: 200,
          statusCode: 200,
        };
      }

      throw new Error(`Unexpected response from Storage#ping received: ${ping}`);
    } catch (pingError) {
      return {
        status: 'Internal Server Error',
        code: 500,
        statusCode: 500,
        error: pingError
      };
    }
  }

  /**
   * @async
   * @memberOf BlankQueue
   * @name ready
   * @description optional hook; called by MailTime during initialization if present. Implement any async index/schema setup here and await it.
   * @returns {Promise<void 0>}
   */
  async ready() {
    // Optional. Implement if your storage needs async setup (e.g. ensure table/index).
    // MailTime does: if (typeof queue.ready === 'function') await queue.ready();
    this.__ensurePrefix?.();
    return void 0;
  }

  /**
   * @memberOf BlankQueue
   * @name iterate
   * @description iterate over queued emails passing each to `mailTimeInstance.___dispatch` (the bounded send pool); `___dispatch` returns once a pool slot is acquired so the scan can release the JoSk lease while the SMTP roundtrip continues in the background
   * @param {{ limit?: number, sendingTimeout?: number }} [opts] - iteration options. Honor `opts.limit` (stop after that many dispatches) for `mode: 'one'`, and use `opts.sendingTimeout` (ms) to reclaim rows whose worker died mid-send.
   * @returns {Promise<void>}
   */
  async iterate(opts) {
    // GET EMAILS WITHIN this.uniqueName SCOPE!
    // PREDICATE:
    //   isSent      = false
    //   isFailed    = false
    //   isCancelled = false
    //   sendAt      <= now
    //   tries       < mailTimeInstance.maxTries
    //   (isSending  = false OR sendingAt <= now - sendingTimeout)  -- include stale-locked rows for recovery
    // STOP AFTER opts.limit dispatches when opts.limit is set (mode: 'one' passes 1).
    const now = Date.now();
    const sendingTimeout = (opts && typeof opts.sendingTimeout === 'number' && opts.sendingTimeout > 0) ? opts.sendingTimeout : 300000;
    const limit = (opts && typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0) ? Math.floor(opts.limit) : 0;

    const cursorWithEmails = this.requiredOption.getEmails({
      scope: this.uniqueName,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      tries: {
        $lt: this.mailTimeInstance.maxTries
      },
      sendAt: {
        $lte: now
      },
      $or: [
        { isSending: { $ne: true } },
        { sendingAt: { $lte: now - sendingTimeout } }
      ]
    });

    let dispatched = 0;
    for await (const emailObj of cursorWithEmails) {
      // ___dispatch returns once a pool slot is acquired and the send has started.
      // The SMTP roundtrip continues in the background, so this `for await` releases
      // the JoSk lease as soon as the scan completes.
      await this.mailTimeInstance.___dispatch(emailObj);
      dispatched++;
      if (limit > 0 && dispatched >= limit) {
        break;
      }
    }
  }

  /**
   * @async
   * @memberOf BlankQueue
   * @name getPendingTo
   * @description get queued email by `to` field (addressee)
   * @param to {string} - email address
   * @param sendAt {number} - timestamp
   * @returns {Promise<object|null>}
   */
  async getPendingTo(to, sendAt) {
    if (typeof to !== 'string' || typeof sendAt !== 'number') {
      return null;
    }

    const email = await this.requiredOption.get({
      to: to,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      tries: {
        $lt: this.mailTimeInstance.maxTries
      },
      sendAt: {
        $lte: sendAt // Number (timestamp)
      }
    });

    if (!email || email.isSent === true || email.isCancelled === true || email.isFailed === true || email.isSending === true || email.tries >= this.mailTimeInstance.maxTries) {
      return null;
    }

    return email;
  }

  /**
   * @async
   * @memberOf BlankQueue
   * @name push
   * @description push email to the queue/storage
   * @param email {object} - email's object
   * @returns {Promise<void 0>}
   */
  async push(email) {
    if (typeof email !== 'object') {
      return;
    }

    if (email.sendAt instanceof Date) {
      email.sendAt = +email.sendAt;
    }

    await this.requiredOption.save(email);
  }

  /**
   * @async
   * @memberOf BlankQueue
   * @name cancel
   * @description cancel scheduled email
   * @param uuid {string} - email's uuid
   * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found, was sent, or was cancelled previously
   */
  async cancel(uuid) {
    if (typeof uuid !== 'string') {
      return false;
    }

    const email = JSON.parse(await this.requiredOption.get({
      uuid: uuid
    }));

    if (!email || email.isSent === true || email.isCancelled === true) {
      return false;
    }

    if (!this.mailTimeInstance.keepHistory) {
      return await this.remove(email);
    }

    return await this.update(email, {
      isCancelled: true,
    });
  }

  /**
   * @async
   * @memberOf BlankQueue
   * @name remove
   * @description remove email from queue
   * @param email {object} - email's object
   * @param {{ leaseTries: number, leaseSendingAt: number }} [opts] - lease guard: only remove if this worker still holds the lease (tries + sendingAt match, row not cancelled/failed)
   * @returns {Promise<boolean>} returns `true` if removed or `false` if not found
   */
  async remove(email, opts) {
    if (typeof email !== 'object' || typeof email.uuid !== 'string') {
      return false;
    }

    const query = { uuid: email.uuid };
    if (isSendLeaseRemove(opts)) {
      Object.assign(query, {
        tries: opts.leaseTries,
        isSending: true,
        sendingAt: opts.leaseSendingAt,
        isCancelled: false,
        isFailed: false,
      });
    }

    return await this.requiredOption.remove(query);
  }

  /**
   * @async
   * @memberOf BlankQueue
   * @name update
   * @description update email in queue
   * @param email {object} - email's object
   * @param updateObj {object} - fields with new values to update
   * @returns {Promise<boolean>} returns `true` if updated or `false` if not found or no changes was made
   */
  async update(email, updateObj) {
    if (!email || typeof email !== 'object' || typeof email.uuid !== 'string' || !updateObj || typeof updateObj !== 'object') {
      return false;
    }

    const query = {
      uuid: email.uuid
    };
    if (isAppendMailOptionUpdate(updateObj)) {
      Object.assign(query, {
        isSent: false,
        isFailed: false,
        isCancelled: false,
        isSending: false,
      });
      return await this.requiredOption.appendMailOption(query, updateObj.appendMailOption);
    }
    // CLAIM GUARD: when the caller sets `isSending: true` with a new `tries` value,
    // this is the atomic-claim update. The storage layer MUST honor the predicate
    // below so two workers can never simultaneously claim the same row.
    if (isSendClaimUpdate(updateObj)) {
      const now = typeof updateObj.sendingAt === 'number' ? updateObj.sendingAt : Date.now();
      const sendingTimeout = this.mailTimeInstance?.sendingTimeout || 300000;
      Object.assign(query, {
        isSent: false,
        isFailed: false,
        isCancelled: false,
        tries: email.tries,
        $or: [
          { isSending: { $ne: true } },
          { sendingAt: { $lte: now - sendingTimeout } }
        ]
      });
    } else if (isSendLeaseGuardedUpdate(updateObj)) {
      Object.assign(query, {
        tries: updateObj.leaseTries,
        isSending: true,
        sendingAt: updateObj.leaseSendingAt,
        isCancelled: false,
        isFailed: false,
      });
    }

    const updatedEmail = { ...email, ...stripInternalUpdateMeta(updateObj) };
    return await this.requiredOption.update(query, updatedEmail);
  }
}

export { BlankQueue };

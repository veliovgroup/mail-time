import { logError } from '../helpers.js';

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
   * @memberOf BlankQueue
   * @name iterate
   * @description iterate over queued emails passing to `mailTimeInstance.___send` method
   * @returns {void 0}
   */
  async iterate() {
    // GET EMAILS WITHIN this.uniqueName SCOPE!
    // AND ONLY WHERE sendAt <= now
    // RUN ONE BY ONE VIA this.mailTimeInstance.___send() METHOD
    const cursorWithEmails = this.requiredOption.getEmails({
      scope: this.uniqueName,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      sendAt: {
        $lte: Date.now() // Number (timestamp)
      }
    });

    for await (const emailObj of cursorWithEmails) {
      await this.mailTimeInstance.___send(emailObj);
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
      sendAt: {
        $lte: sendAt // Number (timestamp)
      }
    });

    if (!email || email.isSent === true || email.isCancelled === true || email.isFailed === true) {
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
   * @returns {Promise<boolean>} returns `true` if removed or `false` if not found
   */
  async remove(email) {
    if (typeof email !== 'object' || typeof email.uuid !== 'string') {
      return false;
    }

    return await this.requiredOption.remove({
      uuid: email.uuid
    });
  }

  /**
   * @async
   * @memberOf BlankQueue
   * @name update
   * @description remove email from queue
   * @param email {object} - email's object
   * @param updateObj {object} - fields with new values to update
   * @returns {Promise<boolean>} returns `true` if updated or `false` if not found or no changes was made
   */
  async update(email, updateObj) {
    if (typeof email !== 'object' || typeof email.uuid !== 'string' || typeof updateObj !== 'object') {
      return false;
    }

    const updatedEmail = { ...email, ...updateObj };
    return await this.requiredOption.update({
      uuid: email.uuid
    }, updatedEmail);
  }
}

export { BlankQueue };

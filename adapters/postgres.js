import { logError } from '../helpers.js';

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

export { PostgresQueue };

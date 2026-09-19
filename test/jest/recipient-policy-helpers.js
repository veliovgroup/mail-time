import { MailTime } from '../../index.js';
import { createSchedulerAdapter } from './helpers.js';

export const deferred = () => {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};

export const createPolicyQueue = () => {
  const records = new Map();
  const active = (row) => row && !row.isSent && !row.isFailed && !row.isCancelled && !row.isSettled;
  const owns = (row, guard) => active(row) && row.isSending && row.tries === guard.leaseTries && row.sendingAt === guard.leaseSendingAt;
  const queue = {
    records, supportsRecipientPolicies: true, mailTimeInstance: null,
    async ready() {},
    async ping() { return { status: 'OK', code: 200, statusCode: 200 }; },
    async push(task) { records.set(task.uuid, structuredClone(task)); },
    async iterate(opts = {}) {
      const now = Date.now();
      const timeout = opts.sendingTimeout || queue.mailTimeInstance.sendingTimeout;
      let count = 0;
      for (const row of records.values()) {
        const stale = row.isSending && row.sendingAt <= now - timeout;
        if (!active(row) || row.sendAt > now || (row.isSending && !stale)) continue;
        if (row.tries >= queue.mailTimeInstance.maxTries && !(stale && Array.isArray(row.recipientResults))) continue;
        await queue.mailTimeInstance.___dispatch(structuredClone(row));
        if (opts.limit && ++count >= opts.limit) break;
      }
    },
    async getPendingTo(to, sendAt) {
      for (const row of records.values()) {
        if (active(row) && !row.isSending && !Array.isArray(row.recipientResults) && row.to === to && row.sendAt <= sendAt && row.tries < queue.mailTimeInstance.maxTries) return structuredClone(row);
      }
      return null;
    },
    async update(task, fields) {
      const row = records.get(task.uuid);
      if (!active(row)) return false;
      if (fields.appendMailOption !== void 0) {
        if (row.isSending || Array.isArray(row.recipientResults)) return false;
        row.mailOptions.push(structuredClone(fields.appendMailOption));
        return true;
      }
      if (fields.isSending === true && typeof fields.tries === 'number') {
        const timeout = queue.mailTimeInstance.sendingTimeout;
        if (row.tries !== task.tries || (row.isSending && row.sendingAt > fields.sendingAt - timeout)) return false;
      } else if (typeof fields.leaseTries === 'number' && !owns(row, fields)) return false;
      const next = structuredClone(fields);
      delete next.leaseTries;
      delete next.leaseSendingAt;
      Object.assign(row, next);
      return true;
    },
    async remove(task, guard) {
      const row = records.get(task.uuid);
      if (!row || (guard && !owns(row, guard))) return false;
      return records.delete(task.uuid);
    },
    async cancel(uuid) {
      const row = records.get(uuid);
      if (!active(row)) return false;
      if (queue.mailTimeInstance.keepHistory) row.isCancelled = true;
      else records.delete(uuid);
      return true;
    },
  };
  return queue;
};

export const createPolicyMailTime = (opts = {}) => new MailTime({
  queue: createPolicyQueue(),
  josk: { adapter: createSchedulerAdapter(), minRevolvingDelay: 60000, maxRevolvingDelay: 60000 },
  transports: [{ options: { from: 'sender@example.com' }, sendMail(mail, done) { done(null, { accepted: mail.envelope.to }); } }],
  from: 'sender@example.com',
  verifyTransports: false, keepHistory: true, retryDelay: 0, retries: 1,
  recipientPolicies: [{ name: 'abstain', beforeSend() {} }],
  ...opts,
});

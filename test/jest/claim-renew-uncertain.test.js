import { afterEach, expect, it, jest } from '@jest/globals';

import { MailTime } from '../../index.js';
import { createQueue, createSchedulerAdapter } from './helpers.js';

const instances = [];
afterEach(() => { jest.restoreAllMocks(); for (const i of instances.splice(0)) { i.destroy(); i.scheduler?.destroy?.(); } });

// createQueue().update mirrors persisted fields onto the task it receives, which would
// heal a stale guard. The renewal write therefore gets a clone: storage applies it, the task stays stale.
const run = async ({ takeover, destroyOnOutcome = false, sendingTimeout, renewClaim = 20, unapplied = false, peerCollide = false }) => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const onError = jest.fn();
  const onSent = jest.fn();
  const queue = createQueue();
  const mt = new MailTime({
    queue, onError, onSent, renewClaim, maxRenewals: 100, keepHistory: true, verifyTransports: false, ...(sendingTimeout ? { sendingTimeout } : {}),
    josk: { adapter: createSchedulerAdapter(), minRevolvingDelay: 60000, maxRevolvingDelay: 60000 },
    transports: [{ options: {}, sendMail: (mail, done) => setTimeout(() => done(null, { accepted: [mail.to] }), 120) }],
    from: 'sender@example.com',
  });
  instances.push(mt);
  const uuid = await mt.sendMail({ to: 'a@example.com', text: 'hello' });
  const realUpdate = queue.update.bind(queue);
  let thrown = 0;
  let outcomeWrites = 0;
  queue.update = async (task, fields) => {
    if (fields.isSent === true) { outcomeWrites++; if (destroyOnOutcome && outcomeWrites === 1) mt.destroy(); }
    const isRenew = fields.isSending === true && fields.tries === void 0 && typeof fields.leaseTries === 'number' && fields.sendingAt > 0;
    if (!isRenew) return realUpdate(task, fields);
    if (unapplied && thrown === 0) {
      thrown++;
      if (peerCollide) queue.records.get(uuid).sendingAt = fields.sendingAt;
      throw new Error('renewal failed, not applied');
    }
    const result = await realUpdate({ ...task }, fields);
    if (thrown++ === 0) {
      if (takeover) queue.records.get(uuid).sendingAt += 100000;
      throw new Error('ack lost');
    }
    return result;
  };
  await mt.___send({ ...queue.records.get(uuid) });
  const { failedWrites } = await mt.drain();
  return { failedWrites, onError, onSent, row: queue.records.get(uuid), thrown, outcomeWrites };
};

it('non-policy: a lost renewal ack recovers with one retry and completes cleanly', async () => {
  const { failedWrites, onError, onSent, row, thrown } = await run({ takeover: false });
  expect(thrown).toBeGreaterThanOrEqual(1);
  expect(failedWrites).toBe(0);
  expect(onError).not.toHaveBeenCalled();
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(row.isSent).toBe(true);
});

it('non-policy: a lost renewal ack plus a peer takeover is reported once', async () => {
  const { failedWrites, onError, onSent, row } = await run({ takeover: true });
  expect(failedWrites).toBe(1);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0][0].message).toMatch(/outcome write lost/);
  expect(onError.mock.calls[0][2].phase).toBe('complete');
  expect(onSent).not.toHaveBeenCalled();
  expect(row.isSending).toBe(true);
});

it('non-policy: destroy() inside the first outcome write skips the retry and counts the loss', async () => {
  const { onSent, outcomeWrites, failedWrites, onError } = await run({ takeover: false, destroyOnOutcome: true });
  expect(outcomeWrites).toBe(1);
  expect(onSent).not.toHaveBeenCalled();
  expect(failedWrites).toBe(1);
  expect(onError).not.toHaveBeenCalled();
});

it('non-policy: an unapplied renewal error on attempt 1 does not leak into attempt 2 on the same task object', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const onError = jest.fn();
  const queue = createQueue();
  let calls = 0;
  let uuid;
  const mt = new MailTime({
    queue, onError, renewClaim: 20, maxRenewals: 100, keepHistory: true, verifyTransports: false, retries: 3, retryDelay: 0,
    josk: { adapter: createSchedulerAdapter(), minRevolvingDelay: 60000, maxRevolvingDelay: 60000 },
    transports: [{ options: {}, sendMail: (mail, done) => {
      calls++;
      if (calls === 1) { setTimeout(() => done(new Error('smtp down')), 100); return; }
      // Attempt 2: a peer legitimately takes the row over (tries bump, later stamp).
      setTimeout(() => {
        const row = queue.records.get(uuid);
        row.tries += 1; row.sendingAt += 100000;
        done(null, { accepted: [mail.to] });
      }, 30);
    } }],
    from: 'sender@example.com',
  });
  instances.push(mt);
  uuid = await mt.sendMail({ to: 'a@example.com', text: 'hello' });
  const realUpdate = queue.update.bind(queue);
  let thrown = 0;
  queue.update = async (task, fields) => {
    const isRenew = fields.isSending === true && fields.tries === void 0 && typeof fields.leaseTries === 'number' && fields.sendingAt > 0;
    if (isRenew && thrown++ === 0) throw new Error('renewal failed, not applied');
    return realUpdate(task, fields);
  };
  const task = { ...queue.records.get(uuid) };
  await mt.___send(task);
  expect(thrown).toBe(1);
  task.sendAt = 0;
  await mt.___send(task);
  const { failedWrites } = await mt.drain();
  expect(calls).toBe(2);
  expect(failedWrites).toBe(0);
  expect(onError).not.toHaveBeenCalled();
});

it('non-policy gate: a stale-claim renewal error never retries into a peer row with a colliding stamp', async () => {
  const { failedWrites, onError, onSent, row, outcomeWrites } = await run({ takeover: false, sendingTimeout: 30, renewClaim: 60, unapplied: true, peerCollide: true });
  expect(outcomeWrites).toBe(1);
  expect(onSent).not.toHaveBeenCalled();
  expect(row.isSent).toBe(false);
  expect(row.isSending).toBe(true);
  expect(failedWrites).toBe(1);
  expect(onError).toHaveBeenCalledTimes(1);
});

it('non-policy: stale claim, renewal applied then threw, no peer: reported once, no retry', async () => {
  const { failedWrites, onError, onSent, outcomeWrites } = await run({ takeover: false, sendingTimeout: 30, renewClaim: 60 });
  expect(outcomeWrites).toBe(1);
  expect(failedWrites).toBe(1);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0][0].message).toMatch(/outcome write lost/);
  expect(onSent).not.toHaveBeenCalled();
});

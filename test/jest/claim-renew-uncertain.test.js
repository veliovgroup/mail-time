import { afterEach, expect, it, jest } from '@jest/globals';

import { MailTime } from '../../index.js';
import { createQueue, createSchedulerAdapter } from './helpers.js';

const instances = [];
afterEach(() => { jest.restoreAllMocks(); for (const i of instances.splice(0)) { i.destroy(); i.scheduler?.destroy?.(); } });

// createQueue().update mirrors persisted fields onto the task it receives, which would
// heal a stale guard. The renewal write therefore gets a clone: storage applies it, the task stays stale.
const run = async ({ takeover }) => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const onError = jest.fn();
  const onSent = jest.fn();
  const queue = createQueue();
  const mt = new MailTime({
    queue, onError, onSent, renewClaim: 20, maxRenewals: 100, keepHistory: true, verifyTransports: false,
    josk: { adapter: createSchedulerAdapter(), minRevolvingDelay: 60000, maxRevolvingDelay: 60000 },
    transports: [{ options: {}, sendMail: (mail, done) => setTimeout(() => done(null, { accepted: [mail.to] }), 120) }],
    from: 'sender@example.com',
  });
  instances.push(mt);
  const uuid = await mt.sendMail({ to: 'a@example.com', text: 'hello' });
  const realUpdate = queue.update.bind(queue);
  let thrown = 0;
  queue.update = async (task, fields) => {
    const isRenew = fields.isSending === true && fields.tries === void 0 && typeof fields.leaseTries === 'number' && fields.sendingAt > 0;
    if (!isRenew) return realUpdate(task, fields);
    const result = await realUpdate({ ...task }, fields);
    if (thrown++ === 0) {
      if (takeover) queue.records.get(uuid).sendingAt += 100000;
      throw new Error('ack lost');
    }
    return result;
  };
  await mt.___send({ ...queue.records.get(uuid) });
  const { failedWrites } = await mt.drain();
  return { failedWrites, onError, onSent, row: queue.records.get(uuid), thrown };
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

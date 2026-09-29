import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { MailTime } from '../../index.js';
import { createQueue, createSchedulerAdapter } from './helpers.js';
import { createPolicyMailTime } from './recipient-policy-helpers.js';

const instances = [];
const okTransport = () => ({ options: { from: 'sender@example.com' }, sendMail: (mail, done) => done(null, { accepted: [mail.to], response: 'OK' }) });
const failTransport = () => ({ options: { from: 'sender@example.com' }, sendMail: (mail, done) => done(new Error('smtp down')) });

const make = (opts = {}) => {
  const mt = new MailTime({
    queue: createQueue(),
    transports: [okTransport()],
    from: 'sender@example.com',
    verifyTransports: false,
    retryDelay: 0,
    josk: { adapter: createSchedulerAdapter(), minRevolvingDelay: 60000, maxRevolvingDelay: 60000 },
    ...opts,
  });
  instances.push(mt);
  return mt;
};

// Make every queue write that records an outcome (not the claim) throw.
const breakCompletionWrites = (queue, error = new Error('db write failed')) => {
  const update = queue.update.bind(queue);
  const remove = queue.remove.bind(queue);
  queue.update = async (task, fields) => {
    if (fields.isSending === false) throw error;
    return await update(task, fields);
  };
  queue.remove = async () => { throw error; };
  return error;
};

const run = async (mt, task) => {
  const uuid = await mt.sendMail({ to: 'a@example.com', text: 'hello' });
  await mt.___dispatch(structuredClone(mt.queue.records.get(uuid) || task));
  return uuid;
};

let unhandled = [];
const onUnhandled = (reason) => unhandled.push(reason);
process.on('unhandledRejection', onUnhandled);

afterEach(() => {
  jest.restoreAllMocks();
  for (const i of instances.splice(0)) { i.destroy?.(); i.scheduler?.destroy?.(); }
  unhandled = [];
});

describe('completion-write visibility', () => {
  it('drain() reports zero failures when writes succeed', async () => {
    const onError = jest.fn();
    const onSent = jest.fn();
    const mt = make({ onError, onSent });
    await run(mt);
    await expect(mt.drain()).resolves.toEqual({ failedWrites: 0 });
    expect(onSent).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('a failed success write reports onError once with phase complete and drain settles', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => {});
    const onError = jest.fn();
    const onSent = jest.fn();
    const mt = make({ onError, onSent });
    const error = breakCompletionWrites(mt.queue);
    const uuid = await run(mt);
    const result = await mt.drain();
    expect(result).toEqual({ failedWrites: 1 });
    expect(onError).toHaveBeenCalledTimes(1);
    const [err, task, details] = onError.mock.calls[0];
    expect(err).toBe(error);
    expect(task.uuid).toBe(uuid);
    expect(details).toMatchObject({ phase: 'complete', attempt: 1, transportIndex: 0 });
    expect(onSent).not.toHaveBeenCalled();
    // At-least-once: the row stays claimed for stale-lock recovery.
    expect(mt.queue.records.get(uuid)).toMatchObject({ isSending: true, isSent: false });
    expect(log).toHaveBeenCalled();
    await new Promise((r) => setImmediate(r));
    expect(unhandled).toEqual([]);
  });

  it('a failed retry-release write after an SMTP error is surfaced', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const onError = jest.fn();
    const mt = make({ transports: [failTransport()], onError });
    breakCompletionWrites(mt.queue);
    await run(mt);
    expect(await mt.drain()).toEqual({ failedWrites: 1 });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][2].phase).toBe('complete');
  });

  it('a failed write after a synchronous transport throw is surfaced, not left unhandled', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const onError = jest.fn();
    const mt = make({ transports: [{ options: { from: 'sender@example.com' }, sendMail() { throw new Error('sync'); } }], onError });
    breakCompletionWrites(mt.queue);
    await run(mt);
    expect(await mt.drain()).toEqual({ failedWrites: 1 });
    expect(onError).toHaveBeenCalledTimes(1);
    await new Promise((r) => setImmediate(r));
    expect(unhandled).toEqual([]);
  });

  it('an async throwing onError does not cause an unhandled rejection', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const mt = make({ onError: async () => { throw new Error('hook'); } });
    breakCompletionWrites(mt.queue);
    await run(mt);
    await mt.drain();
    await new Promise((r) => setImmediate(r));
    expect(unhandled).toEqual([]);
  });

  it('failedWrites is cumulative across sends', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const mt = make();
    breakCompletionWrites(mt.queue);
    await run(mt);
    expect((await mt.drain()).failedWrites).toBe(1);
    await run(mt);
    expect((await mt.drain()).failedWrites).toBe(2);
  });

  it('a non-draining destroy suppresses onError for a failing write', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const onError = jest.fn();
    let release;
    const gate = new Promise((r) => { release = r; });
    const mt = make({ onError, transports: [{ options: {}, sendMail: (mail, done) => gate.then(() => done(null, { accepted: [mail.to] })) }] });
    breakCompletionWrites(mt.queue);
    await run(mt);
    mt.destroy();
    release();
    await mt.drain();
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('completion-write visibility with recipient policies', () => {
  const failOn = (queue, predicate, error = new Error('policy db write failed')) => {
    const update = queue.update.bind(queue);
    queue.update = async (task, fields) => {
      if (predicate(fields)) throw error;
      return await update(task, fields);
    };
    return error;
  };

  it('a failed policy finish write reports phase complete once', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const onError = jest.fn();
    const mt = createPolicyMailTime({ onError });
    instances.push(mt);
    const error = failOn(mt.queue, (f) => f.isSettled === true);
    const uuid = await mt.sendMail({ to: 'a@example.com', text: 'hello' });
    await mt.___dispatch(structuredClone(mt.queue.records.get(uuid)));
    expect(await mt.drain()).toEqual({ failedWrites: 1 });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(error);
    expect(onError.mock.calls[0][2]).toMatchObject({ phase: 'complete' });
    expect(mt.queue.records.get(uuid)).toMatchObject({ isSending: true, isSettled: false });
  });

  it('a failed post-SMTP checkpoint write reports phase checkpoint', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const onError = jest.fn();
    const mt = createPolicyMailTime({ onError });
    instances.push(mt);
    failOn(mt.queue, (f) => Array.isArray(f.recipientResults) && f.recipientResults.some((r) => r.status === 'sent') && f.isSettled !== true);
    const uuid = await mt.sendMail({ to: 'a@example.com', text: 'hello' });
    await mt.___dispatch(structuredClone(mt.queue.records.get(uuid)));
    const { failedWrites } = await mt.drain();
    expect(failedWrites).toBeGreaterThanOrEqual(1);
    expect(onError.mock.calls.some(([, , d]) => d.phase === 'checkpoint')).toBe(true);
  });

  it('no failure and no onError when policy writes succeed', async () => {
    const onError = jest.fn();
    const mt = createPolicyMailTime({ onError });
    instances.push(mt);
    const uuid = await mt.sendMail({ to: 'a@example.com', text: 'hello' });
    await mt.___dispatch(structuredClone(mt.queue.records.get(uuid)));
    expect(await mt.drain()).toEqual({ failedWrites: 0 });
    expect(onError).not.toHaveBeenCalled();
    expect(mt.queue.records.get(uuid)).toMatchObject({ isSettled: true, isSent: true });
  });
});

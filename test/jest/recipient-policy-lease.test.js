import { expect, it, jest } from '@jest/globals';
import { RecipientPolicyLease } from '../../recipient-policy-lease.js';
import { deferred } from './recipient-policy-helpers.js';

const create = (overrides = {}) => new RecipientPolicyLease({ task: { uuid: 'u', tries: 1, isSending: true, sendingAt: 100 }, queue: { update: async () => true }, interval: 0, maxRenewals: 1, sendingTimeout: 1e15, shouldAbort: () => false, report() {}, ...overrides });

it('constructs checkpoint guards after an in-flight renewal settles', async () => {
  const entered = deferred();
  const release = deferred();
  const guards = [];
  const lease = create({ interval: 5, queue: { async update(task, fields) {
    guards.push(fields.leaseSendingAt);
    if (guards.length === 1) { entered.resolve(); await release.promise; }
    return true;
  } } });
  try {
    await entered.promise;
    const checkpoint = lease.update({ recipientResults: [] });
    release.resolve();
    expect(await checkpoint).toBe(true);
    expect(guards[0]).toBe(100);
    expect(guards[1]).toBeGreaterThan(100);
  } finally { release.resolve(); await lease.stop(); }
});
it('serializes a terminal removal behind a checkpoint and allows it only once', async () => {
  const entered = deferred();
  const release = deferred();
  const task = { uuid: 'u', tries: 1, isSending: true, sendingAt: 100 };
  const events = [];
  const lease = create({ task, queue: {
    async update() { entered.resolve(); await release.promise; events.push('update'); return true; },
    async remove(_task, guard) { events.push(['remove', guard]); return true; },
  } });
  const checkpoint = lease.update({ recipientResults: [] });
  await entered.promise;
  const finish = lease.finish({ isSettled: true, isSending: false }, true);
  release.resolve();
  expect(await checkpoint).toBe(true);
  expect(await finish).toBe(true);
  expect(await lease.finish({ isSettled: true }, true)).toBe(false);
  expect(events).toEqual(['update', ['remove', { leaseTries: 1, leaseSendingAt: 100 }]]);
  expect(task.isSettled).toBe(true);
  await lease.stop();
});
it.each([false, new Error('storage')])('stops permanently after failed writes: %s', async (failure) => {
  const report = jest.fn();
  const update = jest.fn(async () => { if (failure instanceof Error) throw failure; return false; });
  const lease = create({ report, queue: { update } });
  expect(await lease.update({ recipientResults: [] })).toBe(false);
  expect(await lease.update({ recipientResults: [] })).toBe(false);
  expect(update).toHaveBeenCalledTimes(1);
  expect(lease.active).toBe(false);
  await lease.stop();
});
it('does not mirror failed completion and honors abort before queued writes', async () => {
  let abort = false;
  const task = { tries: 1, isSending: true, sendingAt: 100 };
  const lease = create({ task, shouldAbort: () => abort });
  const write = lease.update({ recipientResults: [] });
  abort = true;
  expect(await write).toBe(false);
  expect(task.recipientResults).toBeUndefined();
  expect(await lease.finish({ isSettled: true }, false)).toBe(false);
  expect(task.isSettled).toBeUndefined();
  await lease.stop();
});
it('exhausted renewal budget keeps checkpoints available without overlapping writes', async () => {
  const renewed = deferred();
  const task = { tries: 1, isSending: true, sendingAt: 100 };
  let count = 0;
  const lease = create({ task, interval: 5, queue: { async update() { count++; renewed.resolve(); return true; } } });
  try {
    await renewed.promise;
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(count).toBe(1);
    expect(lease.active).toBe(true);
    expect(await lease.finish({ isSending: false }, false)).toBe(true);
    expect(count).toBe(2);
  } finally { await lease.stop(); }
});
it('holds at most one pending renewal behind a slow write', async () => {
  const entered = deferred();
  const release = deferred();
  let count = 0;
  const lease = create({ interval: 5, maxRenewals: 10, queue: { async update() { count++; entered.resolve(); await release.promise; return true; } } });
  await entered.promise;
  await new Promise((resolve) => setTimeout(resolve, 20));
  const stopping = lease.stop();
  release.resolve();
  await stopping;
  expect(count).toBe(1);
});
it('disables the timer with a zero budget', async () => {
  const update = jest.fn(async () => true);
  const lease = create({ interval: 1, maxRenewals: 0, queue: { update } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  expect(update).not.toHaveBeenCalled();
  await lease.stop();
});
it('an uncertain renewal retries the outcome write once with the attempted stamp', async () => {
  const guards = [];
  const reports = [];
  const task = { uuid: 'u', tries: 1, isSending: true, sendingAt: 100 };
  const lease = create({ task, interval: 5, maxRenewals: 1, sendingTimeout: 1e15, report: (e, phase) => reports.push([e.message, phase]), queue: {
    async update(_t, fields) {
      guards.push(fields.leaseSendingAt);
      if (fields.sendingAt > 100 && guards.length === 1) throw new Error('ack lost');
      return fields.leaseSendingAt !== 100;
    },
    async remove() { return false; },
  } });
  await new Promise((r) => setTimeout(r, 30));
  expect(lease.__renewUncertain).toBe(true);
  expect(await lease.update({ recipientResults: [] })).toBe(true);
  expect(guards[1]).toBe(100);
  expect(guards[2]).toBeGreaterThan(100);
  expect(reports.filter(([, p]) => p !== 'renew')).toEqual([]);
  await lease.stop();
});
it('an uncertain renewal whose retry also fails reports once', async () => {
  const reports = [];
  const task = { uuid: 'u', tries: 1, isSending: true, sendingAt: 100 };
  const lease = create({ task, interval: 5, maxRenewals: 1, sendingTimeout: 1e15, report: (e, phase) => reports.push([e.message, phase]), queue: {
    async update(_t, fields) { if (fields.sendingAt > 100 && fields.isSending === true && !fields.recipientResults) throw new Error('ack lost'); return false; },
  } });
  await new Promise((r) => setTimeout(r, 30));
  expect(await lease.finish({ isSettled: true }, false)).toBe(false);
  expect(reports.filter(([, p]) => p === 'complete')).toEqual([['outcome write lost (renewal outcome uncertain or lease taken over)', 'complete']]);
});
it('stale claim + renewal error: finish writes once without a retry and reports the loss once', async () => {
  const reports = [];
  const writes = [];
  const task = { uuid: 'u', tries: 1, isSending: true, sendingAt: 100 };
  const lease = create({ task, interval: 5, maxRenewals: 1, sendingTimeout: 50, report: (e, phase) => reports.push([e.message, phase]), queue: {
    async update(_t, fields) {
      writes.push(fields.leaseSendingAt);
      if (fields.sendingAt > 100 && fields.isSending === true && !fields.isSettled) throw new Error('ack lost');
      return false;
    },
  } });
  await new Promise((r) => setTimeout(r, 30));
  expect(lease.__renewUncertain).toBe(false);
  const before = writes.length;
  expect(await lease.finish({ isSettled: true }, false)).toBe(false);
  expect(writes.length - before).toBe(1);
  expect(reports.filter(([, p]) => p !== 'renew')).toEqual([['outcome write lost (renewal outcome uncertain or lease taken over)', 'complete']]);
});
it('abort flipped inside the first finish write skips the retry but still reports the loss', async () => {
  let aborted = false;
  const reports = [];
  const settles = [];
  const task = { uuid: 'u', tries: 1, isSending: true, sendingAt: 100 };
  const lease = create({ task, interval: 5, maxRenewals: 1, sendingTimeout: 1e15, shouldAbort: () => aborted, report: (e, phase) => reports.push(phase), queue: {
    async update(_t, fields) {
      if (fields.isSettled) { settles.push(fields.leaseSendingAt); aborted = true; return false; }
      if (fields.sendingAt > 100) throw new Error('ack lost');
      return true;
    },
  } });
  await new Promise((r) => setTimeout(r, 30));
  expect(lease.__renewUncertain).toBe(true);
  expect(await lease.finish({ isSettled: true }, false)).toBe(false);
  expect(settles).toEqual([100]);
  expect(reports.filter((p) => p === 'complete')).toHaveLength(1);
});
it('requires a positive sendingTimeout', () => {
  expect(() => create({ sendingTimeout: void 0 })).toThrow(/sendingTimeout/);
  expect(() => create({ sendingTimeout: 0 })).toThrow(/sendingTimeout/);
});

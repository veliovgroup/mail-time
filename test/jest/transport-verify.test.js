import { afterEach, describe, expect, it, jest } from '@jest/globals';
import nodemailer from 'nodemailer';

import { MailTime } from '../../index.js';
import { createQueue, createSchedulerAdapter } from './helpers.js';

const instances = [];
const transports = [];

const okSend = (mail, done) => done(null, { accepted: [mail.to], response: 'OK' });

// Real Nodemailer wrapper around a custom transport object, as email-jobs does.
const wrap = (verify, send = okSend) => {
  const custom = { name: 'fixture', version: '1', send: (mail, done) => send(mail.data, done) };
  if (verify) custom.verify = verify;
  const t = nodemailer.createTransport(custom);
  transports.push(t);
  return t;
};

const make = (opts = {}) => {
  const mt = new MailTime({
    queue: createQueue(),
    josk: { adapter: createSchedulerAdapter(), minRevolvingDelay: 60000, maxRevolvingDelay: 60000 },
    ...opts
  });
  instances.push(mt);
  return mt;
};

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  for (const i of instances.splice(0)) { i.destroy?.(); i.scheduler?.destroy?.(); }
  for (const t of transports.splice(0)) t.close?.();
});

describe('verify() contract through the Nodemailer wrapper', () => {
  it('accepts a promise-style verify()', async () => {
    const mt = make({ transports: [wrap(async () => true)] });
    await expect(mt.ready()).resolves.toBe(mt);
    expect(mt.__unhealthyTransports.size).toBe(0);
  });

  it('accepts a callback-only verify(callback)', async () => {
    const mt = make({ transports: [wrap((cb) => setImmediate(() => cb(null, true)))] });
    await expect(mt.ready()).resolves.toBe(mt);
    expect(mt.__unhealthyTransports.size).toBe(0);
  });

  it('marks a callback-only verify that reports an error unhealthy', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const onError = jest.fn();
    const good = wrap(async () => true);
    const mt = make({ transports: [wrap((cb) => cb(new Error('cb bad'))), good], onError });
    await mt.ready();
    expect(mt.__unhealthyTransports.has(0)).toBe(true);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'cb bad' }), null, { transportIndex: 0, phase: 'verify' });
  });

  it('marks a synchronous throw unhealthy', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const mt = make({ transports: [wrap(() => { throw new Error('sync boom'); }), wrap(async () => true)] });
    await mt.ready();
    expect([...mt.__unhealthyTransports]).toEqual([0]);
  });

  it('marks a rejected promise unhealthy', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const mt = make({ transports: [wrap(async () => { throw new Error('reject'); }), wrap(async () => true)] });
    await mt.ready();
    expect([...mt.__unhealthyTransports]).toEqual([0]);
  });

  it('bounds a verify() that never settles with verifyTimeout', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const onError = jest.fn();
    const mt = make({ verifyTimeout: 50, onError, transports: [wrap(() => new Promise(() => {})), wrap(async () => true)] });
    await mt.ready();
    expect([...mt.__unhealthyTransports]).toEqual([0]);
    expect(onError.mock.calls[0][0].message).toMatch(/timed out after 50ms/);
    expect(onError.mock.calls[0][2]).toEqual({ transportIndex: 0, phase: 'verify' });
  });

  it('bounds a callback-only verify() that never calls back', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const mt = make({ verifyTimeout: 50, transports: [wrap(() => {}), wrap(async () => true)] });
    await mt.ready();
    expect([...mt.__unhealthyTransports]).toEqual([0]);
  });

  it('ignores completion after the timeout', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    let late;
    const onError = jest.fn();
    const mt = make({ verifyTimeout: 30, onError, transports: [wrap((cb) => { late = cb; }), wrap(async () => true)] });
    await mt.ready();
    late(null, true);
    await new Promise((r) => setTimeout(r, 20));
    expect(mt.__unhealthyTransports.has(0)).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('ignores duplicate callbacks and a callback plus promise settle', async () => {
    const onError = jest.fn();
    const dup = wrap((cb) => { cb(null, true); cb(new Error('second')); return Promise.resolve(true); });
    const mt = make({ transports: [dup], onError });
    await mt.ready();
    expect(mt.__unhealthyTransports.size).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('treats a transport without verify() as healthy', async () => {
    const mt = make({ transports: [wrap(null)] });
    await mt.ready();
    expect(mt.__unhealthyTransports.size).toBe(0);
  });

  it('treats a built-in transport lacking verify() (json) as healthy', async () => {
    const t = nodemailer.createTransport({ jsonTransport: true });
    transports.push(t);
    const mt = make({ transports: [t] });
    await mt.ready();
    expect(mt.__unhealthyTransports.size).toBe(0);
  });

  it('rejects verifyTimeout that is not a positive number by using the default', () => {
    expect(make({ transports: [wrap(null)], verifyTimeout: 0 }).verifyTimeout).toBe(30000);
    expect(make({ transports: [wrap(null)], verifyTimeout: 'x' }).verifyTimeout).toBe(30000);
    expect(make({ transports: [wrap(null)], verifyTimeout: 1234 }).verifyTimeout).toBe(1234);
  });
});

describe('startup failure and recovery', () => {
  it('rejects ready() when every transport fails, and keeps rejecting', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const mt = make({ transports: [wrap(async () => { throw new Error('a'); }), wrap((cb) => cb(new Error('b')))] });
    await expect(mt.ready()).rejects.toThrow(/all 2 transport\(s\) failed verification/);
    await expect(mt.ready()).rejects.toThrow(/all 2 transport\(s\) failed verification/);
  });

  it('never re-probes: a transport that failed startup and later recovers is not used again (documented policy)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    let healthy = false;
    const sentBy = [];
    const flaky = wrap(async () => { if (!healthy) throw new Error('down at startup'); return true; }, (m, d) => { sentBy.push('flaky'); okSend(m, d); });
    const backup = wrap(async () => true, (m, d) => { sentBy.push('backup'); okSend(m, d); });
    const mt = make({ transports: [flaky, backup], strategy: 'backup' });
    await mt.ready();
    healthy = true;

    for (let i = 0; i < 3; i++) {
      const uuid = await mt.sendMail({ to: `u${i}@example.com`, text: 'x' });
      await mt.___send(mt.queue.records.get(uuid));
    }
    expect(sentBy).toEqual(['backup', 'backup', 'backup']);
    expect(mt.___isHealthyTransport(0)).toBe(false);
  });

  it('backup ordering: failover skips an unhealthy middle transport', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const order = [];
    const t = (label, verify) => wrap(verify, (m, d) => { order.push(label); d(new Error('smtp down'), { accepted: [] }); });
    const mt = make({
      transports: [t('a', async () => true), t('b', async () => { throw new Error('b'); }), t('c', async () => true)],
      strategy: 'backup', failsToNext: 1, retries: 2, retryDelay: 0
    });
    await mt.ready();
    const uuid = await mt.sendMail({ to: 'x@example.com', text: 'x' });
    const task = mt.queue.records.get(uuid);
    await mt.___send(task);
    expect(order).not.toContain('b');
  });

  it('separates verify failures (task null, phase verify) from message retry failures (task set)', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const onError = jest.fn();
    const mt = make({
      transports: [wrap(async () => { throw new Error('startup'); }), wrap(async () => true, (m, d) => d(new Error('smtp 451'), { accepted: [] }))],
      onError, retries: 0, maxTries: 1, retryDelay: 0
    });
    await mt.ready();
    const uuid = await mt.sendMail({ to: 'x@example.com', text: 'x' });
    await mt.___send(mt.queue.records.get(uuid));
    const [verifyCall, ...rest] = onError.mock.calls;
    expect(verifyCall[1]).toBeNull();
    expect(verifyCall[2]).toEqual({ transportIndex: 0, phase: 'verify' });
    expect(rest.length).toBeGreaterThan(0);
    for (const call of rest) {
      expect(call[1]).not.toBeNull();
      expect(call[2]?.phase).not.toBe('verify');
    }
  });

  it('verifyTransports:false skips probing and keeps every transport eligible', async () => {
    const verify = jest.fn(async () => { throw new Error('never called'); });
    const mt = make({ verifyTransports: false, transports: [wrap(verify)] });
    await mt.ready();
    expect(verify).not.toHaveBeenCalled();
    expect(mt.___isHealthyTransport(0)).toBe(true);
  });
});

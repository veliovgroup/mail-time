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

const quiet = () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  jest.spyOn(console, 'log').mockImplementation(() => {});
  return jest.spyOn(console, 'warn').mockImplementation(() => {});
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

describe('verify() verdict rows', () => {
  it('always passes a callback, including to callback-only verify(cb)', async () => {
    const verify = jest.fn((cb) => { setTimeout(() => cb(null, true), 5); });
    const mt = make({ transports: [wrap(verify)] });
    await expect(mt.ready()).resolves.toBe(mt);
    expect(verify).toHaveBeenCalledTimes(1);
    expect(typeof verify.mock.calls[0][0]).toBe('function');
    expect(mt.__unhealthyTransports.size).toBe(0);
  });

  it('callback error before T quarantines and fires onError once', async () => {
    quiet();
    const onError = jest.fn();
    const mt = make({ transports: [wrap((cb) => { setTimeout(() => cb(new Error('cb bad')), 5); }), wrap(async () => true)], onError });
    await mt.ready();
    expect([...mt.__unhealthyTransports]).toEqual([0]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'cb bad' }), null, { transportIndex: 0, phase: 'verify' });
  });

  it('synchronous callback error quarantines', async () => {
    quiet();
    const mt = make({ transports: [wrap((cb) => { cb(new Error('sync cb')); }), wrap(async () => true)] });
    await mt.ready();
    expect([...mt.__unhealthyTransports]).toEqual([0]);
  });

  it('synchronous throw quarantines and fires onError', async () => {
    quiet();
    const onError = jest.fn();
    const mt = make({ transports: [wrap(() => { throw new Error('sync boom'); }), wrap(async () => true)], onError });
    await mt.ready();
    expect([...mt.__unhealthyTransports]).toEqual([0]);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][2]).toEqual({ transportIndex: 0, phase: 'verify' });
  });

  it.each([[true], [false]])('synchronous %s return is healthy without waiting for verifyTimeout', async (value) => {
    const warn = quiet();
    const mt = make({ verifyTimeout: 5000, transports: [wrap(() => value)] });
    const t0 = Date.now();
    await mt.ready();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(mt.__unhealthyTransports.size).toBe(0);
    expect(warn).not.toHaveBeenCalled();
  });

  it('other synchronous return values do not decide: a later callback error still quarantines', async () => {
    quiet();
    const onError = jest.fn();
    const mt = make({ verifyTimeout: 500, transports: [wrap((cb) => { const h = setTimeout(() => cb(new Error('late cb')), 20); return h; }), wrap(async () => true)], onError });
    await mt.ready();
    expect([...mt.__unhealthyTransports]).toEqual([0]);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('other synchronous return values with no callback wait for T, stay usable, warn once', async () => {
    const warn = quiet();
    const onError = jest.fn();
    const mt = make({ verifyTimeout: 60, transports: [wrap(() => ({ some: 'value' }))], onError });
    const t0 = Date.now();
    await mt.ready();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    expect(mt.__unhealthyTransports.size).toBe(0);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('callback success before T is healthy', async () => {
    const mt = make({ transports: [wrap((cb) => setImmediate(() => cb(null, true)))] });
    await mt.ready();
    expect(mt.__unhealthyTransports.size).toBe(0);
  });

  it('thenable resolve before T is healthy', async () => {
    const mt = make({ transports: [wrap(async () => true)] });
    await mt.ready();
    expect(mt.__unhealthyTransports.size).toBe(0);
  });

  it('thenable reject before T quarantines; a falsy reason becomes a generic Error', async () => {
    quiet();
    const onError = jest.fn();
    const mt = make({ transports: [wrap(() => Promise.reject(void 0)), wrap(async () => true)], onError });
    await mt.ready();
    expect([...mt.__unhealthyTransports]).toEqual([0]);
    expect(onError.mock.calls[0][0]).toBeInstanceOf(Error);
    expect(onError.mock.calls[0][0].message).toMatch(/verify\(\) rejected/);
  });

  it('a falsy callback error counts as success', async () => {
    const mt = make({ transports: [wrap((cb) => setImmediate(() => cb(null)))] });
    await mt.ready();
    expect(mt.__unhealthyTransports.size).toBe(0);
  });

  it.each([
    ['returns undefined then calls back ok after T', (cb) => { setTimeout(() => cb(null, true), 120); }],
    ['thenable resolves ok after T', () => new Promise((r) => setTimeout(() => r(true), 120))]
  ])('%s: usable at T, no onError, one warn', async (_n, verify) => {
    const warn = quiet();
    const onError = jest.fn();
    const mt = make({ verifyTimeout: 50, transports: [wrap(verify)], onError });
    const t0 = Date.now();
    await mt.ready();
    expect(Date.now() - t0).toBeLessThan(110);
    expect(mt.___isHealthyTransport(0)).toBe(true);
    await sleep(150);
    expect(mt.___isHealthyTransport(0)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['callback error', (cb) => { setTimeout(() => cb(new Error('late bad')), 120); }],
    ['thenable rejection', () => new Promise((_r, rej) => setTimeout(() => rej(new Error('late bad')), 120))]
  ])('%s after T quarantines at the late verdict and fires onError once', async (_n, verify) => {
    quiet();
    const onError = jest.fn();
    const mt = make({ verifyTimeout: 50, transports: [wrap(verify), wrap(async () => true)], onError });
    await mt.ready();
    expect(mt.___isHealthyTransport(0)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    await sleep(150);
    expect(mt.___isHealthyTransport(0)).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'late bad' }), null, { transportIndex: 0, phase: 'verify' });
  });

  it.each([
    ['verify that never calls back', () => {}],
    ['never-settling thenable', () => new Promise(() => {})]
  ])('%s: ready() waits T, transport stays usable, one warn, no onError', async (_n, verify) => {
    const warn = quiet();
    const onError = jest.fn();
    const mt = make({ verifyTimeout: 60, transports: [wrap(verify)], onError });
    const t0 = Date.now();
    await mt.ready();
    expect(Date.now() - t0).toBeGreaterThanOrEqual(50);
    expect(mt.___isHealthyTransport(0)).toBe(true);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(onError).not.toHaveBeenCalled();
  });

  it('first of callback and thenable wins (callback first)', async () => {
    quiet();
    const onError = jest.fn();
    const mt = make({ transports: [wrap((cb) => { cb(null, true); return Promise.reject(new Error('second')); })], onError });
    await mt.ready();
    await sleep(10);
    expect(mt.__unhealthyTransports.size).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('first of callback and thenable wins (thenable first)', async () => {
    quiet();
    const onError = jest.fn();
    const mt = make({ transports: [wrap((cb) => { setTimeout(() => cb(new Error('second')), 5); return Promise.resolve(true); }), wrap(async () => true)], onError });
    await mt.ready();
    await sleep(30);
    expect(mt.__unhealthyTransports.size).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('multiple callbacks: first wins', async () => {
    quiet();
    const onError = jest.fn();
    const mt = make({ transports: [wrap((cb) => { cb(null, true); cb(new Error('second')); })], onError });
    await mt.ready();
    expect(mt.__unhealthyTransports.size).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });

  it('treats a transport without verify() as healthy', async () => {
    const mt = make({ transports: [wrap(null)] });
    await mt.ready();
    expect(mt.__unhealthyTransports.size).toBe(0);
  });

  it('treats a built-in transport lacking verify() (json) as healthy without delay', async () => {
    const t = nodemailer.createTransport({ jsonTransport: true });
    transports.push(t);
    const mt = make({ transports: [t], verifyTimeout: 5000 });
    const t0 = Date.now();
    await mt.ready();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(mt.__unhealthyTransports.size).toBe(0);
  });

  it('a late verdict after destroy() is ignored', async () => {
    quiet();
    let late;
    const onError = jest.fn();
    const mt = make({ verifyTimeout: 30, onError, transports: [wrap((cb) => { late = cb; }), wrap(async () => true)] });
    await mt.ready();
    mt.destroy();
    late(new Error('after destroy'));
    expect(mt.__unhealthyTransports.size).toBe(0);
    expect(onError).not.toHaveBeenCalled();
  });
});

describe('verifyTimeout validation', () => {
  it.each([
    [1234, 1234], [Infinity, 2147483647], [3e9, 2147483647], [2147483647, 2147483647],
    [0, 30000], [-1, 30000], [NaN, 30000], ['100', 30000], [null, 30000], [void 0, 30000], [-Infinity, 30000]
  ])('verifyTimeout %p -> %p', (input, expected) => {
    expect(make({ transports: [wrap(null)], verifyTimeout: input }).verifyTimeout).toBe(expected);
  });

  it('unrefs the timer and clears it on settle', async () => {
    const spy = jest.spyOn(global, 'setTimeout');
    const mt = make({ verifyTimeout: 12345, transports: [wrap(async () => true)] });
    await mt.ready();
    const call = spy.mock.calls.findIndex((c) => c[1] === 12345);
    expect(call).toBeGreaterThanOrEqual(0);
    expect(spy.mock.results[call].value.hasRef()).toBe(false);
    expect(mt.__probeCancels.size).toBe(0);
  });

  it('destroy() during a pending probe releases ready() and leaves no probe timer', async () => {
    const mt = make({ verifyTimeout: 60000, transports: [wrap(() => {})] });
    const ready = mt.ready();
    await sleep(20);
    expect(mt.__probeCancels.size).toBe(1);
    mt.destroy();
    expect(mt.__probeCancels.size).toBe(0);
    await expect(Promise.race([ready.then(() => 'done', () => 'done'), sleep(500).then(() => 'hung')])).resolves.toBe('done');
  });
});

describe('startup failure', () => {
  it('rejects ready() when every transport fails, and keeps rejecting', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const mt = make({ transports: [wrap(async () => { throw new Error('a'); }), wrap((cb) => cb(new Error('b')))] });
    await expect(mt.ready()).rejects.toThrow(/all 2 transport\(s\) failed verification/);
    await expect(mt.ready()).rejects.toThrow(/all 2 transport\(s\) failed verification/);
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

describe('lazy re-probe', () => {
  // No fake timers (Bun lacks them): a controllable Date.now drives backoff, real short timers drive verifyTimeout.
  const DOWN = { on: true };
  let clock = 0;
  // Transport 0 fails at startup (DOWN.on), then obeys `behavior`.
  const setup = async (opts = {}, behavior) => {
    quiet();
    clock = 1e12;
    jest.spyOn(Date, 'now').mockImplementation(() => clock);
    DOWN.on = true;
    const calls = [];
    const sentBy = [];
    const flaky = wrap((cb) => {
      calls.push(Date.now());
      if (DOWN.on) { cb(new Error('down')); return; }
      if (behavior) { behavior(cb, calls.length); return; }
      cb(null, true);
    }, (m, d) => { sentBy.push('flaky'); okSend(m, d); });
    const backup = wrap(async () => true, (m, d) => { sentBy.push('backup'); okSend(m, d); });
    const onError = jest.fn();
    const mt = make({ transports: [flaky, backup], onError, ...opts });
    await mt.ready();
    return { mt, calls, sentBy, onError };
  };
  const tick = async (ms) => { clock += ms; await sleep(0); };

  it('does not probe before the first 60 s', async () => {
    const { mt, calls } = await setup();
    expect(calls.length).toBe(1);
    await tick(59000);
    mt.___isHealthyTransport(0);
    await tick(0);
    expect(calls.length).toBe(1);
  });

  it('success removes the transport from quarantine and logs one line', async () => {
    const { mt, calls, onError } = await setup();
    DOWN.on = false;
    await tick(60000);
    expect(mt.___isHealthyTransport(0)).toBe(false);
    await tick(0);
    expect(calls.length).toBe(2);
    expect(mt.___isHealthyTransport(0)).toBe(true);
    expect(mt.__reprobe.has(0)).toBe(false);
    expect(console.log).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('failure reschedules, counts, writes no onError and no console error', async () => {
    const { mt, calls, onError } = await setup();
    const errorsBefore = console.error.mock.calls.length;
    await tick(60000);
    mt.___isHealthyTransport(0);
    await tick(0);
    expect(calls.length).toBe(2);
    expect(mt.___isHealthyTransport(0)).toBe(false);
    expect(mt.__reprobe.get(0).count).toBe(1);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(console.error.mock.calls.length).toBe(errorsBefore);
  });

  it('backs off 60, 120, 240, 480, then caps at 900 s', async () => {
    const { mt, calls } = await setup();
    const delays = [];
    for (let i = 0; i < 6; i++) {
      const st = mt.__reprobe.get(0);
      const scheduledFor = st.nextProbeAt;
      delays.push(Math.round((scheduledFor - (i === 0 ? calls[0] : calls[i])) / 1000));
      clock = scheduledFor - 1;
      mt.___isHealthyTransport(0);
      await tick(0);
      expect(calls.length).toBe(i + 1);
      clock = scheduledFor;
      mt.___isHealthyTransport(0);
      await tick(0);
      expect(calls.length).toBe(i + 2);
    }
    expect(delays).toEqual([60, 120, 240, 480, 900, 900]);
  });

  it('single-flight: five concurrent health checks start one verify', async () => {
    const { mt, calls } = await setup({}, (cb) => { setTimeout(() => cb(null, true), 40); });
    DOWN.on = false;
    await tick(60000);
    for (let i = 0; i < 5; i++) mt.___isHealthyTransport(0);
    await tick(0);
    expect(calls.length).toBe(2);
    await sleep(80);
    expect(mt.___isHealthyTransport(0)).toBe(true);
  });

  it('single-flight through five real sends', async () => {
    const { mt, calls, sentBy } = await setup({}, (cb) => { setTimeout(() => cb(null, true), 40); });
    DOWN.on = false;
    await tick(60000);
    const ids = [];
    for (let i = 0; i < 5; i++) ids.push(await mt.sendMail({ to: `u${i}@example.com`, text: 'x' }));
    for (const id of ids) mt.queue.records.get(id).transport = 0;
    await Promise.all(ids.map((id) => mt.___send(mt.queue.records.get(id))));
    expect(calls.length).toBe(2);
    expect(sentBy).toEqual(['backup', 'backup', 'backup', 'backup', 'backup']);
  });

  it('a hung re-probe times out, clears the in-flight flag and reschedules', async () => {
    const { mt, calls } = await setup({ verifyTimeout: 30 }, () => {});
    DOWN.on = false;
    await tick(60000);
    mt.___isHealthyTransport(0);
    await tick(0);
    expect(calls.length).toBe(2);
    expect(mt.__reprobe.get(0).inFlight).toBe(true);
    await sleep(60);
    const st = mt.__reprobe.get(0);
    expect(st.inFlight).toBe(false);
    expect(st.count).toBe(1);
    expect(mt.___isHealthyTransport(0)).toBe(false);
    await tick(120000);
    mt.___isHealthyTransport(0);
    await tick(0);
    expect(calls.length).toBe(3);
  });

  it('generation guard: an older late failure never overrides a newer success', async () => {
    const lates = [];
    const { mt, calls, onError } = await setup({ verifyTimeout: 30 }, (cb, n) => {
      if (n === 2) { lates.push(cb); return; }
      cb(null, true);
    });
    DOWN.on = false;
    await tick(60000);
    mt.___isHealthyTransport(0);
    await sleep(60);
    expect(calls.length).toBe(2);
    await tick(120000);
    mt.___isHealthyTransport(0);
    await tick(0);
    expect(calls.length).toBe(3);
    expect(mt.___isHealthyTransport(0)).toBe(true);
    lates[0](new Error('stale failure'));
    expect(mt.___isHealthyTransport(0)).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('late success of a timed-out re-probe clears quarantine', async () => {
    const lates = [];
    const { mt } = await setup({ verifyTimeout: 30 }, (cb) => { lates.push(cb); });
    DOWN.on = false;
    await tick(60000);
    mt.___isHealthyTransport(0);
    await sleep(60);
    lates[0](null, true);
    expect(mt.___isHealthyTransport(0)).toBe(true);
  });

  it('backup strategy: recovery routes new sends back to the primary', async () => {
    const { mt, sentBy } = await setup({ strategy: 'backup' });
    expect(mt.transport).toBe(1);
    DOWN.on = false;
    await tick(60000);
    mt.___isHealthyTransport(0);
    await tick(0);
    expect(mt.transport).toBe(0);
    const id = await mt.sendMail({ to: 'x@example.com', text: 'x' });
    await mt.___send(mt.queue.records.get(id));
    expect(sentBy).toEqual(['flaky']);
  });

  it('balancer strategy: recovered transport rejoins the rotation', async () => {
    const { mt, sentBy } = await setup({ strategy: 'balancer' });
    for (let i = 0; i < 2; i++) {
      const id = await mt.sendMail({ to: `a${i}@example.com`, text: 'x' });
      await mt.___send(mt.queue.records.get(id));
    }
    expect(sentBy).toEqual(['backup', 'backup']);
    DOWN.on = false;
    await tick(60000);
    const id0 = await mt.sendMail({ to: 'b0@example.com', text: 'x' });
    await tick(0);
    for (let i = 1; i < 4; i++) {
      const id = await mt.sendMail({ to: `b${i}@example.com`, text: 'x' });
      await mt.___send(mt.queue.records.get(id));
    }
    await mt.___send(mt.queue.records.get(id0));
    expect(sentBy.slice(2)).toContain('flaky');
  });

  it('no probes for verifyTransports:false, type client, or after destroy()', async () => {
    for (const mutate of [
      (o) => ({ ...o, verifyTransports: false }),
      (o) => ({ ...o, type: 'client' }),
      (o) => o
    ]) {
      quiet();
      const verify = jest.fn((cb) => cb(null, true));
      const mt = make(mutate({ transports: [wrap(verify), wrap(async () => true)] }));
      await mt.ready().catch(() => {});
      const isDestroyCase = mutate({}).verifyTransports === void 0 && mutate({}).type === void 0;
      mt.__unhealthyTransports.add(0);
      mt.__reprobe.set(0, { count: 0, nextProbeAt: 0, inFlight: false });
      verify.mockClear();
      if (isDestroyCase) mt.destroy();
      mt.___isHealthyTransport(0);
      await sleep(10);
      expect(verify).not.toHaveBeenCalled();
    }
  });
});


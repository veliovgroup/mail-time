import { afterEach, describe, expect, it, jest } from '@jest/globals';
import net from 'net';
import nodemailer from 'nodemailer';

import { MailTime } from '../../index.js';
import { createQueue, createSchedulerAdapter } from './helpers.js';

// Loopback only: a closed local port and a local server that accepts and never speaks.
const instances = [];
const transports = [];
const servers = [];

const make = (opts) => {
  const mt = new MailTime({
    queue: createQueue(),
    josk: { adapter: createSchedulerAdapter(), minRevolvingDelay: 60000, maxRevolvingDelay: 60000 },
    ...opts
  });
  instances.push(mt);
  return mt;
};
const smtp = (options) => {
  const t = nodemailer.createTransport({ host: '127.0.0.1', secure: false, ...options });
  transports.push(t);
  return t;
};
const closedPort = () => new Promise((resolve) => {
  const s = net.createServer();
  s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); });
});
const blackhole = () => new Promise((resolve) => {
  const sockets = new Set();
  const s = net.createServer((sock) => { sockets.add(sock); sock.on('error', () => {}); });
  s.listen(0, '127.0.0.1', () => { servers.push({ s, sockets }); resolve(s.address().port); });
});

afterEach(async () => {
  jest.restoreAllMocks();
  for (const i of instances.splice(0)) { i.destroy?.(); i.scheduler?.destroy?.(); }
  for (const t of transports.splice(0)) t.close?.();
  for (const { s, sockets } of servers.splice(0)) { for (const k of sockets) k.destroy(); s.close(); }
});

describe('verify() with real Nodemailer transports', () => {
  it('jsonTransport is healthy without waiting for verifyTimeout', async () => {
    const t = nodemailer.createTransport({ jsonTransport: true });
    transports.push(t);
    const mt = make({ transports: [t], verifyTimeout: 10000 });
    const t0 = Date.now();
    await mt.ready();
    expect(Date.now() - t0).toBeLessThan(1000);
    expect(mt.___isHealthyTransport(0)).toBe(true);
  });

  it('SMTP to a closed local port is quarantined before verifyTimeout', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    const onError = jest.fn();
    const port = await closedPort();
    const mt = make({ transports: [smtp({ port }), nodemailer.createTransport({ jsonTransport: true })], verifyTimeout: 10000, onError });
    const t0 = Date.now();
    await mt.ready();
    expect(Date.now() - t0).toBeLessThan(5000);
    expect(mt.___isHealthyTransport(0)).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][2]).toEqual({ transportIndex: 0, phase: 'verify' });
  });

  it('a silent SMTP server: ready() resolves at T, the transport is quarantined when Nodemailer gives up', async () => {
    jest.spyOn(console, 'error').mockImplementation(() => {});
    jest.spyOn(console, 'warn').mockImplementation(() => {});
    const onError = jest.fn();
    const port = await blackhole();
    const mt = make({
      transports: [smtp({ port, connectionTimeout: 2000, greetingTimeout: 2000, socketTimeout: 2000 })],
      verifyTimeout: 500, onError
    });
    const t0 = Date.now();
    await mt.ready();
    const readyAt = Date.now() - t0;
    expect(readyAt).toBeGreaterThanOrEqual(450);
    expect(readyAt).toBeLessThan(2000);
    expect(mt.___isHealthyTransport(0)).toBe(true);
    expect(onError).not.toHaveBeenCalled();
    while (mt.___isHealthyTransport(0) && Date.now() - t0 < 6000) await new Promise((r) => setTimeout(r, 50));
    const quarantinedAt = Date.now() - t0;
    expect(mt.___isHealthyTransport(0)).toBe(false);
    expect(quarantinedAt).toBeGreaterThanOrEqual(1400);
    expect(quarantinedAt).toBeLessThan(5500);
    expect(onError).toHaveBeenCalledTimes(1);
  }, 15000);
});

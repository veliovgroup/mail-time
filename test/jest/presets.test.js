import { afterEach, describe, expect, it, jest } from '@jest/globals';

import { MailTime, mailTimePreset, presetNames, presets } from '../../index.js';
import { createQueue, createSchedulerAdapter, createTransport } from './helpers.js';

const instances = [];

afterEach(() => {
  for (const instance of instances.splice(0)) {
    instance.destroy?.();
    instance.scheduler?.destroy?.();
  }
});

describe('mailTimePreset', () => {
  it('exposes every documented preset', () => {
    expect([...presetNames].sort()).toEqual([
      'alerts', 'marketing', 'newsletter', 'notifications', 'otp', 'transactional'
    ]);
    for (const name of presetNames) {
      expect(presets[name]).toEqual(expect.any(Object));
    }
  });

  it('rejects unknown presets and non-object overrides', () => {
    expect(() => mailTimePreset('does-not-exist')).toThrow('unknown preset "does-not-exist"');
    expect(() => mailTimePreset(42)).toThrow('unknown preset');
    expect(() => mailTimePreset('otp', 'nope')).toThrow('must be a plain object');
    expect(() => mailTimePreset('otp', [])).toThrow('must be a plain object');
  });

  it('returns a mutable deep-clone of the preset', () => {
    const result = mailTimePreset('transactional');
    expect(result).toEqual(presets.transactional);
    expect(result).not.toBe(presets.transactional);
    expect(result.josk).not.toBe(presets.transactional.josk);

    result.retries = 999;
    result.josk.zombieTime = 1;
    expect(presets.transactional.retries).toBe(30);
    expect(presets.transactional.josk.zombieTime).toBe(120_000);
  });

  it('refuses to mutate the frozen preset map', () => {
    expect(Object.isFrozen(presets)).toBe(true);
    expect(Object.isFrozen(presets.otp)).toBe(true);
    expect(Object.isFrozen(presets.otp.josk)).toBe(true);
  });

  it('deep-merges overrides on top of the preset', () => {
    const result = mailTimePreset('otp', {
      retries: 1,
      prefix: 'otp-pin',
      josk: { lockOwnerId: 'worker-1', minRevolvingDelay: 100 }
    });

    expect(result.retries).toBe(1);
    expect(result.retryDelay).toBe(2000);
    expect(result.prefix).toBe('otp-pin');
    expect(result.josk.lockOwnerId).toBe('worker-1');
    expect(result.josk.minRevolvingDelay).toBe(100);
    expect(result.josk.maxRevolvingDelay).toBe(1024);
    expect(result.josk.zombieTime).toBe(60_000);
  });

  it('keeps newsletter on concatEmails with a 5-minute fold window', () => {
    const result = mailTimePreset('newsletter');
    expect(result.concatEmails).toBe(true);
    expect(result.concatDelay).toBe(5 * 60_000);
    expect(result.concatSubject).toEqual(expect.any(String));
  });

  it('pins mode to "batch" on every preset', () => {
    for (const name of presetNames) {
      expect(presets[name].mode).toBe('batch');
    }
  });

  it('ships a default onError hook on every preset that tags logs with the instance prefix', () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      for (const name of presetNames) {
        expect(typeof presets[name].onError).toBe('function');
      }

      const cfg = mailTimePreset('transactional');
      cfg.onError.call({ prefix: 'receipts' }, new Error('boom'), { id: 'task-1' }, { meta: true });
      cfg.onError.call({}, new Error('boom'), { id: 'task-2' });

      expect(errSpy).toHaveBeenCalledTimes(2);
      expect(errSpy.mock.calls[0].some((arg) => typeof arg === 'string' && arg.includes('[receipts] [onError]'))).toBe(true);
      expect(errSpy.mock.calls[1].some((arg) => typeof arg === 'string' && arg.includes('[default] [onError]'))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('lets the caller replace the preset onError via overrides', () => {
    const custom = jest.fn();
    const cfg = mailTimePreset('alerts', { onError: custom });
    expect(cfg.onError).toBe(custom);
  });

  it('binds the preset default onError to the MailTime instance so `this.prefix` is reliable', async () => {
    const errSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

    try {
      const mailTime = new MailTime(mailTimePreset('alerts', {
        prefix: 'ops-alerts',
        queue: createQueue(),
        transports: [createTransport()],
        josk: {
          adapter: createSchedulerAdapter(),
          minRevolvingDelay: 60_000,
          maxRevolvingDelay: 60_000,
        },
      }));
      instances.push(mailTime);
      await mailTime.ready();

      const detached = mailTime.onError;
      detached(new Error('boom'), { id: 'task-x' }, { meta: true });

      expect(errSpy).toHaveBeenCalledTimes(1);
      expect(errSpy.mock.calls[0].some((arg) => typeof arg === 'string' && arg.includes('[ops-alerts] [onError]'))).toBe(true);
    } finally {
      errSpy.mockRestore();
    }
  });

  it('lets MailTime accept a preset-built config', async () => {
    const mailTime = new MailTime(mailTimePreset('marketing', {
      queue: createQueue(),
      transports: [createTransport()],
      josk: {
        adapter: createSchedulerAdapter(),
        minRevolvingDelay: 60_000,
        maxRevolvingDelay: 60_000,
      },
    }));
    instances.push(mailTime);

    expect(mailTime.maxTries).toBe(11);
    expect(mailTime.retryDelay).toBe(30_000);
    expect(mailTime.concatEmails).toBe(false);
    expect(mailTime.concurrency).toBe(5);
    expect(mailTime.mode).toBe('batch');
    expect(mailTime.josk.zombieTime).toBe(180_000);

    await expect(mailTime.ready()).resolves.toBe(mailTime);
  });
});

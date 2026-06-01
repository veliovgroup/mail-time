import { deepMerge, isPlainObject, logError } from './helpers.js';

/**
 * Default `onError` hook used by every built-in preset. Logs via the
 * shared `logError` helper and tags the line with the MailTime instance
 * `prefix` (or `'default'` when unset) so multi-queue deployments can
 * tell their streams apart. Defined as a regular function so `this`
 * resolves to the MailTime instance at call time — `this.onError(...)`
 * in `index.js` binds the receiver. Users override by passing their own
 * `onError` through `mailTimePreset(name, { onError })` or the
 * constructor.
 */
function defaultPresetOnError(error, email, info) {
  logError(`[${this?.prefix || 'default'}] [onError]`, { error, email, info });
}

/**
 * @typedef {object} MailTimePresetConfig
 * @property {boolean} [concatEmails]
 * @property {number} [concatDelay]
 * @property {string} [concatSubject]
 * @property {number} [retries]
 * @property {number} [retryDelay]
 * @property {number} [revolvingInterval]
 * @property {number} [sendingTimeout]
 * @property {'one' | 'batch'} [mode]
 * @property {number} [concurrency]
 * @property {(error: unknown, email: any, details?: object) => void} [onError]
 * @property {object} [josk]
 */

/**
 * Built-in MailTime presets keyed by use-case. Each value is a partial
 * MailTime constructor options object — pass it through `mailTimePreset`
 * (or spread directly) and supply your own `queue` / `transports` /
 * `josk.adapter` / `prefix`. Presets only set the knobs that differ from
 * MailTime defaults so the rest of the constructor stays in your hands.
 *
 * | Preset          | Shape | Best for |
 * |-----------------|-------|----------|
 * | `transactional` | High retries, single SMTP per instance, no concat | Receipts, password resets, account changes, welcome emails. |
 * | `otp`           | Few retries, fast retryDelay, snappy polling, parallel SMTPs | Sign-in codes, 2FA, verification codes — stale OTPs aren't worth resending forever. |
 * | `newsletter`    | `concatEmails: true` with 5-min fold window | Scheduled digests / weekly updates / "what's new" emails. |
 * | `marketing`     | High concurrency, moderate retries, no concat | Promotional / campaign blasts where each letter is unique. |
 * | `notifications` | `concatEmails: true` with 60-s fold window | App / social activity (likes, mentions) where bursts collapse into one letter. |
 * | `alerts`        | Many retries, fast retryDelay, modest concurrency | Ops / admin alerts: monitoring, error reports, escalations. |
 *
 * @type {Readonly<Record<'transactional' | 'otp' | 'newsletter' | 'marketing' | 'notifications' | 'alerts', Readonly<MailTimePresetConfig>>>}
 */
// Every preset pins `mode: 'batch'` explicitly. `'one'` would trade per-tick
// throughput for cluster-wide fairness across pods on the same `prefix`, but:
// - urgent classes (`otp`, `alerts`, `transactional`) want all due rows claimed
//   immediately, not spread one-per-tick;
// - bulk classes (`newsletter`, `marketing`, `notifications`) are bursty and
//   need fast drains during the send window;
// - multiple `server` pods on the same `prefix` is already an anti-pattern in
//   this library (one JoSk lease per prefix), so the fairness payoff is moot.
// If you do want `'one'`, pass it via `mailTimePreset(name, { mode: 'one' })`.
const PRESETS = Object.freeze({
  transactional: Object.freeze({
    concatEmails: false,
    retries: 30,
    retryDelay: 10_000,
    mode: 'batch',
    concurrency: 1,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      zombieTime: 120_000,
    }),
  }),
  otp: Object.freeze({
    concatEmails: false,
    retries: 5,
    retryDelay: 2000,
    revolvingInterval: 1024,
    sendingTimeout: 60_000,
    mode: 'batch',
    concurrency: 4,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      minRevolvingDelay: 256,
      maxRevolvingDelay: 1024,
      zombieTime: 60_000,
    }),
  }),
  newsletter: Object.freeze({
    concatEmails: true,
    concatDelay: 5 * 60_000,
    concatSubject: 'Your updates',
    retries: 5,
    retryDelay: 60_000,
    sendingTimeout: 600_000,
    mode: 'batch',
    concurrency: 2,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      zombieTime: 300_000,
    }),
  }),
  marketing: Object.freeze({
    concatEmails: false,
    retries: 10,
    retryDelay: 30_000,
    mode: 'batch',
    concurrency: 5,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      zombieTime: 180_000,
    }),
  }),
  notifications: Object.freeze({
    concatEmails: true,
    concatDelay: 60_000,
    concatSubject: 'New activity',
    retries: 8,
    retryDelay: 30_000,
    mode: 'batch',
    concurrency: 3,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      zombieTime: 180_000,
    }),
  }),
  alerts: Object.freeze({
    concatEmails: false,
    retries: 20,
    retryDelay: 5000,
    revolvingInterval: 1024,
    sendingTimeout: 60_000,
    mode: 'batch',
    concurrency: 2,
    onError: defaultPresetOnError,
    josk: Object.freeze({
      minRevolvingDelay: 256,
      maxRevolvingDelay: 1024,
      zombieTime: 60_000,
    }),
  }),
});

/**
 * Read-only map of preset name → partial MailTime config. Use
 * `mailTimePreset(name, overrides)` to materialize a merged copy; use
 * this object directly only when you want to introspect or compose
 * presets manually.
 */
const presets = PRESETS;

/**
 * @typedef {keyof typeof PRESETS} MailTimePresetName
 */

/**
 * Names of every built-in preset.
 * @type {ReadonlyArray<MailTimePresetName>}
 */
const presetNames = Object.freeze(/** @type {MailTimePresetName[]} */ (Object.keys(PRESETS)));

/**
 * Materialize a MailTime constructor config from a built-in preset.
 * The named preset is deep-cloned (so the result is freely mutable) and
 * `overrides` is deep-merged on top — overrides win for scalar keys, and
 * nested objects like `josk` are merged so the preset's defaults compose
 * with the caller's `adapter`, `lockOwnerId`, `onError`, etc.
 *
 * ```js
 * import { MailTime, RedisQueue, mailTimePreset } from 'mail-time';
 * const mailTime = new MailTime(mailTimePreset('otp', {
 *   prefix: 'otp',
 *   queue: new RedisQueue({ client }),
 *   transports: [otpTransport],
 *   josk: { adapter: { type: 'redis', client } },
 * }));
 * ```
 *
 * @param {MailTimePresetName} name - one of `presetNames`
 * @param {object} [overrides] - additional MailTime constructor options
 * @returns {MailTimePresetConfig} fresh, mutable MailTime constructor options (preset deep-cloned + overrides merged)
 * @throws {Error} when `name` is unknown
 * @throws {TypeError} when `overrides` is provided but not a plain object
 */
const mailTimePreset = (name, overrides) => {
  if (typeof name !== 'string' || !Object.hasOwn(PRESETS, name)) {
    throw new Error(`[mail-time] [mailTimePreset] unknown preset "${name}". Available: ${presetNames.join(', ')}`);
  }
  if (overrides !== void 0 && !isPlainObject(overrides)) {
    throw new TypeError('[mail-time] [mailTimePreset] {overrides} must be a plain object when provided');
  }
  const cloned = deepMerge({}, PRESETS[name]);
  return overrides ? deepMerge(cloned, overrides) : cloned;
};

export { mailTimePreset, presets, presetNames };

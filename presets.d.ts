export type MailTimePresetConfig = {
    concatEmails?: boolean | undefined;
    concatDelay?: number | undefined;
    concatSubject?: string | undefined;
    retries?: number | undefined;
    retryDelay?: number | undefined;
    revolvingInterval?: number | undefined;
    sendingTimeout?: number | undefined;
    mode?: "one" | "batch" | undefined;
    concurrency?: number | undefined;
    onError?: ((error: unknown, email: any, details?: object) => void) | undefined;
    josk?: object | undefined;
};
export type MailTimePresetName = keyof typeof PRESETS;
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
export function mailTimePreset(name: MailTimePresetName, overrides?: object): MailTimePresetConfig;
/**
 * Read-only map of preset name → partial MailTime config. Use
 * `mailTimePreset(name, overrides)` to materialize a merged copy; use
 * this object directly only when you want to introspect or compose
 * presets manually.
 */
export const presets: Readonly<Record<"transactional" | "otp" | "newsletter" | "marketing" | "notifications" | "alerts", Readonly<MailTimePresetConfig>>>;
/**
 * @typedef {keyof typeof PRESETS} MailTimePresetName
 */
/**
 * Names of every built-in preset.
 * @type {ReadonlyArray<MailTimePresetName>}
 */
export const presetNames: ReadonlyArray<MailTimePresetName>;
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
declare const PRESETS: Readonly<Record<"transactional" | "otp" | "newsletter" | "marketing" | "notifications" | "alerts", Readonly<MailTimePresetConfig>>>;
export {};

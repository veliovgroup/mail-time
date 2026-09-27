export type MailTimePresetName = import("./presets.js").MailTimePresetName;
export type MailTimePresetConfig = import("./presets.js").MailTimePresetConfig;
export type MailTimePingResult = {
    status: string;
    code: number;
    statusCode: number;
    paused?: boolean;
    error?: unknown;
};
export type MailTimeStorageClient = {
    [key: string]: any;
    query?: (queryText: string, values?: unknown[]) => Promise<{
        rows?: unknown[];
        rowCount?: number | null;
    }>;
};
export type MailTimeMongoDb = {
    [key: string]: any;
};
export type MailTimeTransport = {
    [key: string]: any;
};
export type MailTimeJoSkAdapterOptions = {
    [key: string]: any;
    type?: "mongo" | "redis" | "postgres";
    client?: MailTimeStorageClient;
    db?: MailTimeMongoDb;
    prefix?: string;
    resetOnInit?: boolean;
    useHashTags?: boolean;
};
export type MailTimeJoSkOptions = {
    [key: string]: any;
    adapter: MailTimeJoSkAdapterOptions | object;
    debug?: boolean;
    autoClear?: boolean;
    zombieTime?: number;
    lockLeaseTime?: number;
    minRevolvingDelay?: number;
    maxRevolvingDelay?: number;
    execute?: "batch" | "one";
    concurrency?: number;
    lockOwnerId?: string;
    resetOnInit?: boolean;
    onError?: (title: string, details: object) => void;
    onExecuted?: (uid: string, details: object) => void;
};
export type MailTimeScheduler = {
    [key: string]: any;
    ping: () => Promise<MailTimePingResult>;
    setInterval: (func: (...args: any[]) => unknown, delay: number, uid: string) => Promise<string>;
    destroy: () => boolean;
    shutdown: (opts?: {
        timeout?: number;
    }) => Promise<boolean>;
    pause: (timerId?: string) => boolean;
    resume: (timerId?: string) => boolean;
};
export type MailTimeMailbox = string | {
    address: string;
    name?: string;
};
export type MailTimePolicyRecipient = {
    address: string;
    sources: Array<"envelope" | "to" | "cc" | "bcc">;
};
export type MailTimePolicyDecision = {
    address: string;
    status: "suppressed" | "rejected" | "retry";
    reason: string;
};
export type MailTimePolicyResult = {
    decisions?: MailTimePolicyDecision[];
};
export type MailTimePolicyTransport = {
    index: number;
    name?: string;
};
export type MailTimePolicyEnvelope = {
    from?: string;
    to: string[];
};
export type MailTimePolicyContext = {
    task: MailTimeTask;
    attempt: number;
    transport: MailTimePolicyTransport;
    envelope: MailTimePolicyEnvelope;
    recipients: MailTimePolicyRecipient[];
};
export type MailTimeBeforeSendPolicyContext = MailTimePolicyContext;
export type MailTimeStructuredRejection = {
    address: string | null;
    command?: string;
    responseCode?: number;
    response?: string;
    message?: string;
    transportIndex: number;
    transportName?: string;
};
export type MailTimeRejectionPolicyContext = MailTimePolicyContext & {
    error?: unknown;
    info?: unknown;
    rejections: MailTimeStructuredRejection[];
};
export type MailTimeRecipientResult = {
    address: string;
    status: "sent" | "error" | "suppressed" | "rejected";
    sources?: Array<"envelope" | "to" | "cc" | "bcc">;
    reasons: Array<{
        provider: string;
        reason: string;
    }>;
    attempt: number;
    transportIndex?: number;
    transportName?: string;
    command?: string;
    responseCode?: number;
    response?: string;
    message?: string;
};
export type MailTimeRecipientAttemptContext = MailTimeRejectionPolicyContext & {
    decisions: MailTimeRecipientResult[];
};
export type MailTimeRecipientSummary = {
    uuid: string;
    tries: number;
    isSettled: boolean;
    recipients: {
        sent: MailTimeRecipientResult[];
        error: MailTimeRecipientResult[];
        suppressed: MailTimeRecipientResult[];
        rejected: MailTimeRecipientResult[];
    };
};
export type MailTimeRecipientPolicy = {
    name: string;
    failureMode?: "retry" | "continue";
    beforeSend?: (context: MailTimeBeforeSendPolicyContext) => void | MailTimePolicyResult | Promise<void | MailTimePolicyResult>;
    classifyRejections?: (context: MailTimeRejectionPolicyContext) => void | MailTimePolicyResult | Promise<void | MailTimePolicyResult>;
    observeAttempt?: (context: MailTimeRecipientAttemptContext) => void | Promise<void>;
};
export type MailTimeTask = {
    uuid: string;
    to?: MailTimeMailbox | MailTimeMailbox[];
    tries: number;
    sendAt: number;
    isSent: boolean;
    isSettled?: boolean;
    recipientResults?: MailTimeRecipientResult[];
    isCancelled: boolean;
    isFailed: boolean;
    isSending?: boolean;
    sendingAt?: number;
    template?: string | false;
    transport: number;
    concatSubject?: string | false;
    mailOptions: MailTimeMailOptions[];
};
export type MailTimeIterateOptions = {
    limit?: number;
    sendingTimeout?: number;
};
export type CustomQueue = {
    ping: () => Promise<MailTimePingResult>;
    iterate: (opts?: MailTimeIterateOptions) => Promise<void> | void;
    getPendingTo: (to: string, sendAt: number) => Promise<MailTimeTask | object | null>;
    push: (email: MailTimeTask) => Promise<void> | void;
    cancel: (uuid: string) => Promise<boolean>;
    remove: (email: MailTimeTask | object, opts?: {
        leaseTries: number;
        leaseSendingAt: number;
    }) => Promise<boolean>;
    update: (email: MailTimeTask | object, updateObj: object) => Promise<boolean>;
    ready?: () => Promise<void>;
    supportsRecipientPolicies?: boolean;
};
export type MailTimeRejectedRecipient = {
    address: string;
    error: string;
};
export type MailTimeMailOptions = {
    [key: string]: any;
    to: MailTimeMailbox | MailTimeMailbox[];
    cc?: MailTimeMailbox | MailTimeMailbox[];
    bcc?: MailTimeMailbox | MailTimeMailbox[];
    sendAt?: Date | number;
    template?: string;
    concatSubject?: string;
    text?: string | false;
    html?: string | false;
    subject?: string;
    accepted?: string[];
    rejected?: MailTimeRejectedRecipient[];
};
export type MailTimeConcatEmailsOptions = {
    subject?: string;
};
export type MailTimeFromDetails = {
    index: number;
    from: string | undefined;
};
export type MailTimeOptions = {
    queue: RedisQueue | MongoQueue | PostgresQueue | CustomQueue;
    type?: "server" | "client";
    from?: string | ((transport: MailTimeTransport, details: MailTimeFromDetails) => string);
    transports?: MailTimeTransport[];
    strategy?: "backup" | "balancer";
    failsToNext?: number;
    shouldFailOver?: (error: unknown, info: object | undefined, email: MailTimeTask) => boolean;
    retries?: number;
    maxTries?: number;
    retryDelay?: number;
    interval?: number;
    keepHistory?: boolean;
    concatEmails?: boolean | MailTimeConcatEmailsOptions;
    concatSubject?: string;
    concatDelimiter?: string;
    concatDelay?: number;
    concatThrottling?: number;
    revolvingInterval?: number;
    mode?: "one" | "batch";
    concurrency?: number;
    sendingTimeout?: number;
    renewClaim?: boolean | number;
    maxRenewals?: number;
    strictPayload?: boolean;
    allowedMailFields?: string[];
    verifyTransports?: boolean;
    template?: string;
    prefix?: string;
    debug?: boolean;
    josk?: MailTimeJoSkOptions;
    recipientPolicies?: MailTimeRecipientPolicy[];
    onError?: (error: unknown, email: MailTimeTask | null, details?: object, recipients?: MailTimeRecipientResult[], summary?: MailTimeRecipientSummary) => void | Promise<void>;
    onSent?: (email: MailTimeTask, details?: object, recipients?: MailTimeRecipientResult[], summary?: MailTimeRecipientSummary) => void | Promise<void>;
    onSuppressed?: (email: MailTimeTask, recipients: MailTimeRecipientResult[], summary: MailTimeRecipientSummary) => void | Promise<void>;
    onRejected?: (email: MailTimeTask, recipients: MailTimeRecipientResult[], summary: MailTimeRecipientSummary) => void | Promise<void>;
};
/**
 * @typedef {import('./presets.js').MailTimePresetName} MailTimePresetName
 */
/**
 * @typedef {import('./presets.js').MailTimePresetConfig} MailTimePresetConfig
 */
/**
 * @typedef {{ status: string, code: number, statusCode: number, paused?: boolean, error?: unknown }} MailTimePingResult
 */
/**
 * @typedef {{ [key: string]: any, query?: (queryText: string, values?: unknown[]) => Promise<{ rows?: unknown[], rowCount?: number | null }> }} MailTimeStorageClient
 */
/**
 * @typedef {{ [key: string]: any }} MailTimeMongoDb
 */
/**
 * @typedef {{ [key: string]: any }} MailTimeTransport
 */
/**
 * @typedef {{ [key: string]: any, type?: 'mongo' | 'redis' | 'postgres', client?: MailTimeStorageClient, db?: MailTimeMongoDb, prefix?: string, resetOnInit?: boolean, useHashTags?: boolean }} MailTimeJoSkAdapterOptions
 */
/**
 * @typedef {{ [key: string]: any, adapter: MailTimeJoSkAdapterOptions | object, debug?: boolean, autoClear?: boolean, zombieTime?: number, lockLeaseTime?: number, minRevolvingDelay?: number, maxRevolvingDelay?: number, execute?: 'batch' | 'one', concurrency?: number, lockOwnerId?: string, resetOnInit?: boolean, onError?: (title: string, details: object) => void, onExecuted?: (uid: string, details: object) => void }} MailTimeJoSkOptions
 */
/**
 * @typedef {{ [key: string]: any, ping: () => Promise<MailTimePingResult>, setInterval: (func: (...args: any[]) => unknown, delay: number, uid: string) => Promise<string>, destroy: () => boolean, shutdown: (opts?: { timeout?: number }) => Promise<boolean>, pause: (timerId?: string) => boolean, resume: (timerId?: string) => boolean }} MailTimeScheduler
 */
/**
 * @typedef {string | { address: string, name?: string }} MailTimeMailbox
 */
/**
 * @typedef {{ address: string, sources: Array<'envelope' | 'to' | 'cc' | 'bcc'> }} MailTimePolicyRecipient
 * @typedef {{ address: string, status: 'suppressed' | 'rejected' | 'retry', reason: string }} MailTimePolicyDecision
 * @typedef {{ decisions?: MailTimePolicyDecision[] }} MailTimePolicyResult
 * @typedef {{ index: number, name?: string }} MailTimePolicyTransport
 * @typedef {{ from?: string, to: string[] }} MailTimePolicyEnvelope
 * @typedef {{ task: MailTimeTask, attempt: number, transport: MailTimePolicyTransport, envelope: MailTimePolicyEnvelope, recipients: MailTimePolicyRecipient[] }} MailTimePolicyContext
 * @typedef {MailTimePolicyContext} MailTimeBeforeSendPolicyContext
 * @typedef {{ address: string | null, command?: string, responseCode?: number, response?: string, message?: string, transportIndex: number, transportName?: string }} MailTimeStructuredRejection
 * @typedef {MailTimePolicyContext & { error?: unknown, info?: unknown, rejections: MailTimeStructuredRejection[] }} MailTimeRejectionPolicyContext
 * @typedef {{ address: string, status: 'sent' | 'error' | 'suppressed' | 'rejected', sources?: Array<'envelope' | 'to' | 'cc' | 'bcc'>, reasons: Array<{ provider: string, reason: string }>, attempt: number, transportIndex?: number, transportName?: string, command?: string, responseCode?: number, response?: string, message?: string }} MailTimeRecipientResult
 * @typedef {MailTimeRejectionPolicyContext & { decisions: MailTimeRecipientResult[] }} MailTimeRecipientAttemptContext
 * @typedef {{ uuid: string, tries: number, isSettled: boolean, recipients: { sent: MailTimeRecipientResult[], error: MailTimeRecipientResult[], suppressed: MailTimeRecipientResult[], rejected: MailTimeRecipientResult[] } }} MailTimeRecipientSummary
 * @typedef {{ name: string, failureMode?: 'retry' | 'continue', beforeSend?: (context: MailTimeBeforeSendPolicyContext) => void | MailTimePolicyResult | Promise<void | MailTimePolicyResult>, classifyRejections?: (context: MailTimeRejectionPolicyContext) => void | MailTimePolicyResult | Promise<void | MailTimePolicyResult>, observeAttempt?: (context: MailTimeRecipientAttemptContext) => void | Promise<void> }} MailTimeRecipientPolicy
 * @description Policy contexts are read-only by contract. Providers must bound their own I/O; renewal budgets do not limit hook duration.
 */
/**
 * @typedef {{ uuid: string, to?: MailTimeMailbox | MailTimeMailbox[], tries: number, sendAt: number, isSent: boolean, isSettled?: boolean, recipientResults?: MailTimeRecipientResult[], isCancelled: boolean, isFailed: boolean, isSending?: boolean, sendingAt?: number, template?: string | false, transport: number, concatSubject?: string | false, mailOptions: MailTimeMailOptions[] }} MailTimeTask
 */
/**
 * @typedef {{ limit?: number, sendingTimeout?: number }} MailTimeIterateOptions
 */
/**
 * @typedef {{ ping: () => Promise<MailTimePingResult>, iterate: (opts?: MailTimeIterateOptions) => Promise<void> | void, getPendingTo: (to: string, sendAt: number) => Promise<MailTimeTask | object | null>, push: (email: MailTimeTask) => Promise<void> | void, cancel: (uuid: string) => Promise<boolean>, remove: (email: MailTimeTask | object, opts?: { leaseTries: number, leaseSendingAt: number }) => Promise<boolean>, update: (email: MailTimeTask | object, updateObj: object) => Promise<boolean>, ready?: () => Promise<void>, supportsRecipientPolicies?: boolean }} CustomQueue
 */
/**
 * @typedef {{ address: string, error: string }} MailTimeRejectedRecipient
 */
/**
 * @typedef {{ [key: string]: any, to: MailTimeMailbox | MailTimeMailbox[], cc?: MailTimeMailbox | MailTimeMailbox[], bcc?: MailTimeMailbox | MailTimeMailbox[], sendAt?: Date | number, template?: string, concatSubject?: string, text?: string | false, html?: string | false, subject?: string, accepted?: string[], rejected?: MailTimeRejectedRecipient[] }} MailTimeMailOptions
 */
/**
 * @typedef {{ subject?: string }} MailTimeConcatEmailsOptions
 */
/**
 * @typedef {{ index: number, from: string | undefined }} MailTimeFromDetails
 */
/**
 * @typedef {{ queue: RedisQueue | MongoQueue | PostgresQueue | CustomQueue, type?: 'server' | 'client', from?: string | ((transport: MailTimeTransport, details: MailTimeFromDetails) => string), transports?: MailTimeTransport[], strategy?: 'backup' | 'balancer', failsToNext?: number, shouldFailOver?: (error: unknown, info: object | undefined, email: MailTimeTask) => boolean, retries?: number, maxTries?: number, retryDelay?: number, interval?: number, keepHistory?: boolean, concatEmails?: boolean | MailTimeConcatEmailsOptions, concatSubject?: string, concatDelimiter?: string, concatDelay?: number, concatThrottling?: number, revolvingInterval?: number, mode?: 'one' | 'batch', concurrency?: number, sendingTimeout?: number, renewClaim?: boolean | number, maxRenewals?: number, strictPayload?: boolean, allowedMailFields?: string[], verifyTransports?: boolean, template?: string, prefix?: string, debug?: boolean, josk?: MailTimeJoSkOptions, recipientPolicies?: MailTimeRecipientPolicy[], onError?: (error: unknown, email: MailTimeTask | null, details?: object, recipients?: MailTimeRecipientResult[], summary?: MailTimeRecipientSummary) => void | Promise<void>, onSent?: (email: MailTimeTask, details?: object, recipients?: MailTimeRecipientResult[], summary?: MailTimeRecipientSummary) => void | Promise<void>, onSuppressed?: (email: MailTimeTask, recipients: MailTimeRecipientResult[], summary: MailTimeRecipientSummary) => void | Promise<void>, onRejected?: (email: MailTimeTask, recipients: MailTimeRecipientResult[], summary: MailTimeRecipientSummary) => void | Promise<void> }} MailTimeOptions
 */
/**
 * Class of MailTime.
 * With recipientPolicies, terminal callbacks receive grouped recipients and a complete summary after persistence.
 * isSettled includes exhausted errors; isSent means all accepted; isFailed means an error or permanent rejection.
 * Unparseable terminal preparation failures invoke onError with an empty recipient group.
 * Hooks must bound their own I/O. Callback notifications are best-effort, not durable exactly-once delivery.
 */
export class MailTime {
    static set Template(newVal: string);
    static get Template(): string;
    /**
     * @static
     * @memberOf MailTime
     * @name transportFrom
     * @description Best-effort sender address for a transport. `nodemailer.createTransport()`
     * only exposes `.options` for *plain-object* configs — for a class-instance transporter
     * (anything with its own `.send()`) nodemailer's internal `Mail.options` is always `{}`,
     * so `transport.options.from` silently reads `undefined`. This walks the places the
     * address can actually live.
     * @param {MailTimeTransport} transport
     * @returns {string | undefined}
     */
    static transportFrom(transport: MailTimeTransport): string | undefined;
    /**
     * Create a MailTime instance
     * @param {MailTimeOptions} opts - configuration object
     */
    constructor(opts: MailTimeOptions);
    queue: MongoQueue | RedisQueue | PostgresQueue | CustomQueue;
    debug: boolean;
    type: "server" | "client";
    prefix: string;
    maxTries: number;
    retryDelay: number;
    template: string;
    keepHistory: boolean;
    onSent: (email: MailTimeTask, details?: object, recipients?: MailTimeRecipientResult[], summary?: MailTimeRecipientSummary) => void | Promise<void>;
    onError: (error: unknown, email: MailTimeTask | null, details?: object, recipients?: MailTimeRecipientResult[], summary?: MailTimeRecipientSummary) => void | Promise<void>;
    onSuppressed: (email: MailTimeTask, recipients: MailTimeRecipientResult[], summary: MailTimeRecipientSummary) => void | Promise<void>;
    onRejected: (email: MailTimeTask, recipients: MailTimeRecipientResult[], summary: MailTimeRecipientSummary) => void | Promise<void>;
    revolvingInterval: number;
    mode: "one" | "batch";
    concurrency: number;
    sendingTimeout: number;
    renewClaim: number;
    maxRenewals: number;
    shouldFailOver: ((error: unknown, info: object | undefined, email: MailTimeTask) => boolean) | null;
    strictPayload: boolean;
    allowedMailFields: Set<string>;
    failsToNext: number;
    strategy: "backup" | "balancer";
    transports: MailTimeTransport[];
    transport: number;
    verifyTransports: boolean;
    from: boolean | ((transport: MailTimeTransport, details: MailTimeFromDetails) => string);
    /** @type {string} */
    concatSubject: string;
    concatEmails: boolean;
    concatDelimiter: string;
    concatDelay: number;
    josk: {
        [key: string]: any;
        adapter: MailTimeJoSkAdapterOptions | object;
        debug?: boolean;
        autoClear?: boolean;
        zombieTime?: number;
        lockLeaseTime?: number;
        minRevolvingDelay?: number;
        maxRevolvingDelay?: number;
        execute?: "batch" | "one";
        concurrency?: number;
        lockOwnerId?: string;
        resetOnInit?: boolean;
        onError?: (title: string, details: object) => void;
        onExecuted?: (uid: string, details: object) => void;
    } | undefined;
    /** @type {MailTimeScheduler | undefined} */
    scheduler: MailTimeScheduler | undefined;
    /**
     * @async
     * @memberOf MailTime
     * @name ping
     * @description Check package readiness and connection to Storage
     * @returns {Promise<MailTimePingResult>}
     * @throws {Error}
     */
    ping(): Promise<MailTimePingResult>;
    /**
     * @async
     * @memberOf MailTime
     * @name ready
     * @description Wait until queue and scheduler storage are ready
     * @returns {Promise<MailTime>}
     */
    ready(): Promise<MailTime>;
    /**
     * @memberOf MailTime
     * @name destroy
     * @description Stop the scheduler and block future dispatches. Without `{ drain: true }`, in-flight SMTP attempts are neutralized and their claims recover after `sendingTimeout`. With `{ drain: true }`, await JoSk shutdown and in-flight SMTP; resolves false if a scheduler handler exceeds `schedulerTimeout` (default 10000ms) or JoSk shutdown throws (logged); never rejects. The timeout does not bound SMTP drain time.
     * @param {{ drain?: boolean, schedulerTimeout?: number }} [opts] - schedulerTimeout must be finite and non-negative; used only with drain
     * @returns {boolean | Promise<boolean>}
     */
    destroy(opts?: {
        drain?: boolean;
        schedulerTimeout?: number;
    }): boolean | Promise<boolean>;
    /**
     * @async
     * @memberOf MailTime
     * @name drain
     * @description Wait for all in-flight email send attempts to settle
     * @returns {Promise<void>}
     */
    drain(): Promise<void>;
    /**
     * @memberOf MailTime
     * @name pause
     * @description Pause this server instance from competing for the queue-drain lease. In-flight SMTP sends finish; peer server instances keep draining. Reversible (unlike `destroy()`). No-op on `client` instances or after `destroy()`. To stop scanning *and* wait for in-flight sends: `mailTime.pause(); await mailTime.drain();`.
     * @returns {boolean} `true` if newly paused; `false` if already paused, a client instance, or destroyed
     */
    pause(): boolean;
    /**
     * @memberOf MailTime
     * @name resume
     * @description Resume competing for the queue-drain lease after `pause()`; triggers an immediate scan. No-op on `client` instances, after `destroy()`, or when not paused.
     * @returns {boolean} `true` if newly resumed; `false` if not paused, a client instance, or destroyed
     */
    resume(): boolean;
    /**
     * @memberOf MailTime
     * @name isPaused
     * @description Whether this instance is currently paused from draining the queue. Always `false` on `client` instances.
     * @returns {boolean}
     */
    get isPaused(): boolean;
    /**
     * @memberOf MailTime
     * @name send
     * @description alias of `sendMail`
     * @param {MailTimeMailOptions} opts - email options
     * @returns {Promise<string>} uuid of the email
     */
    send(opts: MailTimeMailOptions): Promise<string>;
    /**
     * @async
     * @memberOf MailTime
     * @name sendMail
     * @description add email to the queue or append to existing letter if {concatEmails: true}
     * @param {MailTimeMailOptions} opts - email options
     * @returns {Promise<string>} uuid of the email
     * @throws {Error}
     */
    sendMail(opts: MailTimeMailOptions): Promise<string>;
    /**
     * @async
     * @memberOf MailTime
     * @name cancel
     * @description alias of `cancelMail`
     * @param {string|Promise<string>} uuid - uuid returned from `send` or `sendMail`
     * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found was sent or was cancelled previously
     */
    cancel(uuid: string | Promise<string>): Promise<boolean>;
    /**
     * @async
     * @memberOf MailTime
     * @name cancelMail
     * @description remove email from the queue or mark as `isCancelled`
     * @param {string|Promise<string>} uuid - uuid returned from `send` or `sendMail`
     * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found was sent or was cancelled previously
     */
    cancelMail(uuid: string | Promise<string>): Promise<boolean>;
}
import { MongoQueue } from './adapters/mongo.js';
import { RedisQueue } from './adapters/redis.js';
import { PostgresQueue } from './adapters/postgres.js';
import { mailTimePreset } from './presets.js';
import { presets } from './presets.js';
import { presetNames } from './presets.js';
export { MongoQueue, RedisQueue, PostgresQueue, mailTimePreset, presets, presetNames };

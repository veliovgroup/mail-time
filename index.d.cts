export type MailTimePingResult = {
    status: string;
    code: number;
    statusCode: number;
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
};
export type MailTimeJoSkOptions = {
    [key: string]: any;
    adapter: MailTimeJoSkAdapterOptions | object;
    debug?: boolean;
    autoClear?: boolean;
    zombieTime?: number;
    minRevolvingDelay?: number;
    maxRevolvingDelay?: number;
    execute?: "batch" | "one";
    lockOwnerId?: string;
    resetOnInit?: boolean;
};
export type MailTimeTask = {
    uuid: string;
    to?: string | string[];
    tries: number;
    sendAt: number;
    isSent: boolean;
    isCancelled: boolean;
    isFailed: boolean;
    template?: string | false;
    transport: number;
    concatSubject?: string | false;
    mailOptions: MailTimeMailOptions[];
};
export type CustomQueue = {
    ping: () => Promise<MailTimePingResult>;
    iterate: () => Promise<void> | void;
    getPendingTo: (to: string, sendAt: number) => Promise<MailTimeTask | object | null>;
    push: (email: MailTimeTask) => Promise<void> | void;
    cancel: (uuid: string) => Promise<boolean>;
    remove: (email: MailTimeTask | object) => Promise<boolean>;
    update: (email: MailTimeTask | object, updateObj: object) => Promise<boolean>;
    ready?: () => Promise<void>;
};
export type MailTimeMailOptions = {
    [key: string]: any;
    to: string | string[];
    sendAt?: Date | number;
    template?: string;
    concatSubject?: string;
    text?: string | false;
    html?: string | false;
    subject?: string;
};
export type MailTimeOptions = {
    queue: RedisQueue | MongoQueue | PostgresQueue | CustomQueue;
    type?: "server" | "client";
    from?: string | ((transport: MailTimeTransport) => string);
    transports?: MailTimeTransport[];
    strategy?: "backup" | "balancer";
    failsToNext?: number;
    retries?: number;
    maxTries?: number;
    retryDelay?: number;
    interval?: number;
    keepHistory?: boolean;
    concatEmails?: boolean;
    concatSubject?: string;
    concatDelimiter?: string;
    concatDelay?: number;
    concatThrottling?: number;
    revolvingInterval?: number;
    template?: string;
    prefix?: string;
    debug?: boolean;
    josk?: MailTimeJoSkOptions;
    onError?: (error: unknown, email: MailTimeTask, details?: object) => void;
    onSent?: (email: MailTimeTask, details?: object) => void;
};
/**
 * @typedef {{ status: string, code: number, statusCode: number, error?: unknown }} MailTimePingResult
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
 * @typedef {{ [key: string]: any, type?: 'mongo' | 'redis' | 'postgres', client?: MailTimeStorageClient, db?: MailTimeMongoDb, prefix?: string, resetOnInit?: boolean }} MailTimeJoSkAdapterOptions
 */
/**
 * @typedef {{ [key: string]: any, adapter: MailTimeJoSkAdapterOptions | object, debug?: boolean, autoClear?: boolean, zombieTime?: number, minRevolvingDelay?: number, maxRevolvingDelay?: number, execute?: 'batch' | 'one', lockOwnerId?: string, resetOnInit?: boolean }} MailTimeJoSkOptions
 */
/**
 * @typedef {{ uuid: string, to?: string | string[], tries: number, sendAt: number, isSent: boolean, isCancelled: boolean, isFailed: boolean, template?: string | false, transport: number, concatSubject?: string | false, mailOptions: MailTimeMailOptions[] }} MailTimeTask
 */
/**
 * @typedef {{ ping: () => Promise<MailTimePingResult>, iterate: () => Promise<void> | void, getPendingTo: (to: string, sendAt: number) => Promise<MailTimeTask | object | null>, push: (email: MailTimeTask) => Promise<void> | void, cancel: (uuid: string) => Promise<boolean>, remove: (email: MailTimeTask | object) => Promise<boolean>, update: (email: MailTimeTask | object, updateObj: object) => Promise<boolean>, ready?: () => Promise<void> }} CustomQueue
 */
/**
 * @typedef {{ [key: string]: any, to: string | string[], sendAt?: Date | number, template?: string, concatSubject?: string, text?: string | false, html?: string | false, subject?: string }} MailTimeMailOptions
 */
/**
 * @typedef {{ queue: RedisQueue | MongoQueue | PostgresQueue | CustomQueue, type?: 'server' | 'client', from?: string | ((transport: MailTimeTransport) => string), transports?: MailTimeTransport[], strategy?: 'backup' | 'balancer', failsToNext?: number, retries?: number, maxTries?: number, retryDelay?: number, interval?: number, keepHistory?: boolean, concatEmails?: boolean, concatSubject?: string, concatDelimiter?: string, concatDelay?: number, concatThrottling?: number, revolvingInterval?: number, template?: string, prefix?: string, debug?: boolean, josk?: MailTimeJoSkOptions, onError?: (error: unknown, email: MailTimeTask, details?: object) => void, onSent?: (email: MailTimeTask, details?: object) => void }} MailTimeOptions
 */
/** Class of MailTime */
export class MailTime {
    static set Template(newVal: string);
    static get Template(): string;
    /**
     * Create a MailTime instance
     * @param {MailTimeOptions} opts - configuration object
     */
    constructor(opts: MailTimeOptions);
    queue: MongoQueue | RedisQueue | PostgresQueue | CustomQueue;
    debug: boolean;
    _debug: (...args: any[]) => void;
    type: "server" | "client";
    prefix: string;
    maxTries: number;
    retryDelay: number;
    template: string;
    keepHistory: boolean;
    onSent: (email: MailTimeTask, details?: object) => void;
    onError: (error: unknown, email: MailTimeTask, details?: object) => void;
    revolvingInterval: number;
    __isDestroyed: boolean;
    __readyPromise: Promise<MailTime>;
    __schedulerTimer: Promise<string> | null;
    failsToNext: number;
    strategy: "backup" | "balancer";
    transports: MailTimeTransport[];
    transport: number;
    from: boolean | (() => string | ((transport: MailTimeTransport) => string) | undefined) | ((transport: MailTimeTransport) => string);
    concatEmails: boolean;
    concatSubject: string;
    concatDelimiter: string;
    concatDelay: number;
    josk: {
        [key: string]: any;
        adapter: MailTimeJoSkAdapterOptions | object;
        debug?: boolean;
        autoClear?: boolean;
        zombieTime?: number;
        minRevolvingDelay?: number;
        maxRevolvingDelay?: number;
        execute?: "batch" | "one";
        lockOwnerId?: string;
        resetOnInit?: boolean;
    } | undefined;
    scheduler: JoSk | undefined;
    /**
     * @async
     * @memberOf MailTime
     * @name ping
     * @description Check package readiness and connection to Storage
     * @returns {Promise<MailTimePingResult>}
     * @throws {mix}
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
     * @description Destroy scheduler instance and stop future queue iterations
     * @returns {boolean}
     */
    destroy(): boolean;
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
    sendMail(opts?: MailTimeMailOptions): Promise<string>;
    /**
     * @memberOf MailTime
     * @name cancel
     * @description alias of `cancelMail`
     * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found was sent or was cancelled previously
     */
    cancel(uuid: any): Promise<boolean>;
    /**
     * @async
     * @memberOf MailTime
     * @name cancelMail
     * @description remove email from the queue or mark as `isCancelled`
     * @param {string|Promise<string>} uuid - uuid returned from `send` or `sendMail`
     * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found was sent or was cancelled previously
     */
    cancelMail(uuid: string | Promise<string>): Promise<boolean>;
    /**
     * @async
     * @memberOf MailTime
     * @name ___handleError
     * @description Handle runtime errors and pass to `onError` callback
     * @param {MailTimeTask} task - Email task record from Storage
     * @param {unknown} error - Error String/Object/Error
     * @param {object} info - Info object returned from nodemailer
     * @returns {Promise<void 0>}
     */
    ___handleError(task: MailTimeTask, error: unknown, info: object): Promise<void>;
    /**
     * @async
     * @memberOf MailTime
     * @name ___addToQueue
     * @description Prepare task's object and push to the queue
     * @param {{ sendAt: number, template: string | false, mailOptions: MailTimeMailOptions, concatSubject: string | false }} opts - Email options
     * @returns {Promise<string>} message uuid
     */
    ___addToQueue(opts: {
        sendAt: number;
        template: string | false;
        mailOptions: MailTimeMailOptions;
        concatSubject: string | false;
    }): Promise<string>;
    /**
     * @memberOf MailTime
     * @name ___render
     * @description Render templates
     * @param {string} _string - Template with Mustache-like placeholders
     * @param {Record<string, any>} replacements - Blaze/Mustache-like helpers Object
     * @returns {string}
     */
    ___render(_string: string, replacements: Record<string, any>): string;
    /**
     * @memberOf MailTime
     * @name ___compileMailOpts
     * @description Run various checks, compile options, and render template
     * @param {MailTimeTransport} transport - Current transport
     * @param {MailTimeTask} task - Email task record from Storage
     * @returns {MailTimeMailOptions}
     */
    ___compileMailOpts(transport: MailTimeTransport, task: MailTimeTask): MailTimeMailOptions;
    /**
     * @async
     * @memberOf MailTime
     * @name ___send
     * @description send email using nodemailer's transport
     * @param {MailTimeTask} task - email's task object from Storage
     * @returns {Promise<void 0>}
     */
    ___send(task: MailTimeTask): Promise<void>;
    /**
     * @memberOf MailTime
     * @name ___iterate
     * @description Iterate over queued tasks
     * @returns {Promise}
     */
    ___iterate(): Promise<any>;
    /**
     * @async
     * @memberOf MailTime
     * @name ___ready
     * @description Internal storage readiness gate
     * @returns {Promise<MailTime>}
     */
    ___ready(): Promise<MailTime>;
}
import { MongoQueue } from './adapters/mongo.js';
import { RedisQueue } from './adapters/redis.js';
import { PostgresQueue } from './adapters/postgres.js';
import { JoSk } from 'josk';
export { MongoQueue, RedisQueue, PostgresQueue };

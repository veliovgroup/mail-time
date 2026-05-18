export type RedisClient = {
    exists: (key: string) => Promise<number>;
    get: (key: string) => Promise<string | null>;
    set: (key: string, value: string, options?: object) => Promise<unknown>;
    del: (key: string | string[]) => Promise<number>;
    ping: () => Promise<string>;
    scanIterator: (options: object) => AsyncIterable<string | string[]>;
    watch?: ((key: string) => Promise<unknown>) | undefined;
    unwatch?: (() => Promise<unknown>) | undefined;
    multi?: (() => object) | undefined;
};
export type RedisQueueOption = {
    client: RedisClient;
    prefix?: string | undefined;
};
/** Class representing Redis Queue for MailTime */
export class RedisQueue {
    /**
     * Create a RedisQueue instance
     * @param {RedisQueueOption} opts - configuration object
     */
    constructor(opts: RedisQueueOption);
    name: string;
    client: RedisClient;
    prefix: any;
    uniqueName: string | undefined;
    /**
     * @async
     * @memberOf RedisQueue
     * @name ready
     * @description Storage adapter has no async setup
     * @returns {Promise<void 0>}
     */
    ready(): Promise<void>;
    /**
     * @async
     * @memberOf RedisQueue
     * @name ping
     * @description Check connection to Storage
     * @returns {Promise<object>}
     */
    ping(): Promise<object>;
    /**
     * @memberOf RedisQueue
     * @name iterate
     * @description iterate over queued tasks passing each to `mailTimeInstance.___dispatch` (the bounded send pool)
     * @param {{ limit?: number, sendingTimeout?: number }} [opts] - iteration options
     * @returns {Promise<void>}
     */
    iterate(opts?: {
        limit?: number;
        sendingTimeout?: number;
    }): Promise<void>;
    /**
     * @async
     * @memberOf RedisQueue
     * @name getPendingTo
     * @description get queued task by `to` field (addressee)
     * @param to {string} - email address
     * @param sendAt {number} - timestamp
     * @returns {Promise<object|null>}
     */
    getPendingTo(to: string, sendAt: number): Promise<object | null>;
    /**
     * @async
     * @memberOf RedisQueue
     * @name push
     * @description push task to the queue/storage
     * @param task {object} - task's object
     * @returns {Promise<void 0>}
     */
    push(task: object): Promise<void>;
    /**
     * @async
     * @memberOf RedisQueue
     * @name cancel
     * @description cancel scheduled email
     * @param uuid {string} - email's uuid
     * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found, was sent, or was cancelled previously
     */
    cancel(uuid: string): Promise<boolean>;
    /**
     * @async
     * @memberOf RedisQueue
     * @name remove
     * @description remove task from queue
     * @param task {object} - task's object
     * @returns {Promise<boolean>} returns `true` if removed or `false` if not found
     */
    remove(task: object): Promise<boolean>;
    /**
     * @async
     * @memberOf RedisQueue
     * @name update
     * @description update task in queue
     * @param task {object} - task's object
     * @param updateObj {object} - fields with new values to update
     * @returns {Promise<boolean>} returns `true` if updated or `false` if not found or no changes was made
     */
    update(task: object, updateObj: object): Promise<boolean>;
}

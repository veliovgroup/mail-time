export type PostgresQueryResult = {
    rowCount?: number | null | undefined;
    rows?: unknown[] | undefined;
};
export type PostgresClient = {
    query: (queryText: string, values?: unknown[]) => Promise<PostgresQueryResult>;
};
export type PostgresQueueOption = {
    client: PostgresClient;
    prefix?: string | undefined;
};
/** Class representing PostgreSQL Queue for MailTime */
export class PostgresQueue {
    /**
     * Create a PostgresQueue instance
     * @param {PostgresQueueOption} opts - configuration object
     */
    constructor(opts: PostgresQueueOption);
    name: string;
    client: PostgresClient;
    prefix: any;
    /**
     * @async
     * @memberOf PostgresQueue
     * @name ready
     * @description Wait until PostgreSQL schema is ready
     * @returns {Promise<void 0>}
     */
    ready(): Promise<void>;
    /**
     * @async
     * @memberOf PostgresQueue
     * @name ping
     * @description Check connection to Storage
     * @returns {Promise<object>}
     */
    ping(): Promise<object>;
    /**
     * @memberOf PostgresQueue
     * @name iterate
     * @description iterate over queued tasks passing each to `mailTimeInstance.___dispatch` (the bounded send pool). Postgres reads buffer the full result, so each tick is bounded by `opts.limit` (or 1000 when caller passes `Infinity` / no limit) to keep memory predictable; high-throughput deployments should shard prefixes.
     * @param {{ limit?: number, sendingTimeout?: number }} [opts] - iteration options
     * @returns {Promise<void>}
     */
    iterate(opts?: {
        limit?: number;
        sendingTimeout?: number;
    }): Promise<void>;
    /**
     * @async
     * @memberOf PostgresQueue
     * @name getPendingTo
     * @description get queued task by `to` field (addressee)
     * @param to {string} - email address
     * @param sendAt {number} - timestamp
     * @returns {Promise<object|null>}
     */
    getPendingTo(to: string, sendAt: number): Promise<object | null>;
    /**
     * @async
     * @memberOf PostgresQueue
     * @name push
     * @description push task to the queue/storage
     * @param task {object} - task's object
     * @returns {Promise<void 0>}
     */
    push(task: object): Promise<void>;
    /**
     * @async
     * @memberOf PostgresQueue
     * @name cancel
     * @description cancel scheduled email
     * @param uuid {string} - email's uuid
     * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found, was sent, or was cancelled previously
     */
    cancel(uuid: string): Promise<boolean>;
    /**
     * @async
     * @memberOf PostgresQueue
     * @name remove
     * @description remove task from queue
     * @param task {object} - task's object
     * @param {{ leaseTries: number, leaseSendingAt: number }} [opts] - lease guard: only remove if this worker still holds the lease (tries + sendingAt match, row not cancelled/failed)
     * @returns {Promise<boolean>} returns `true` if removed or `false` if not found
     */
    remove(task: object, opts?: {
        leaseTries: number;
        leaseSendingAt: number;
    }): Promise<boolean>;
    /**
     * @async
     * @memberOf PostgresQueue
     * @name update
     * @description update task in queue
     * @param task {object} - task's object
     * @param updateObj {object} - fields with new values to update
     * @returns {Promise<boolean>} returns `true` if updated or `false` if not found or no changes was made
     */
    update(task: object, updateObj: object): Promise<boolean>;
}

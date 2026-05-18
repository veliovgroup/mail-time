export type MongoCollection = {
    collectionName?: string | undefined;
    createIndex: (keys: object, opts?: object) => Promise<unknown>;
    indexes: () => Promise<{
        name: string;
        key: Record<string, unknown>;
    }[]>;
    dropIndex: (name: string) => Promise<unknown>;
    find: (query: object, opts?: object) => unknown;
    findOne: (query: object, opts?: object) => Promise<object | null>;
    insertOne: (doc: object) => Promise<unknown>;
    deleteOne: (query: object) => Promise<{
        deletedCount?: number;
    }>;
    updateOne: (query: object, update: object) => Promise<{
        modifiedCount?: number;
    }>;
};
export type Db = {
    collection: (name: string) => MongoCollection;
    command: (cmd: object) => Promise<{
        ok?: number;
    }>;
};
export type MongoQueueOption = {
    db: Db;
    prefix?: string | undefined;
};
/** Class representing MongoDB Queue for MailTime */
export class MongoQueue {
    /**
     * Create a MongoQueue instance
     * @param {MongoQueueOption} opts - configuration object
     */
    constructor(opts: MongoQueueOption);
    name: string;
    db: Db;
    prefix: any;
    collection: MongoCollection | undefined;
    /**
     * @async
     * @memberOf MongoQueue
     * @name ready
     * @description Wait until indexes are created
     * @returns {Promise<void 0>}
     */
    ready(): Promise<void>;
    /**
     * @async
     * @memberOf MongoQueue
     * @name ping
     * @description Check connection to Storage
     * @returns {Promise<object>}
     */
    ping(): Promise<object>;
    /**
     * @memberOf MongoQueue
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
     * @memberOf MongoQueue
     * @name getPendingTo
     * @description get queued task by `to` field (addressee)
     * @param to {string} - email address
     * @param sendAt {number} - timestamp
     * @returns {Promise<object|null>}
     */
    getPendingTo(to: string, sendAt: number): Promise<object | null>;
    /**
     * @async
     * @memberOf MongoQueue
     * @name push
     * @description push task to the queue/storage
     * @param task {object} - task's object
     * @returns {Promise<void 0>}
     */
    push(task: object): Promise<void>;
    /**
     * @async
     * @memberOf MongoQueue
     * @name cancel
     * @description cancel scheduled email
     * @param uuid {string} - email's uuid
     * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found, was sent, or was cancelled previously
     */
    cancel(uuid: string): Promise<boolean>;
    /**
     * @async
     * @memberOf MongoQueue
     * @name remove
     * @description remove task from queue
     * @param task {object} - task's object
     * @returns {Promise<boolean>} returns `true` if removed or `false` if not found
     */
    remove(task: object): Promise<boolean>;
    /**
     * @async
     * @memberOf MongoQueue
     * @name update
     * @description update task in queue
     * @param task {object} - task's object
     * @param updateObj {object} - fields with new values to update
     * @returns {Promise<boolean>} returns `true` if updated or `false` if not found or no changes was made
     */
    update(task: object, updateObj: object): Promise<boolean>;
}

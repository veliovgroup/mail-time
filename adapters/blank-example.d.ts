/** Class representing Example Queue for MailTime */
export class BlankQueue {
    /**
     * Create a BlankQueue instance
     * @param {object} opts - configuration object
     * @param {object} opts.requiredOption - Required option description
     * @param {string} [opts.prefix] - Optional prefix for scope isolation; use when creating multiple MailTime instances within the single application
     */
    constructor(opts: {
        requiredOption: object;
        prefix?: string | undefined;
    });
    name: string;
    prefix: string;
    uniqueName: string;
    requiredOption: object;
    /**
     * @async
     * @memberOf BlankQueue
     * @name ping
     * @description Check connection to Storage
     * @returns {Promise<object>}
     */
    ping(): Promise<object>;
    /**
     * @memberOf BlankQueue
     * @name iterate
     * @description iterate over queued emails passing to `mailTimeInstance.___send` method
     * @param {{ limit?: number, sendingTimeout?: number }} [opts] - iteration options. Honor `opts.limit` (stop after that many dispatches) for `mode: 'one'`, and use `opts.sendingTimeout` (ms) to reclaim rows whose worker died mid-send.
     * @returns {Promise<void>}
     */
    iterate(opts?: {
        limit?: number;
        sendingTimeout?: number;
    }): Promise<void>;
    /**
     * @async
     * @memberOf BlankQueue
     * @name getPendingTo
     * @description get queued email by `to` field (addressee)
     * @param to {string} - email address
     * @param sendAt {number} - timestamp
     * @returns {Promise<object|null>}
     */
    getPendingTo(to: string, sendAt: number): Promise<object | null>;
    /**
     * @async
     * @memberOf BlankQueue
     * @name push
     * @description push email to the queue/storage
     * @param email {object} - email's object
     * @returns {Promise<void 0>}
     */
    push(email: object): Promise<void>;
    /**
     * @async
     * @memberOf BlankQueue
     * @name cancel
     * @description cancel scheduled email
     * @param uuid {string} - email's uuid
     * @returns {Promise<boolean>} returns `true` if cancelled or `false` if not found, was sent, or was cancelled previously
     */
    cancel(uuid: string): Promise<boolean>;
    /**
     * @async
     * @memberOf BlankQueue
     * @name remove
     * @description remove email from queue
     * @param email {object} - email's object
     * @returns {Promise<boolean>} returns `true` if removed or `false` if not found
     */
    remove(email: object): Promise<boolean>;
    /**
     * @async
     * @memberOf BlankQueue
     * @name update
     * @description remove email from queue
     * @param email {object} - email's object
     * @param updateObj {object} - fields with new values to update
     * @returns {Promise<boolean>} returns `true` if updated or `false` if not found or no changes was made
     */
    update(email: object, updateObj: object): Promise<boolean>;
}

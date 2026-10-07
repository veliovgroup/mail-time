import { MailTime, MongoQueue, PostgresQueue, RedisQueue, mailTimePreset, presetNames, presets } from 'mail-time';
import { RedisQueue as RedisQueueAdapter } from 'mail-time/adapters/redis';
import type { RedisClientType, RedisClusterType } from 'redis';
import type { Db as MongoDb } from 'mongodb';
import type {
  CustomQueue,
  MailTimeJoSkOptions,
  MailTimeMailOptions,
  MailTimeFromDetails,
  MailTimeErrorDetails,
  MailTimeOptions,
  MailTimePingResult,
  MailTimeScheduler,
  MailTimePresetConfig,
  MailTimePresetName,
  MailTimeTask,
  MailTimeTransport
} from 'mail-time';

declare const scheduler: MailTimeScheduler;
void scheduler.pause();
type IsAny<T> = 0 extends (1 & T) ? true : false;
const shutdownIsTyped: false = false as IsAny<MailTimeScheduler['shutdown']>;
void shutdownIsTyped;
void scheduler.shutdown({ timeout: 10000 });

// Subpath exports — must resolve and re-expose the same constructors / function.
import { MongoQueue as MongoQueueSub } from 'mail-time/adapters/mongo';
import { RedisQueue as RedisQueueSub } from 'mail-time/adapters/redis';
import { PostgresQueue as PostgresQueueSub } from 'mail-time/adapters/postgres';
import { mailTimePreset as mailTimePresetSub } from 'mail-time/presets';
void MongoQueueSub;
void RedisQueueSub;
void PostgresQueueSub;
void mailTimePresetSub;

const queue: CustomQueue = {
  async ping(): Promise<MailTimePingResult> {
    return {
      status: 'OK',
      code: 200,
      statusCode: 200
    };
  },
  async iterate() {},
  async getPendingTo(_to: string, _sendAt: number) {
    return null;
  },
  async push(_email: object) {},
  async cancel(_uuid: string) {
    return true;
  },
  async remove(_email: object) {
    return true;
  },
  async update(_email: object, _updateObj: object) {
    return true;
  }
};

const transport: MailTimeTransport = {
  options: {
    from: 'noreply@example.com'
  },
  sendMail(_mail: object, done: (error: Error | null, info: object) => void) {
    done(null, { accepted: ['x@example.com'] });
  }
};

const joskOpts: MailTimeJoSkOptions = {
  adapter: {
    async acquireLock(_lock: { ownerId: string; leaseId: string; expireAt: Date; expiresAtMs: number }) {
      return true;
    },
    async releaseLock(_lock: { ownerId: string; leaseId: string; expireAt: Date; expiresAtMs: number }) {},
    async remove(_uid: string) {
      return true;
    },
    async add(_uid: string, _isInterval: boolean, _delay: number) {
      return true;
    },
    async update(_task: { uid: string }, _nextExecuteAt: Date) {
      return true;
    },
    async iterate(_nextExecuteAt: Date, _lock: { ownerId: string; leaseId: string; expireAt: Date; expiresAtMs: number }, _executeMode: 'one' | 'batch') {},
    async ping(): Promise<MailTimePingResult> {
      return {
        status: 'OK',
        code: 200,
        statusCode: 200
      };
    }
  },
  execute: 'one',
  concurrency: 4,
  lockLeaseTime: 60_000,
  lockOwnerId: 'owner-1'
};

const opts: MailTimeOptions = {
  type: 'server',
  queue,
  transports: [transport],
  josk: joskOpts,
  renewClaim: false,
  maxRenewals: 0,
  strictPayload: true,
  allowedMailFields: ['attachments'],
  from(_transport: MailTimeTransport, details: MailTimeFromDetails) {
    return details.from ?? 'noreply@example.com';
  },
  shouldFailOver(_error: unknown, info: object | undefined, email: MailTimeTask) {
    void info;
    void email;
    return false;
  },
  onError(error: unknown, email: MailTimeTask | null, details?: MailTimeErrorDetails) {
    error;
    email;
    const phase: 'verify' | 'complete' | 'checkpoint' | undefined = details?.phase;
    const transportIndex: number | undefined = details?.transportIndex;
    const attempt: number | undefined = details?.attempt;
    const smtp: unknown = details?.response;
    void phase; void transportIndex; void attempt; void smtp;
  },
  onSent(email: MailTimeTask, details?: object) {
    email;
    details;
  }
};

const mailTime = new MailTime(opts);
const resolvedFrom: string | undefined = MailTime.transportFrom(transport);
void resolvedFrom;

await mailTime.ready();

const newlyPaused: boolean = mailTime.pause();
const alreadyPaused: boolean = mailTime.pause();
void newlyPaused;
void alreadyPaused;

const pingWhilePaused: MailTimePingResult = await mailTime.ping();
const pausedFlag: boolean | undefined = pingWhilePaused.paused;
void pausedFlag;

const newlyResumed: boolean = mailTime.resume();
const isPausedAfterResume: boolean = mailTime.isPaused;
void newlyResumed;
void isPausedAfterResume;

mailTime.destroy();
void mailTime.destroy({ drain: true, schedulerTimeout: 10000 });

const message: MailTimeMailOptions = {
  to: 'user@example.com',
  subject: 'Hi',
  text: 'Text'
};
await mailTime.sendMail(message);
await mailTime.cancelMail(Promise.resolve('uuid'));
// @ts-expect-error mail options required
mailTime.sendMail();

void MongoQueue;
void RedisQueue;
void PostgresQueue;

// Internal helpers MUST NOT be part of the public surface
// @ts-expect-error ___send is internal
mailTime.___send;
// @ts-expect-error ___iterate is internal
mailTime.___iterate;
// @ts-expect-error __isDestroyed is internal
mailTime.__isDestroyed;
// @ts-expect-error __readyPromise is internal
mailTime.__readyPromise;
// @ts-expect-error __debug is internal
mailTime.__debug;

const redisQueue = new RedisQueue({
  client: {
    async exists(_key: string) {
      return 0;
    },
    async get(_key: string) {
      return null;
    },
    async set(_key: string, _value: string) {
      return 'OK';
    },
    async del(_keys: string | string[]) {
      return 0;
    },
    async ping() {
      return 'PONG';
    },
    scanIterator() {
      return (async function* () {})();
    }
  }
});
const redisClusterQueue = new RedisQueue({
  client: {
    async exists(_key: string) {
      return 0;
    },
    async get(_key: string) {
      return null;
    },
    async set(_key: string, _value: string) {
      return 'OK';
    },
    async del(_keys: string | string[]) {
      return 0;
    },
    async ping() {
      return 'PONG';
    }
  },
  useHashTags: true,
});
void redisClusterQueue;
// Real driver instances must be assignable without casts.
declare const nodeRedisClient: RedisClientType;
declare const mongoDb: MongoDb;
void new RedisQueue({ client: nodeRedisClient });
void new MongoQueue({ db: mongoDb });
declare const nodeRedisCluster: RedisClusterType;
void new RedisQueue({ client: nodeRedisCluster, useHashTags: true });
void new RedisQueueAdapter({ client: nodeRedisCluster, useHashTags: true });
// @ts-expect-error __getKey is internal
redisQueue.__getKey('uuid');

// @ts-expect-error queue required
new MailTime({});

// @ts-expect-error postgres client required
new PostgresQueue();

const presetName: MailTimePresetName = 'otp';
const otpPreset = mailTimePreset(presetName, { prefix: 'otp' });
void new MailTime({
  ...otpPreset,
  queue,
  transports: [transport],
  josk: joskOpts
});

// @ts-expect-error unknown preset name
mailTimePreset('does-not-exist');

const transactionalShape: MailTimePresetConfig = presets.transactional;
void transactionalShape;
void presetNames[0];

import type {
  MailTimeMailbox, MailTimeRecipientPolicy, MailTimePolicyRecipient, MailTimePolicyDecision,
  MailTimePolicyResult, MailTimePolicyContext, MailTimeBeforeSendPolicyContext,
  MailTimeRejectionPolicyContext, MailTimeStructuredRejection,
  MailTimeRecipientAttemptContext, MailTimeRecipientResult, MailTimeRecipientSummary,
  MailTimePolicyTransport, MailTimePolicyEnvelope,
} from 'mail-time';

const recipientPolicy: MailTimeRecipientPolicy = {
  name: 'compliance', failureMode: 'retry',
  async beforeSend(context: MailTimeBeforeSendPolicyContext): Promise<MailTimePolicyResult> {
    const recipients: MailTimePolicyRecipient[] = context.recipients;
    const shared: MailTimePolicyContext = context;
    const envelope: MailTimePolicyEnvelope = shared.envelope;
    const transport: MailTimePolicyTransport = shared.transport;
    void envelope; void transport;
    return { decisions: recipients.map(({ address }) => ({ address, status: 'suppressed', reason: 'opt-out' })) };
  },
  classifyRejections(context: MailTimeRejectionPolicyContext) {
    const records: MailTimeStructuredRejection[] = context.rejections;
    void records;
    return { decisions: context.recipients.map(({ address }) => ({ address, status: 'retry' as const, reason: 'unknown' })) };
  },
  async observeAttempt(context: MailTimeRecipientAttemptContext) {
    const results: MailTimeRecipientResult[] = context.decisions;
    void results;
  },
};
const invalidDecision: MailTimePolicyDecision = {
  address: 'a@example.com', reason: 'bad',
  // @ts-expect-error invalid policy status
  status: 'allow',
};
const policyOptions: MailTimeOptions = {
  ...opts, queue: { ...queue, supportsRecipientPolicies: true }, recipientPolicies: [recipientPolicy],
  onSent(task, info, recipients, summary) {
    const result: MailTimeRecipientSummary | undefined = summary;
    void result; void recipients; void task; void info;
  },
  onError(error, task, info, recipients, summary) {
    if (task === null) { void info; }
    void error; void recipients; void summary;
  },
  onSuppressed(task, recipients, summary) { void task; void recipients[0].reasons; void summary.isSettled; },
  async onRejected(task, recipients, summary) { void task; void recipients; void summary; },
};
const mailbox: MailTimeMailbox = { address: 'a@example.com', name: 'A' };
const policyMail: MailTimeMailOptions = { to: mailbox, cc: [mailbox], bcc: mailbox, text: 'hello' };
void policyOptions; void policyMail; void invalidDecision;
// @ts-expect-error internal policy lifecycle is not public
mailTime.___sendWithRecipientPolicies;
// @ts-expect-error invalid failure mode
const badPolicy: MailTimeRecipientPolicy = { name: 'bad', failureMode: 'ignore' };
void badPolicy;

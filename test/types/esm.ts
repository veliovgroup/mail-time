import { MailTime, MongoQueue, PostgresQueue, RedisQueue, mailTimePreset, presetNames, presets } from 'mail-time';
import type {
  CustomQueue,
  MailTimeJoSkOptions,
  MailTimeMailOptions,
  MailTimeOptions,
  MailTimePingResult,
  MailTimePresetConfig,
  MailTimePresetName,
  MailTimeTask,
  MailTimeTransport
} from 'mail-time';

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
  lockOwnerId: 'owner-1'
};

const opts: MailTimeOptions = {
  type: 'server',
  queue,
  transports: [transport],
  josk: joskOpts,
  onError(error: unknown, email: MailTimeTask, details?: object) {
    error;
    email;
    details;
  },
  onSent(email: MailTimeTask, details?: object) {
    email;
    details;
  }
};

const mailTime = new MailTime(opts);

await mailTime.ready();
mailTime.destroy();

const message: MailTimeMailOptions = {
  to: 'user@example.com',
  subject: 'Hi',
  text: 'Text'
};
await mailTime.sendMail(message);
await mailTime.cancelMail(Promise.resolve('uuid'));

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

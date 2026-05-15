import { MailTime, MongoQueue, PostgresQueue, RedisQueue } from 'mail-time';

const queue = {
  async ping() {
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

const adapter = {
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
  async ping() {
    return {
      status: 'OK',
      code: 200,
      statusCode: 200
    };
  }
};

const mailTime = new MailTime({
  type: 'server',
  queue,
  transports: [{
    sendMail(_mail: object, done: (error: Error | null, info: object) => void) {
      done(null, {});
    }
  }],
  josk: {
    adapter,
    execute: 'one',
    lockOwnerId: 'owner'
  },
  onError(error: unknown, email: object, details?: object) {
    error;
    email;
    details;
  },
  onSent(email: object, details?: object) {
    email;
    details;
  }
});

await mailTime.ready();
mailTime.destroy();
await mailTime.sendMail({
  to: 'user@example.com',
  subject: 'Subject',
  text: 'Text'
});
await mailTime.cancelMail(Promise.resolve('uuid'));

void MongoQueue;
void RedisQueue;
void PostgresQueue;

// @ts-expect-error queue required
new MailTime({});

// @ts-expect-error postgres client required
new PostgresQueue();

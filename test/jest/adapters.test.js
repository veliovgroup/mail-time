import { describe, expect, it, jest } from '@jest/globals';

import { MongoQueue, PostgresQueue, RedisQueue } from '../../index.js';
import { createPostgresClient } from './helpers.js';
import { createHash } from 'crypto';

const createMailTimeHarness = (keepHistory = false) => ({
  keepHistory,
  maxTries: 3,
  sendingTimeout: 300000,
  ___dispatch: jest.fn(),
  ___send: jest.fn()
});

const attachRedisWatchMulti = (client) => {
  client.watch = jest.fn(async () => void 0);
  client.unwatch = jest.fn(async () => void 0);
  client.multi = jest.fn(() => {
    const commands = [];
    const multi = {
      set: jest.fn((key, value) => {
        commands.push(['set', key, value]);
        return multi;
      }),
      del: jest.fn((...keys) => {
        commands.push(['del', ...keys]);
        return multi;
      }),
      exec: jest.fn(async () => {
        for (const command of commands) {
          if (command[0] === 'set') {
            client.values.set(command[1], command[2]);
          } else if (command[0] === 'del') {
            for (const key of command.slice(1)) {
              client.values.delete(key);
            }
          }
        }
        return commands.length ? ['OK'] : null;
      })
    };
    return multi;
  });
  return client;
};

const createRedisClient = () => {
  const values = new Map();
  const client = {
    values,
    exists: jest.fn(async (key) => values.has(key) ? 1 : 0),
    get: jest.fn(async (key) => values.get(key) ?? null),
    set: jest.fn(async (key, value) => {
      values.set(key, value);
      return 'OK';
    }),
    del: jest.fn(async (keys) => {
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        values.delete(key);
      }
      return 1;
    }),
    ping: jest.fn(async () => 'PONG'),
    scanIterator: jest.fn(() => (async function* () {})())
  };
  return attachRedisWatchMulti(client);
};

const createMongoCollection = (overrides = {}) => ({
  createIndex: jest.fn(async () => void 0),
  indexes: jest.fn(async () => []),
  dropIndex: jest.fn(async () => void 0),
  find: jest.fn(),
  findOne: jest.fn(async () => null),
  insertOne: jest.fn(async () => ({ insertedId: 'id' })),
  deleteOne: jest.fn(async () => ({ deletedCount: 1 })),
  updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
  ...overrides
});

const createMongoDb = (collection, command = async () => ({ ok: 1 })) => ({
  collection: jest.fn(() => collection),
  command: jest.fn(command)
});

describe('MongoQueue unit behavior', () => {
  it('validates constructor and handles index conflicts', async () => {
    expect(() => new MongoQueue()).toThrow('[mail-time] Configuration object must be passed');
    expect(() => new MongoQueue({})).toThrow('[mail-time] [MongoQueue] requires MongoDB database');

    const collection = createMongoCollection({
      createIndex: jest.fn()
        .mockRejectedValueOnce({ code: 85 })
        .mockResolvedValue(undefined),
      indexes: jest.fn(async () => [{
        name: 'old',
        key: {
          uuid: 1
        }
      }])
    });
    const queue = new MongoQueue({
      db: createMongoDb(collection),
      prefix: 'unit'
    });

    await queue.ready();

    expect(collection.dropIndex).toHaveBeenCalledWith('old');
  });

  it('reports ping states', async () => {
    const queue = new MongoQueue({
      db: createMongoDb(createMongoCollection())
    });
    await expect(queue.ping()).resolves.toMatchObject({ code: 503 });

    queue.mailTimeInstance = createMailTimeHarness();
    await expect(queue.ping()).resolves.toMatchObject({ code: 200 });

    const failing = new MongoQueue({
      db: createMongoDb(createMongoCollection(), async () => {
        throw new Error('mongo down');
      })
    });
    failing.mailTimeInstance = createMailTimeHarness();
    await expect(failing.ping()).resolves.toMatchObject({ code: 500 });
  });

  it('iterates cursor and handles collection operations', async () => {
    const tasks = [{
      _id: 'one',
      uuid: 'one'
    }, {
      _id: 'two',
      uuid: 'two'
    }];
    let index = 0;
    const cursor = {
      hasNext: jest.fn(async () => index < tasks.length),
      next: jest.fn(async () => tasks[index++]),
      close: jest.fn(async () => void 0)
    };
    const collection = createMongoCollection({
      find: jest.fn(() => cursor),
      findOne: jest.fn(async ({ uuid }) => uuid === 'missing' ? null : {
        _id: uuid,
        uuid,
        isSent: false,
        isCancelled: false
      })
    });
    const queue = new MongoQueue({
      db: createMongoDb(collection)
    });
    queue.mailTimeInstance = createMailTimeHarness(true);
    await queue.ready();

    await queue.iterate();
    expect(queue.mailTimeInstance.___dispatch).toHaveBeenCalledTimes(2);
    expect(cursor.close).toHaveBeenCalled();

    await expect(queue.getPendingTo(null, Date.now())).resolves.toBeNull();
    await queue.getPendingTo('user@example.com', Date.now());
    expect(collection.findOne).toHaveBeenCalledWith(expect.objectContaining({
      to: 'user@example.com'
    }), expect.any(Object));

    await expect(queue.push(null)).resolves.toBeUndefined();
    const task = {
      _id: 'task',
      uuid: 'task',
      sendAt: new Date(),
      isSent: false,
      isCancelled: false
    };
    await queue.push(task);
    expect(typeof task.sendAt).toBe('number');

    await expect(queue.cancel(1)).resolves.toBe(false);
    await expect(queue.cancel('missing')).resolves.toBe(false);
    await expect(queue.cancel('task')).resolves.toBe(true);
    await expect(queue.remove(null)).resolves.toBe(false);
    await expect(queue.remove(task)).resolves.toBe(true);
    await expect(queue.update(null, {})).resolves.toBe(false);
    await expect(queue.update(task, { isSent: true })).resolves.toBe(true);
  });

  it('uses atomic stale-claim guard when MongoQueue starts sending', async () => {
    const collection = createMongoCollection();
    const queue = new MongoQueue({
      db: createMongoDb(collection)
    });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    const sendingAt = Date.now();
    await expect(queue.update({
      _id: 'task',
      uuid: 'task',
      tries: 0,
      isSent: false,
      isFailed: false,
      isCancelled: false
    }, {
      isSending: true,
      sendingAt,
      tries: 1
    })).resolves.toBe(true);

    expect(collection.updateOne).toHaveBeenLastCalledWith({
      _id: 'task',
      isSent: false,
      isFailed: false,
      isCancelled: false,
      tries: 0,
      $or: [
        { isSending: { $ne: true } },
        { sendingAt: { $lte: sendingAt - 300000 } }
      ]
    }, {
      $set: {
        isSending: true,
        sendingAt,
        tries: 1
      }
    });
  });

  it('removes cancelled task when history is disabled and handles iterate errors', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const collection = createMongoCollection({
      find: jest.fn(() => {
        throw new Error('find failed');
      }),
      findOne: jest.fn(async () => ({
        _id: 'task',
        uuid: 'task',
        isSent: false,
        isCancelled: false
      }))
    });
    const queue = new MongoQueue({
      db: createMongoDb(collection)
    });
    queue.mailTimeInstance = createMailTimeHarness(false);
    await queue.ready();

    await expect(queue.iterate()).resolves.toBeUndefined();
    await expect(queue.cancel('task')).resolves.toBe(true);
    expect(collection.deleteOne).toHaveBeenCalled();
    expect(errorSpy).toHaveBeenCalled();
  });
});

describe('RedisQueue unit behavior', () => {
  it('validates constructor and reports ping states', async () => {
    expect(() => new RedisQueue()).toThrow('[mail-time] Configuration object must be passed');
    expect(() => new RedisQueue({})).toThrow('[mail-time] [RedisQueue] required {client} option is missing');

    const queue = new RedisQueue({
      client: createRedisClient()
    });
    await expect(queue.ready()).resolves.toBeUndefined();
    await expect(queue.ping()).resolves.toMatchObject({ code: 503 });

    queue.mailTimeInstance = createMailTimeHarness();
    await expect(queue.ping()).resolves.toMatchObject({ code: 200 });

    const failing = new RedisQueue({
      client: {
        ...createRedisClient(),
        ping: jest.fn(async () => {
          throw new Error('redis down');
        })
      }
    });
    failing.mailTimeInstance = createMailTimeHarness();
    await expect(failing.ping()).resolves.toMatchObject({ code: 500 });
  });

  it('pushes, finds, iterates, cancels, and removes tasks', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'flow' });
    queue.mailTimeInstance = createMailTimeHarness(false);

    await expect(queue.push(null)).resolves.toBeUndefined();
    await queue.push({
      uuid: 'task',
      to: 'user@example.com',
      sendAt: new Date(Date.now() - 1000),
      isSent: false,
      isFailed: false,
      isCancelled: false
    });

    await expect(queue.getPendingTo(null, Date.now())).resolves.toBeNull();
    await expect(queue.getPendingTo('missing@example.com', Date.now())).resolves.toBeNull();
    await expect(queue.getPendingTo('user@example.com', Date.now())).resolves.toMatchObject({
      uuid: 'task'
    });
    await expect(queue.getPendingTo('user@example.com', Date.now() - 5000)).resolves.toBeNull();

    client.scanIterator = jest.fn(() => (async function* () {
      yield [queue.__getKey('task', 'sendat')];
      yield queue.__getKey('missing', 'sendat');
    })());
    await queue.iterate();
    expect(queue.mailTimeInstance.___dispatch).toHaveBeenCalledWith(expect.objectContaining({
      uuid: 'task'
    }));

    await expect(queue.cancel(1)).resolves.toBe(false);
    await expect(queue.cancel('missing')).resolves.toBe(false);
    await expect(queue.cancel('task')).resolves.toBe(true);
    expect(client.values.has(queue.__getKey('task'))).toBe(false);
  });

  it('uses updated sendAt when retrying active task', async () => {
    const client = createRedisClient();
    const values = client.values;
    const queue = new RedisQueue({ client, prefix: 'retry' });
    queue.mailTimeInstance = createMailTimeHarness();
    const task = {
      uuid: 'redis-retry',
      sendAt: 100,
      isSent: false,
      isFailed: false,
      isCancelled: false
    };
    values.set(queue.__getKey(task.uuid), JSON.stringify(task));

    await expect(queue.update(task, {
      sendAt: 500,
      isSent: false
    })).resolves.toBe(true);

    expect(values.get(queue.__getKey(task.uuid, 'sendat'))).toBe('500');
  });

  it('rejects stale Redis send claims after another server claimed task', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'claim' });
    queue.mailTimeInstance = createMailTimeHarness();
    const task = {
      uuid: 'redis-claim',
      tries: 0,
      sendAt: Date.now(),
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0
    };
    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));
    const staleTask = { ...task };

    await expect(queue.update(task, {
      isSending: true,
      sendingAt: Date.now(),
      tries: 1
    })).resolves.toBe(true);
    await expect(queue.update(staleTask, {
      isSending: true,
      sendingAt: Date.now(),
      tries: 1
    })).resolves.toBe(false);
  });

  it('uses Redis WATCH transaction for send claims when available', async () => {
    const client = createRedisClient();
    let multi;
    client.watch = jest.fn(async () => void 0);
    client.unwatch = jest.fn(async () => void 0);
    client.multi = jest.fn(() => {
      multi = {
        commands: [],
        set: jest.fn((...args) => {
          multi.commands.push(['set', ...args]);
          return multi;
        }),
        del: jest.fn((...args) => {
          multi.commands.push(['del', ...args]);
          return multi;
        }),
        exec: jest.fn(async () => ['OK', 1])
      };
      return multi;
    });
    const queue = new RedisQueue({ client, prefix: 'watch' });
    queue.mailTimeInstance = createMailTimeHarness();
    const task = {
      uuid: 'redis-watch',
      tries: 0,
      sendAt: Date.now(),
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0
    };
    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));

    await expect(queue.update(task, {
      isSending: true,
      sendingAt: Date.now(),
      tries: 1
    })).resolves.toBe(true);

    expect(client.watch).toHaveBeenCalledWith(queue.__getKey(task.uuid));
    expect(client.multi).toHaveBeenCalledTimes(1);
    expect(multi.commands).toEqual([
      ['set', queue.__getKey(task.uuid), expect.any(String)],
      ['set', queue.__getKey(task.uuid, 'sendat'), `${task.sendAt}`]
    ]);

    client.values.set(queue.__getKey(task.uuid), JSON.stringify({
      ...task,
      isSent: true
    }));
    await expect(queue.update(task, {
      isSending: true,
      sendingAt: Date.now(),
      tries: 1
    })).resolves.toBe(false);
    expect(client.unwatch).toHaveBeenCalled();
  });

  it('redis canClaim recovers stale isSending rows past sendingTimeout but blocks fresh ones', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'stale' });
    queue.mailTimeInstance = createMailTimeHarness();
    queue.mailTimeInstance.sendingTimeout = 1000;
    const baseTask = {
      uuid: 'redis-stale',
      tries: 0,
      sendAt: Date.now(),
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: true,
      sendingAt: Date.now()
    };
    client.values.set(queue.__getKey(baseTask.uuid), JSON.stringify(baseTask));

    await expect(queue.update(baseTask, {
      isSending: true,
      sendingAt: Date.now(),
      tries: 1
    })).resolves.toBe(false);

    client.values.set(queue.__getKey(baseTask.uuid), JSON.stringify({
      ...baseTask,
      sendingAt: Date.now() - 5000
    }));
    await expect(queue.update(baseTask, {
      isSending: true,
      sendingAt: Date.now(),
      tries: 1
    })).resolves.toBe(true);
  });

  it('redis iterate skips terminal rows and tasks at retry budget', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'iter-filter' });
    queue.mailTimeInstance = createMailTimeHarness();

    const ready = {
      uuid: 'ready',
      sendAt: Date.now() - 1,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0,
      tries: 0
    };
    const sent = {
      uuid: 'sent',
      sendAt: Date.now() - 1,
      isSent: true,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0,
      tries: 1
    };
    const exhausted = {
      uuid: 'exhausted',
      sendAt: Date.now() - 1,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0,
      tries: 3
    };
    for (const task of [ready, sent, exhausted]) {
      client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));
      client.values.set(queue.__getKey(task.uuid, 'sendat'), `${task.sendAt}`);
    }

    client.scanIterator = () => (async function* () {
      yield [
        queue.__getKey(ready.uuid, 'sendat'),
        queue.__getKey(sent.uuid, 'sendat'),
        queue.__getKey(exhausted.uuid, 'sendat'),
      ];
    })();

    await queue.iterate();
    expect(queue.mailTimeInstance.___dispatch).toHaveBeenCalledTimes(1);
    expect(queue.mailTimeInstance.___dispatch).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'ready' }));
  });

  it('redis send claims require watch and multi on the client', async () => {
    const client = createRedisClient();
    delete client.watch;
    delete client.multi;
    const queue = new RedisQueue({ client, prefix: 'no-watch' });
    queue.mailTimeInstance = createMailTimeHarness();
    const task = {
      uuid: 'no-watch',
      tries: 0,
      sendAt: Date.now(),
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0
    };
    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));

    await expect(queue.update(task, {
      isSending: true,
      sendingAt: Date.now(),
      tries: 1
    })).resolves.toBe(false);
  });

  it('redis iterate honors mode "one" via opts.limit and skips fresh isSending rows', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'iter-mode' });
    queue.mailTimeInstance = createMailTimeHarness();

    const ready = {
      uuid: 'ready',
      sendAt: Date.now() - 1,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0,
      tries: 0
    };
    const locked = {
      uuid: 'locked',
      sendAt: Date.now() - 1,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: true,
      sendingAt: Date.now(),
      tries: 0
    };
    client.values.set(queue.__getKey(ready.uuid), JSON.stringify(ready));
    client.values.set(queue.__getKey(ready.uuid, 'sendat'), `${ready.sendAt}`);
    client.values.set(queue.__getKey(locked.uuid), JSON.stringify(locked));
    client.values.set(queue.__getKey(locked.uuid, 'sendat'), `${locked.sendAt}`);

    client.scanIterator = () => (async function* () {
      yield [queue.__getKey(ready.uuid, 'sendat'), queue.__getKey(locked.uuid, 'sendat')];
    })();

    await queue.iterate({ limit: 5, sendingTimeout: 60000 });
    expect(queue.mailTimeInstance.___dispatch).toHaveBeenCalledTimes(1);
    expect(queue.mailTimeInstance.___dispatch).toHaveBeenCalledWith(expect.objectContaining({ uuid: 'ready' }));
  });

  it('handles update invalid, missing, terminal, and error paths', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'update' });
    queue.mailTimeInstance = createMailTimeHarness();

    await expect(queue.update(null, {})).resolves.toBe(false);
    await expect(queue.update({ uuid: 'missing' }, {})).resolves.toBe(false);

    const task = {
      uuid: 'task',
      sendAt: 100,
      isSent: false,
      isFailed: false,
      isCancelled: false
    };
    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));
    client.values.set(queue.__getKey(task.uuid, 'sendat'), '100');
    await expect(queue.update(task, {
      isFailed: true
    })).resolves.toBe(true);
    expect(client.values.has(queue.__getKey(task.uuid, 'sendat'))).toBe(false);

    const failing = new RedisQueue({
      client: {
        ...createRedisClient(),
        exists: jest.fn(async () => {
          throw new Error('exists failed');
        })
      }
    });
    failing.mailTimeInstance = createMailTimeHarness();
    await expect(failing.update({ uuid: 'task' }, {})).resolves.toBe(false);
    await expect(failing.remove(null)).resolves.toBe(false);
    expect(() => failing.__getKey('id', 'wrong')).toThrow('unsupported key');
  });
});

describe('PostgresQueue contract', () => {
  it('requires postgres client', () => {
    expect(() => new PostgresQueue()).toThrow('[mail-time] Configuration object must be passed');
    expect(() => new PostgresQueue({})).toThrow('[mail-time] [PostgresQueue] required {client} option is missing');
  });

  it('sets up table and pings when assigned', async () => {
    const client = createPostgresClient();
    const queue = new PostgresQueue({
      client,
      prefix: 'unit'
    });
    queue.mailTimeInstance = createMailTimeHarness();

    await expect(queue.ready()).resolves.toBeUndefined();
    await expect(queue.ping()).resolves.toMatchObject({
      status: 'OK',
      code: 200,
      statusCode: 200
    });
    expect(client.queries.some(({ queryText }) => queryText.includes('CREATE TABLE IF NOT EXISTS mail_time_queue'))).toBe(true);
  });

  it('reports unavailable and failed ping states', async () => {
    const queue = new PostgresQueue({
      client: createPostgresClient()
    });
    await expect(queue.ping()).resolves.toMatchObject({ code: 503 });

    const failing = new PostgresQueue({
      client: {
        query: jest.fn(async (queryText) => {
          if (String(queryText).includes('SELECT 1 as ping')) {
            throw new Error('pg down');
          }
          return { rows: [], rowCount: 1 };
        })
      }
    });
    failing.mailTimeInstance = createMailTimeHarness();
    await expect(failing.ping()).resolves.toMatchObject({ code: 500 });
  });

  it('keeps setup failures on ready without unhandled rejection', async () => {
    const unhandled = jest.fn();
    process.once('unhandledRejection', unhandled);
    const queue = new PostgresQueue({
      client: {
        query: jest.fn(async () => {
          throw new Error('pg setup failed');
        })
      }
    });

    await new Promise((resolve) => {
      setImmediate(resolve);
    });
    process.removeListener('unhandledRejection', unhandled);

    expect(unhandled).not.toHaveBeenCalled();
    await expect(queue.ready()).rejects.toThrow('pg setup failed');
  });

  it('adds atomic stale-claim predicate when PostgresQueue starts sending', async () => {
    const client = createPostgresClient();
    const queue = new PostgresQueue({
      client,
      prefix: 'claim'
    });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    const sendingAt = Date.now();
    await expect(queue.update({
      id: 1,
      uuid: 'pg-claim',
      tries: 0,
      isSent: false,
      isFailed: false,
      isCancelled: false
    }, {
      isSending: true,
      sendingAt,
      tries: 1
    })).resolves.toBe(true);

    const updateQuery = client.queries.findLast(({ queryText }) => queryText.includes('UPDATE mail_time_queue'));
    expect(updateQuery.queryText).toContain('is_sent = false');
    expect(updateQuery.queryText).toContain('is_failed = false');
    expect(updateQuery.queryText).toContain('is_cancelled = false');
    expect(updateQuery.queryText).toMatch(/tries\s*=\s*\$\d+/);
    expect(updateQuery.queryText).toMatch(/\(is_sending = false OR sending_at <= \$\d+\)/);
    expect(updateQuery.values).toContain(0);
    expect(updateQuery.values).toContain(sendingAt - 300000);
  });

  it('pushes, updates, cancels, removes, and iterates due messages', async () => {
    const rows = new Map();
    const client = {
      async query(queryText, values) {
        const sql = String(queryText);
        if (sql.includes('SELECT 1 as ping')) {
          return { rows: [{ ping: 1 }], rowCount: 1 };
        }
        if (sql.includes('INSERT INTO mail_time_queue')) {
          rows.set(values[1], {
            id: rows.size + 1,
            prefix: values[0],
            uuid: values[1],
            to_address: values[2],
            tries: values[3],
            send_at: values[4],
            is_sent: values[5],
            is_cancelled: values[6],
            is_failed: values[7],
            is_sending: values[8],
            sending_at: values[9],
            template: values[10],
            transport: values[11],
            concat_subject: values[12],
            mail_options: values[13]
          });
          return { rows: [], rowCount: 1 };
        }
        if (sql.includes('to_address = $2')) {
          return {
            rows: [...rows.values()].filter((row) => row.to_address === values[1] && row.is_sent === false && row.is_failed === false && row.is_cancelled === false && row.send_at <= values[2]),
            rowCount: rows.size
          };
        }
        if (sql.includes('send_at <= $2')) {
          return {
            rows: [...rows.values()].filter((row) => row.is_sent === false && row.is_failed === false && row.is_cancelled === false && row.send_at <= values[1]),
            rowCount: rows.size
          };
        }
        if (sql.includes('uuid = $2')) {
          const row = rows.get(values[1]);
          return { rows: row ? [row] : [], rowCount: row ? 1 : 0 };
        }
        if (sql.includes('UPDATE mail_time_queue')) {
          const row = [...rows.values()].find((candidate) => candidate.id === values.at(-1));
          if (sql.includes('is_cancelled')) {
            row.is_cancelled = values[0];
          }
          if (sql.includes('is_sent')) {
            row.is_sent = values[0];
          }
          return { rows: [row], rowCount: row ? 1 : 0 };
        }
        if (sql.includes('DELETE FROM mail_time_queue')) {
          const row = [...rows.values()].find((candidate) => candidate.id === values[1]);
          if (row) {
            rows.delete(row.uuid);
          }
          return { rows: [], rowCount: row ? 1 : 0 };
        }
        return { rows: [], rowCount: 1 };
      }
    };
    const queue = new PostgresQueue({ client, prefix: 'flow' });
    queue.mailTimeInstance = createMailTimeHarness(true);
    await queue.ready();

    await queue.push({
      uuid: 'pg-task',
      to: 'user@example.com',
      tries: 0,
      sendAt: new Date(Date.now() - 1000),
      isSent: false,
      isCancelled: false,
      isFailed: false,
      template: false,
      transport: 0,
      concatSubject: false,
      mailOptions: [{
        to: 'user@example.com',
        text: 'hi'
      }]
    });
    const pending = await queue.getPendingTo('user@example.com', Date.now());
    expect(pending.uuid).toBe('pg-task');

    await expect(queue.cancel('pg-task')).resolves.toBe(true);
    expect(rows.get('pg-task').is_cancelled).toBe(true);

    rows.get('pg-task').is_cancelled = false;
    await queue.iterate();
    expect(queue.mailTimeInstance.___dispatch).toHaveBeenCalledWith(expect.objectContaining({
      uuid: 'pg-task',
      sendAt: expect.any(Number)
    }));

    await expect(queue.remove(rows.get('pg-task'))).resolves.toBe(true);
    expect(rows.has('pg-task')).toBe(false);
  });

  it('handles invalid postgres queue operations', async () => {
    const queue = new PostgresQueue({
      client: createPostgresClient()
    });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    await expect(queue.getPendingTo(null, Date.now())).resolves.toBeNull();
    await expect(queue.push(null)).resolves.toBeUndefined();
    await expect(queue.cancel(1)).resolves.toBe(false);
    await expect(queue.remove(null)).resolves.toBe(false);
    await expect(queue.update(null, {})).resolves.toBe(false);
    await expect(queue.update({ uuid: 'id' }, { unsupported: true })).resolves.toBe(false);
  });

  it('coerces Date sendAt and converts to ms in push', async () => {
    const client = createPostgresClient();
    const queue = new PostgresQueue({ client, prefix: 'date' });
    await queue.ready();
    const sendAt = new Date(Date.now() + 1000);
    await queue.push({
      uuid: 'pg-date',
      to: 'user@example.com',
      tries: 0,
      sendAt,
      isSent: false,
      isCancelled: false,
      isFailed: false,
      template: false,
      transport: 0,
      concatSubject: false,
      mailOptions: [{ to: 'user@example.com', text: 'hi' }]
    });
    const insert = client.queries.findLast((q) => q.queryText.includes('INSERT INTO mail_time_queue'));
    expect(insert.values[4]).toBe(+sendAt);
  });

  it('returns ping 503 when postgres ready resolves but ping reports 0 rows', async () => {
    const queue = new PostgresQueue({
      client: {
        async query(queryText) {
          if (String(queryText).includes('SELECT 1 as ping')) {
            return { rows: [], rowCount: 0 };
          }
          return { rows: [], rowCount: 1 };
        }
      }
    });
    queue.mailTimeInstance = createMailTimeHarness();
    await expect(queue.ping()).resolves.toMatchObject({ code: 503 });
  });

  it('postgres iterate returns early when mailTimeInstance is missing', async () => {
    const queue = new PostgresQueue({ client: createPostgresClient() });
    await queue.ready();
    await expect(queue.iterate()).resolves.toBeUndefined();
  });

  it('postgres update uses uuid where clause when no id is set', async () => {
    const client = createPostgresClient();
    const queue = new PostgresQueue({ client, prefix: 'uuid' });
    await queue.ready();
    await expect(queue.update({ uuid: 'pg-uuid', tries: 0, isSent: false, isFailed: false, isCancelled: false }, {
      isSent: false,
      sendAt: Date.now()
    })).resolves.toBe(true);
    const update = client.queries.findLast((q) => q.queryText.includes('UPDATE mail_time_queue'));
    expect(update.queryText).toContain('uuid = $');
  });
});

describe('Helpers, equals, and deep merge corner cases', () => {
  it('redis push uses transactional multi pipeline when available', async () => {
    const client = createRedisClient();
    const calls = [];
    client.multi = () => {
      const m = {
        set: (...args) => {
          calls.push(['set', ...args]);
          return m;
        },
        del: (...args) => {
          calls.push(['del', ...args]);
          return m;
        },
        exec: jest.fn(async () => ['OK'])
      };
      return m;
    };
    const queue = new RedisQueue({ client, prefix: 'multi' });
    await queue.push({
      uuid: 'multi-task',
      to: 'user@example.com',
      sendAt: Date.now() + 1000,
      tries: 0,
      isSent: false,
      isCancelled: false,
      isFailed: false
    });
    expect(calls.some(([cmd]) => cmd === 'set')).toBe(true);
  });

  it('redis iterate skips keys with no value and ignores keys outside prefix', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'iter' });
    queue.mailTimeInstance = createMailTimeHarness();
    client.scanIterator = () => (async function* () {
      yield [queue.__getKey('a', 'sendat')];
      yield 'mailtime:other-prefix:sendat:b';
    })();
    client.get = jest.fn(async (key) => {
      if (key === queue.__getKey('a', 'sendat')) {
        return null;
      }
      return null;
    });
    await expect(queue.iterate()).resolves.toBeUndefined();
  });

  it('redis getPendingTo returns null when stored task is missing', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'pending' });
    client.values.set(queue.__getKey('user@example.com', 'concatletter'), 'missing-uuid');
    await expect(queue.getPendingTo('user@example.com', Date.now())).resolves.toBeNull();
  });

  it('redis remove deletes concat key when task carries `to`', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'rm' });
    queue.mailTimeInstance = createMailTimeHarness();
    const task = {
      uuid: 'rm-task',
      to: 'user@example.com',
      sendAt: Date.now(),
      isSent: false,
      isFailed: false,
      isCancelled: false
    };
    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));
    client.values.set(queue.__getKey(task.uuid, 'sendat'), '0');
    client.values.set(queue.__getKey(task.to, 'concatletter'), task.uuid);

    await expect(queue.remove(task)).resolves.toBe(true);
    expect(client.values.has(queue.__getKey(task.to, 'concatletter'))).toBe(false);
  });

  it('mongo ensureIndex drops old index and recreates when codes 85', async () => {
    const collection = createMongoCollection({
      createIndex: jest.fn()
        .mockRejectedValueOnce({ code: 85 })
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined)
        .mockResolvedValueOnce(undefined),
      indexes: jest.fn(async () => [{
        name: 'old',
        key: {
          uuid: 1
        }
      }])
    });
    const queue = new MongoQueue({
      db: createMongoDb(collection),
      prefix: 'index-mismatch'
    });
    await queue.ready();
    expect(collection.dropIndex).toHaveBeenCalledWith('old');
  });

  it('mongo ensureIndex logs other errors without throwing', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    const collection = createMongoCollection({
      createIndex: jest.fn().mockRejectedValue(new Error('other failure'))
    });
    const queue = new MongoQueue({
      db: createMongoDb(collection),
      prefix: 'log-only'
    });
    await expect(queue.ready()).resolves.toBeUndefined();
    expect(errorSpy).toHaveBeenCalled();
    expect(errorSpy.mock.calls.some((args) => typeof args[2] === 'string' && args[2].includes('[ensureIndex]'))).toBe(true);
  });

  it('queue adapters inherit prefix from mailTimeInstance lazily on first use', async () => {
    const redis = new RedisQueue({ client: createRedisClient() });
    expect(redis.prefix).toBeUndefined();
    redis.mailTimeInstance = { prefix: 'inherited', debug: false };
    await redis.ready();
    expect(redis.prefix).toBe('inherited');
    expect(redis.uniqueName).toBe('mailtime:inherited');

    const mongo = new MongoQueue({ db: createMongoDb(createMongoCollection()) });
    expect(mongo.prefix).toBeUndefined();
    mongo.mailTimeInstance = { prefix: 'biz', debug: false };
    await mongo.ready();
    expect(mongo.prefix).toBe('biz');
    expect(mongo.collection).toBeDefined();

    const pg = new PostgresQueue({ client: createPostgresClient() });
    expect(pg.prefix).toBeUndefined();
    pg.mailTimeInstance = { prefix: 'pg-inh', debug: false };
    await pg.ready();
    expect(pg.prefix).toBe('pg-inh');
  });

  it('queue adapter config supersedes mailTimeInstance.prefix', async () => {
    const redis = new RedisQueue({ client: createRedisClient(), prefix: 'explicit-r' });
    redis.mailTimeInstance = { prefix: 'parent', debug: false };
    await redis.ready();
    expect(redis.prefix).toBe('explicit-r');

    const mongo = new MongoQueue({ db: createMongoDb(createMongoCollection()), prefix: 'explicit-m' });
    mongo.mailTimeInstance = { prefix: 'parent', debug: false };
    await mongo.ready();
    expect(mongo.prefix).toBe('explicit-m');

    const pg = new PostgresQueue({ client: createPostgresClient(), prefix: 'explicit-p' });
    pg.mailTimeInstance = { prefix: 'parent', debug: false };
    await pg.ready();
    expect(pg.prefix).toBe('explicit-p');
  });

  it('queue adapters fall back to a default prefix when nothing is provided', async () => {
    const redis = new RedisQueue({ client: createRedisClient() });
    await redis.ready();
    expect(redis.prefix).toBe('default');

    const mongo = new MongoQueue({ db: createMongoDb(createMongoCollection()) });
    await mongo.ready();
    expect(mongo.prefix).toBe('');

    const pg = new PostgresQueue({ client: createPostgresClient() });
    await pg.ready();
    expect(pg.prefix).toBe('default');
  });

  it('mongo cancel returns false when task is already cancelled', async () => {
    const collection = createMongoCollection({
      findOne: jest.fn(async () => ({
        _id: 'cancelled',
        uuid: 'cancelled',
        isSent: false,
        isCancelled: true
      }))
    });
    const queue = new MongoQueue({ db: createMongoDb(collection), prefix: 'already' });
    queue.mailTimeInstance = createMailTimeHarness(true);
    await queue.ready();
    await expect(queue.cancel('cancelled')).resolves.toBe(false);
  });

  it('mongo update appendMailOption atomically extends mailOptions', async () => {
    const collection = createMongoCollection({
      updateOne: jest.fn(async () => ({ modifiedCount: 1 })),
    });
    const queue = new MongoQueue({ db: createMongoDb(collection), prefix: 'append' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    await expect(queue.update({ _id: 'id-a', uuid: 'append-1' }, {
      appendMailOption: { to: 'user@example.com', text: 'x' },
    })).resolves.toBe(true);

    expect(collection.updateOne).toHaveBeenCalledWith({
      _id: 'id-a',
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: { $ne: true },
    }, {
      $push: { mailOptions: { to: 'user@example.com', text: 'x' } },
    });
  });

  it('mongo getPendingTo excludes in-flight rows', async () => {
    const collection = createMongoCollection({
      findOne: jest.fn(async () => null),
    });
    const queue = new MongoQueue({ db: createMongoDb(collection), prefix: 'pending-m' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.getPendingTo('user@example.com', Date.now());
    expect(collection.findOne.mock.calls[0][0].isSending).toEqual({ $ne: true });
    expect(collection.findOne.mock.calls[0][0].tries).toEqual({ $lt: 3 });
  });

  it('mongo update honors lease release guard after claim', async () => {
    const collection = createMongoCollection({
      updateOne: jest.fn(async () => ({ modifiedCount: 1, matchedCount: 1 })),
    });
    const queue = new MongoQueue({ db: createMongoDb(collection), prefix: 'lease' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    const task = { _id: 'id-1', uuid: 'lease-1', tries: 1, isSending: true, sendingAt: 12345 };
    await expect(queue.update(task, {
      isSending: false,
      sendingAt: 0,
      leaseTries: 1,
      leaseSendingAt: 12345,
    })).resolves.toBe(true);

    const updateCall = collection.updateOne.mock.calls.at(-1);
    expect(updateCall[0]).toMatchObject({
      _id: 'id-1',
      tries: 1,
      isSending: true,
      sendingAt: 12345,
      isCancelled: false,
      isFailed: false,
    });
  });

  it('mongo lease release predicate rejects cancelled and failed rows', async () => {
    const collection = createMongoCollection({
      updateOne: jest.fn(async () => ({ modifiedCount: 1, matchedCount: 1 })),
      deleteOne: jest.fn(async () => ({ deletedCount: 1 })),
    });
    const queue = new MongoQueue({ db: createMongoDb(collection), prefix: 'lease-cancel' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    await queue.update({ _id: 'id-c', uuid: 'cancel-1', tries: 1, isSending: true, sendingAt: 99 }, {
      isSent: true,
      isSending: false,
      sendingAt: 0,
      leaseTries: 1,
      leaseSendingAt: 99,
    });
    expect(collection.updateOne.mock.calls.at(-1)[0]).toMatchObject({
      isCancelled: false,
      isFailed: false,
    });

    await queue.remove({ _id: 'id-c', uuid: 'cancel-1' }, { leaseTries: 1, leaseSendingAt: 99 });
    expect(collection.deleteOne.mock.calls.at(-1)[0]).toMatchObject({
      tries: 1,
      isSending: true,
      sendingAt: 99,
      isCancelled: false,
      isFailed: false,
    });
  });

  it('mongo claim accepts matchedCount when modifiedCount is zero', async () => {
    const collection = createMongoCollection({
      updateOne: jest.fn(async () => ({ modifiedCount: 0, matchedCount: 1 })),
    });
    const queue = new MongoQueue({ db: createMongoDb(collection), prefix: 'matched' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    await expect(queue.update({
      _id: 'id-2',
      uuid: 'matched-1',
      tries: 0,
      isSent: false,
      isFailed: false,
      isCancelled: false,
    }, {
      isSending: true,
      sendingAt: Date.now(),
      tries: 1,
    })).resolves.toBe(true);
  });

  it('redis update honors lease release guard and appendMailOption', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'lease-r' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    const task = {
      uuid: 'lease-redis',
      tries: 1,
      sendAt: Date.now(),
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: true,
      sendingAt: 999,
      mailOptions: [{ to: 'a@example.com' }],
    };
    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));
    client.values.set(queue.__getKey(task.uuid, 'sendat'), `${task.sendAt}`);

    await expect(queue.update(task, {
      isSending: false,
      sendingAt: 0,
      leaseTries: 1,
      leaseSendingAt: 999,
    })).resolves.toBe(true);

    const stored = JSON.parse(client.values.get(queue.__getKey(task.uuid)));
    expect(stored.isSending).toBe(false);

    client.values.set(queue.__getKey(task.uuid), JSON.stringify({
      ...task,
      isSending: false,
      mailOptions: [{ to: 'a@example.com' }],
    }));
    await expect(queue.update(task, {
      appendMailOption: { to: 'a@example.com', text: 'more' },
    })).resolves.toBe(true);
    const appended = JSON.parse(client.values.get(queue.__getKey(task.uuid)));
    expect(appended.mailOptions).toHaveLength(2);

    client.values.set(queue.__getKey(task.uuid), JSON.stringify({
      ...task,
      isSending: true,
      sendingAt: 888,
    }));
    await expect(queue.update(task, {
      isSending: false,
      leaseTries: 1,
      leaseSendingAt: 999,
    })).resolves.toBe(false);
  });

  it('redis remove honors lease guard', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'lease-remove' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    const task = {
      uuid: 'remove-lease',
      to: 'user@example.com',
      tries: 1,
      sendAt: Date.now(),
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: true,
      sendingAt: 555,
    };
    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));
    client.values.set(queue.__getKey(task.uuid, 'sendat'), `${task.sendAt}`);
    client.values.set(queue.__getKey(task.to, 'concatletter'), task.uuid);

    await expect(queue.remove(task, { leaseTries: 1, leaseSendingAt: 555 })).resolves.toBe(true);
    expect(client.values.has(queue.__getKey(task.uuid))).toBe(false);

    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));
    await expect(queue.remove(task, { leaseTries: 2, leaseSendingAt: 555 })).resolves.toBe(false);

    client.values.set(queue.__getKey(task.uuid), JSON.stringify({ ...task, isCancelled: true }));
    await expect(queue.remove(task, { leaseTries: 1, leaseSendingAt: 555 })).resolves.toBe(false);

    client.values.set(queue.__getKey(task.uuid), JSON.stringify({ ...task, isFailed: true }));
    await expect(queue.remove(task, { leaseTries: 1, leaseSendingAt: 555 })).resolves.toBe(false);
  });

  it('redis lease release rejects cancelled or failed rows', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'lease-cancel-r' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    const task = {
      uuid: 'lease-cancel-redis',
      tries: 1,
      sendAt: Date.now(),
      isSent: false,
      isFailed: false,
      isCancelled: true,
      isSending: true,
      sendingAt: 1234,
      mailOptions: [{ to: 'a@example.com' }],
    };
    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));
    client.values.set(queue.__getKey(task.uuid, 'sendat'), `${task.sendAt}`);

    await expect(queue.update(task, {
      isSent: true,
      isSending: false,
      sendingAt: 0,
      leaseTries: 1,
      leaseSendingAt: 1234,
    })).resolves.toBe(false);

    client.values.set(queue.__getKey(task.uuid), JSON.stringify({ ...task, isCancelled: false, isFailed: true }));
    await expect(queue.update(task, {
      isSent: true,
      isSending: false,
      sendingAt: 0,
      leaseTries: 1,
      leaseSendingAt: 1234,
    })).resolves.toBe(false);
  });

  it('redis getPendingTo skips in-flight concat rows', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'pending' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    const task = {
      uuid: 'pending-sending',
      to: 'user@example.com',
      sendAt: Date.now() + 1000,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: true,
      sendingAt: Date.now(),
      mailOptions: [],
    };
    client.values.set(queue.__getKey(task.to, 'concatletter'), task.uuid);
    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));

    await expect(queue.getPendingTo('user@example.com', Date.now() + 2000)).resolves.toBeNull();
  });

  it('redis getPendingTo skips rows that exhausted retries', async () => {
    const client = createRedisClient();
    const queue = new RedisQueue({ client, prefix: 'pending-exhausted' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    const task = {
      uuid: 'pending-exhausted',
      to: 'user@example.com',
      sendAt: Date.now(),
      tries: 3,
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      mailOptions: [],
    };
    client.values.set(queue.__getKey(task.to, 'concatletter'), task.uuid);
    client.values.set(queue.__getKey(task.uuid, 'letter'), JSON.stringify(task));

    await expect(queue.getPendingTo('user@example.com', Date.now() + 1000)).resolves.toBeNull();
  });

  it('redis append without watch falls back to guarded read-modify-write', async () => {
    const client = createRedisClient();
    delete client.watch;
    delete client.multi;
    const queue = new RedisQueue({ client, prefix: 'append-fallback' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    const task = {
      uuid: 'append-fb',
      tries: 0,
      sendAt: Date.now(),
      isSent: false,
      isFailed: false,
      isCancelled: false,
      isSending: false,
      sendingAt: 0,
      mailOptions: [{ to: 'a@example.com' }],
    };
    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));

    await expect(queue.update(task, {
      appendMailOption: { to: 'a@example.com', text: 'more' },
    })).resolves.toBe(true);

    const stored = JSON.parse(client.values.get(queue.__getKey(task.uuid)));
    expect(stored.mailOptions).toHaveLength(2);
  });

  it('postgres update includes lease release WHERE clause', async () => {
    const client = createPostgresClient();
    const queue = new PostgresQueue({ client, prefix: 'pg-lease' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    await queue.update({
      id: 1,
      uuid: 'pg-lease-1',
      tries: 1,
      isSending: true,
      sendingAt: 777,
    }, {
      isSent: true,
      isSending: false,
      sendingAt: 0,
      leaseTries: 1,
      leaseSendingAt: 777,
    });

    const updateQuery = client.queries.findLast(({ queryText }) => queryText.includes('UPDATE mail_time_queue'));
    expect(updateQuery.queryText).toContain('is_sending = true');
    expect(updateQuery.queryText).toContain('sending_at = $');
    expect(updateQuery.queryText).toContain('is_cancelled = false');
    expect(updateQuery.queryText).toContain('is_failed = false');
    expect(updateQuery.values).toContain(1);
    expect(updateQuery.values).toContain(777);
  });

  it('postgres lease remove WHERE clause guards cancelled and failed', async () => {
    const client = createPostgresClient();
    const queue = new PostgresQueue({ client, prefix: 'pg-lease-remove' });
    queue.mailTimeInstance = createMailTimeHarness();
    await queue.ready();

    await queue.remove({ id: 7, uuid: 'pg-lease-rm' }, { leaseTries: 2, leaseSendingAt: 555 });
    const removeQuery = client.queries.findLast(({ queryText }) => queryText.includes('DELETE FROM mail_time_queue'));
    expect(removeQuery.queryText).toContain('is_sending = true');
    expect(removeQuery.queryText).toContain('sending_at = $4');
    expect(removeQuery.queryText).toContain('is_cancelled = false');
    expect(removeQuery.queryText).toContain('is_failed = false');
  });
});

describe('PostgresQueue advisory lock', () => {
  const expectedKeyFor = (prefix) => createHash('sha256').update(prefix).digest().readInt32BE(0);

  it('__setup takes a two-key, per-prefix advisory lock (and releases it)', async () => {
    const client = createPostgresClient();
    const queue = new PostgresQueue({ client, prefix: 'otp' });
    await queue.ready();

    const lockCall = client.queries.find((q) => q.queryText.includes('pg_advisory_lock'));
    const unlockCall = client.queries.find((q) => q.queryText.includes('pg_advisory_unlock'));

    expect(lockCall).toBeDefined();
    expect(lockCall.queryText).toContain('pg_advisory_lock($1, $2)');
    expect(lockCall.values[0]).toBe(0x4D61696C);
    expect(lockCall.values[1]).toBe(expectedKeyFor('otp'));

    expect(unlockCall).toBeDefined();
    expect(unlockCall.queryText).toContain('pg_advisory_unlock($1, $2)');
    expect(unlockCall.values).toEqual([0x4D61696C, expectedKeyFor('otp')]);
  });

  it('distinct prefixes hash to distinct advisory-lock keys', async () => {
    const a = createPostgresClient();
    const b = createPostgresClient();
    const qa = new PostgresQueue({ client: a, prefix: 'otp' });
    const qb = new PostgresQueue({ client: b, prefix: 'marketing' });
    await Promise.all([qa.ready(), qb.ready()]);

    const keyA = a.queries.find((q) => q.queryText.includes('pg_advisory_lock')).values[1];
    const keyB = b.queries.find((q) => q.queryText.includes('pg_advisory_lock')).values[1];
    expect(keyA).not.toBe(keyB);
  });
});

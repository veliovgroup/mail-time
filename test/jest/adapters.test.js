import { describe, expect, it, jest } from '@jest/globals';

import { MongoQueue, PostgresQueue, RedisQueue } from '../../index.js';
import { createPostgresClient } from './helpers.js';

const createMailTimeHarness = (keepHistory = false) => ({
  keepHistory,
  maxTries: 3,
  ___send: jest.fn()
});

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
  return client;
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
    expect(queue.mailTimeInstance.___send).toHaveBeenCalledTimes(2);
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
    await queue.ready();

    await expect(queue.update({
      _id: 'task',
      uuid: 'task',
      tries: 0,
      isSent: false,
      isFailed: false,
      isCancelled: false
    }, {
      isSent: true,
      tries: 1
    })).resolves.toBe(true);

    expect(collection.updateOne).toHaveBeenLastCalledWith({
      _id: 'task',
      isSent: false,
      isFailed: false,
      isCancelled: false,
      tries: 0
    }, {
      $set: {
        isSent: true,
        tries: 1
      }
    });
  });

  it('removes cancelled task when history is disabled and handles iterate errors', async () => {
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
    expect(queue.mailTimeInstance.___send).toHaveBeenCalledWith(expect.objectContaining({
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
    const task = {
      uuid: 'redis-claim',
      tries: 0,
      sendAt: Date.now(),
      isSent: false,
      isFailed: false,
      isCancelled: false
    };
    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));
    const staleTask = { ...task };

    await expect(queue.update(task, {
      isSent: true,
      tries: 1
    })).resolves.toBe(true);
    await expect(queue.update(staleTask, {
      isSent: true,
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
    const task = {
      uuid: 'redis-watch',
      tries: 0,
      sendAt: Date.now(),
      isSent: false,
      isFailed: false,
      isCancelled: false
    };
    client.values.set(queue.__getKey(task.uuid), JSON.stringify(task));

    await expect(queue.update(task, {
      isSent: true,
      tries: 1
    })).resolves.toBe(true);

    expect(client.watch).toHaveBeenCalledWith(queue.__getKey(task.uuid));
    expect(client.multi).toHaveBeenCalledTimes(1);
    expect(multi.commands).toEqual([
      ['set', queue.__getKey(task.uuid), expect.any(String)],
      ['del', queue.__getKey(task.uuid, 'sendat')]
    ]);

    client.values.set(queue.__getKey(task.uuid), JSON.stringify({
      ...task,
      isSent: true
    }));
    await expect(queue.update(task, {
      isSent: true,
      tries: 1
    })).resolves.toBe(false);
    expect(client.unwatch).toHaveBeenCalled();
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
    await queue.ready();

    await expect(queue.update({
      id: 1,
      uuid: 'pg-claim',
      tries: 0,
      isSent: false,
      isFailed: false,
      isCancelled: false
    }, {
      isSent: true,
      tries: 1
    })).resolves.toBe(true);

    const updateQuery = client.queries.findLast(({ queryText }) => queryText.includes('UPDATE mail_time_queue'));
    expect(updateQuery.queryText).toContain('is_sent = false');
    expect(updateQuery.queryText).toContain('is_failed = false');
    expect(updateQuery.queryText).toContain('is_cancelled = false');
    expect(updateQuery.queryText).toMatch(/tries\s*=\s*\$\d+/);
    expect(updateQuery.values).toContain(0);
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
            template: values[8],
            transport: values[9],
            concat_subject: values[10],
            mail_options: values[11]
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
    expect(queue.mailTimeInstance.___send).toHaveBeenCalledWith(expect.objectContaining({
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
});

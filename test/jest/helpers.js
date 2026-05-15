export const createQueue = () => {
  const records = new Map();
  const queue = {
    mailTimeInstance: null,
    records,
    async ready() {},
    async ping() {
      return {
        status: 'OK',
        code: 200,
        statusCode: 200
      };
    },
    async iterate() {
      for (const task of records.values()) {
        if (task.isSent === false && task.isFailed === false && task.isCancelled === false && task.sendAt <= Date.now()) {
          await queue.mailTimeInstance.___send(task);
        }
      }
    },
    async getPendingTo(to, sendAt) {
      for (const task of records.values()) {
        if (task.to === to && task.isSent === false && task.isFailed === false && task.isCancelled === false && task.sendAt <= sendAt) {
          return task;
        }
      }
      return null;
    },
    async push(task) {
      records.set(task.uuid, { ...task });
    },
    async cancel(uuid) {
      const task = records.get(uuid);
      if (!task || task.isSent === true || task.isCancelled === true) {
        return false;
      }
      if (!queue.mailTimeInstance.keepHistory) {
        records.delete(uuid);
        return true;
      }
      task.isCancelled = true;
      return true;
    },
    async remove(task) {
      return records.delete(task.uuid);
    },
    async update(task, updateObj) {
      const current = records.get(task.uuid);
      if (!current) {
        return false;
      }
      Object.assign(current, updateObj);
      Object.assign(task, updateObj);
      return true;
    }
  };
  return queue;
};

export const createSchedulerAdapter = () => ({
  async ready() {},
  async acquireLock() {
    return false;
  },
  async releaseLock() {},
  async remove() {
    return true;
  },
  async add() {
    return true;
  },
  async update() {
    return true;
  },
  async iterate() {
    return 0;
  },
  async ping() {
    return {
      status: 'OK',
      code: 200,
      statusCode: 200
    };
  }
});

export const createTransport = (handler = (mail, done) => done(null, {
  accepted: [mail.to],
  response: 'OK'
})) => ({
  options: {
    from: 'no-reply@example.com',
    mailOptions: {
      headers: {
        'x-transport': 'yes'
      }
    }
  },
  sendMail: handler
});

export const createPostgresClient = () => {
  const queries = [];
  return {
    queries,
    async query(queryText, values) {
      queries.push({ queryText: String(queryText), values });
      if (String(queryText).includes('SELECT 1 as ping')) {
        return {
          rows: [{ ping: 1 }],
          rowCount: 1
        };
      }
      return {
        rows: [],
        rowCount: 1
      };
    }
  };
};

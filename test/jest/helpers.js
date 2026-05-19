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
    async iterate(opts) {
      const now = Date.now();
      const sendingTimeout = (opts && typeof opts.sendingTimeout === 'number' && opts.sendingTimeout > 0)
        ? opts.sendingTimeout
        : 300000;
      const limit = (opts && typeof opts.limit === 'number' && Number.isFinite(opts.limit) && opts.limit > 0)
        ? Math.floor(opts.limit)
        : 0;
      let dispatched = 0;
      for (const task of records.values()) {
        if (task.isSent === true || task.isFailed === true || task.isCancelled === true) {
          continue;
        }
        if (task.sendAt > now) {
          continue;
        }
        if (task.isSending === true && (typeof task.sendingAt === 'number' ? task.sendingAt : 0) > now - sendingTimeout) {
          continue;
        }
        await queue.mailTimeInstance.___dispatch(task);
        dispatched++;
        if (limit > 0 && dispatched >= limit) {
          break;
        }
      }
    },
    async getPendingTo(to, sendAt) {
      for (const task of records.values()) {
        if (task.to === to && task.isSent === false && task.isFailed === false && task.isCancelled === false && task.isSending !== true && task.sendAt <= sendAt) {
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
    async remove(task, opts) {
      const current = records.get(task.uuid);
      if (!current) {
        return false;
      }
      if (opts && typeof opts.leaseTries === 'number' && typeof opts.leaseSendingAt === 'number') {
        if (current.tries !== opts.leaseTries
          || current.isSending !== true
          || current.sendingAt !== opts.leaseSendingAt
          || current.isCancelled === true
          || current.isFailed === true) {
          return false;
        }
      }
      return records.delete(task.uuid);
    },
    async update(task, updateObj) {
      const current = records.get(task.uuid);
      if (!current) {
        return false;
      }
      if (updateObj.appendMailOption !== void 0) {
        if (current.isSending === true || current.isSent === true || current.isFailed === true || current.isCancelled === true) {
          return false;
        }
        current.mailOptions = [...(current.mailOptions || []), updateObj.appendMailOption];
        Object.assign(task, { mailOptions: current.mailOptions });
        return true;
      }
      if (updateObj.isSending === true && typeof updateObj.tries === 'number') {
        const now = typeof updateObj.sendingAt === 'number' ? updateObj.sendingAt : Date.now();
        const sendingTimeout = queue.mailTimeInstance?.sendingTimeout || 300000;
        if (current.isSent === true || current.isFailed === true || current.isCancelled === true || current.tries !== task.tries) {
          return false;
        }
        if (current.isSending === true && (typeof current.sendingAt === 'number' ? current.sendingAt : 0) > now - sendingTimeout) {
          return false;
        }
      } else if (typeof updateObj.leaseTries === 'number' && typeof updateObj.leaseSendingAt === 'number') {
        if (current.tries !== updateObj.leaseTries
          || current.isSending !== true
          || current.sendingAt !== updateObj.leaseSendingAt
          || current.isCancelled === true
          || current.isFailed === true) {
          return false;
        }
      }
      const persistObj = { ...updateObj };
      delete persistObj.leaseTries;
      delete persistObj.leaseSendingAt;
      delete persistObj.appendMailOption;
      Object.assign(current, persistObj);
      Object.assign(task, persistObj);
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

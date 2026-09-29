class RecipientPolicyLease {
  constructor({ task, queue, interval, maxRenewals, shouldAbort, report }) {
    this.__task = task;
    this.__queue = queue;
    this.__shouldAbort = shouldAbort;
    this.__report = report;
    this.__closed = false;
    this.__finishing = false;
    this.__tail = Promise.resolve();
    this.__timer = null;
    let pending = false;
    let renewals = 0;
    if (interval && maxRenewals) {
      this.__timer = setInterval(() => {
        if (!this.active || this.__finishing || renewals >= maxRenewals) {
          this.__clearTimer();
          return;
        }
        if (pending) return;
        pending = true;
        renewals++;
        this.__enqueue(async (guard) => {
          const fields = { isSending: true, sendingAt: Math.max(Date.now(), this.__task.sendingAt + 1) };
          return await this.__write(fields, guard);
        }).finally(() => { pending = false; });
      }, interval);
      this.__timer.unref?.();
    }
  }

  get active() { return !this.__closed && !this.__shouldAbort(); }

  __clearTimer() {
    if (this.__timer) clearInterval(this.__timer);
    this.__timer = null;
  }

  __halt() {
    this.__clearTimer();
    this.__closed = true;
  }

  __enqueue(operation, phase = 'renew') {
    const pending = this.__tail.then(async () => {
      if (!this.active) return false;
      const guard = { leaseTries: this.__task.tries, leaseSendingAt: this.__task.sendingAt };
      try {
        const ok = await operation(guard);
        if (!ok) this.__halt();
        return ok;
      } catch (error) {
        // A thrown renewal write only stops further renewals. The lease stays open so
        // finish() still records the outcome; storage-side CAS protects row ownership.
        if (phase === 'renew') this.__clearTimer();
        else this.__halt();
        this.__report(error, phase);
        return false;
      }
    });
    this.__tail = pending.then(() => void 0);
    return pending;
  }

  async __write(fields, guard) {
    const ok = await this.__queue.update(this.__task, { ...fields, ...guard });
    if (ok) Object.assign(this.__task, fields);
    return ok;
  }

  update(fields) {
    if (this.__finishing) return Promise.resolve(false);
    return this.__enqueue((guard) => this.__write(fields, guard), 'checkpoint');
  }

  finish(fields, remove) {
    if (this.__finishing) return Promise.resolve(false);
    this.__finishing = true;
    this.__clearTimer();
    return this.__enqueue(async (guard) => {
      const ok = remove ? await this.__queue.remove(this.__task, guard) : await this.__queue.update(this.__task, { ...fields, ...guard });
      if (ok) Object.assign(this.__task, fields);
      this.__halt();
      return ok;
    }, 'complete');
  }

  async stop() {
    this.__halt();
    await this.__tail;
  }
}

export { RecipientPolicyLease };

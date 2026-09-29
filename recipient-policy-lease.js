class RecipientPolicyLease {
  constructor({ task, queue, interval, maxRenewals, sendingTimeout, shouldAbort, report }) {
    if (typeof sendingTimeout !== 'number' || !(sendingTimeout > 0)) throw new TypeError('RecipientPolicyLease requires a positive sendingTimeout');
    this.__sendingTimeout = sendingTimeout;
    this.__renewStale = false;
    this.__liveAtAttempt = false;
    this.__task = task;
    this.__queue = queue;
    this.__shouldAbort = shouldAbort;
    this.__report = report;
    this.__closed = false;
    this.__finishing = false;
    this.__tail = Promise.resolve();
    this.__renewUncertain = false;
    this.__attemptedAt = 0;
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
          this.__attemptedAt = fields.sendingAt;
          this.__liveAtAttempt = this.__task.sendingAt > fields.sendingAt - this.__sendingTimeout;
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
        let ok = await operation(guard);
        if (!ok) {
          // A renewal write that threw may have been applied by storage, which leaves the
          // guard stale. Retry once with the attempted stamp: a peer takeover bumps tries or
          // stamps a later sendingAt while the lease is live, so the retry cannot match a
          // taken-over row. Report if it still fails.
          if (this.__renewStale && phase !== 'renew') {
            // The claim was already stale when the renewal threw: no retry, report the loss.
            this.__renewStale = false;
            this.__report(new Error('outcome write lost (renewal outcome uncertain or lease taken over)'), phase);
          } else if (this.__renewUncertain && phase !== 'renew') {
            this.__renewUncertain = false;
            if (this.__shouldAbort()) {
              this.__report(new Error('outcome write lost (renewal outcome uncertain or lease taken over)'), phase);
              this.__halt();
              return false;
            }
            ok = await operation({ ...guard, leaseSendingAt: this.__attemptedAt });
            if (ok && phase === 'checkpoint') this.__task.sendingAt = this.__attemptedAt;
            if (!ok) this.__report(new Error('outcome write lost (renewal outcome uncertain or lease taken over)'), phase);
          }
          if (!ok) this.__halt();
        }
        return ok;
      } catch (error) {
        // A thrown renewal write only stops further renewals. The lease stays open so
        // finish() still records the outcome; storage-side CAS protects row ownership.
        if (phase === 'renew') { this.__clearTimer(); this.__renewUncertain = this.__liveAtAttempt; this.__renewStale = !this.__liveAtAttempt; }
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

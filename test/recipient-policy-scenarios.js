const schedulerAdapter = () => ({
  async ready() {}, async acquireLock() { return false; }, async releaseLock() {},
  async remove() { return true; }, async add() { return true; }, async update() { return true; },
  async iterate() { return 0; }, async ping() { return { status: 'OK', code: 200, statusCode: 200 }; },
});

export const createPolicyQueueLike = (queue, prefix) => new queue.constructor({
  client: queue.client, db: queue.db, prefix, useHashTags: queue.useHashTags,
});

export const readPolicyTask = async (queue, uuid) => {
  if (queue.name === 'mongo-queue') return await queue.collection.findOne({ uuid });
  if (queue.name === 'postgres-queue') {
    const row = (await queue.client.query('SELECT * FROM mail_time_queue WHERE prefix = $1 AND uuid = $2', [queue.prefix, uuid])).rows[0];
    return row ? { ...row, tries: row.tries, isSettled: row.is_settled, isSent: row.is_sent, isFailed: row.is_failed, isCancelled: row.is_cancelled, isSending: row.is_sending, sendingAt: Number(row.sending_at), recipientResults: row.recipient_results, mailOptions: row.mail_options } : null;
  }
  const raw = queue.useHashTags ? await queue.client.hGet(queue.lettersKey, uuid) : await queue.client.get(queue.__getKey(uuid));
  return raw ? JSON.parse(raw) : null;
};

export const clearPolicyQueue = async (queue) => {
  if (queue.name === 'mongo-queue') return await queue.collection.deleteMany({});
  if (queue.name === 'postgres-queue') return await queue.client.query('DELETE FROM mail_time_queue WHERE prefix = $1', [queue.prefix]);
  if (queue.useHashTags) return await queue.client.del([queue.lettersKey, queue.scheduleKey, queue.concatKeysKey]);
  for await (const batch of queue.client.scanIterator({ MATCH: `mailtime:${queue.prefix}:*`, COUNT: 100 })) {
    const keys = Array.isArray(batch) ? batch : [batch];
    if (keys.length) await queue.client.del(keys);
  }
};

export const runRecipientPolicyScenario = async ({ MailTime, queue, assert, keepHistory = true }) => {
  const envelopes = [];
  const groups = [];
  const instances = [];
  let smtp = 0;
  const config = {
    prefix: queue.prefix, keepHistory, retries: 1, retryDelay: 0, verifyTransports: false,
    from: 'sender@example.com', josk: { adapter: schedulerAdapter(), minRevolvingDelay: 60000, maxRevolvingDelay: 60000 },
    recipientPolicies: [{ name: 'policy', beforeSend({ recipients }) {
      return { decisions: recipients.filter((r) => r.address === 'd@example.com').map(({ address }) => ({ address, status: 'suppressed', reason: 'opt-out' })) };
    }, classifyRejections({ recipients }) {
      return { decisions: recipients.filter((r) => r.address === 'b@example.com').map(({ address }) => ({ address, status: 'rejected', reason: 'permanent' })) };
    } }],
    transports: [{ sendMail(mail, done) {
      envelopes.push(mail.envelope.to); smtp++;
      done(null, smtp === 1 ? { accepted: ['a@example.com'], rejected: ['b@example.com', 'c@example.com'] } : { accepted: mail.envelope.to });
    } }],
    onSent(task, info, recipients) { groups.push(['sent', recipients.map((r) => r.address)]); },
    onError(error, task, info, recipients) { groups.push(['error', recipients.map((r) => r.address)]); },
    onSuppressed(task, recipients) { groups.push(['suppressed', recipients.map((r) => r.address)]); },
    onRejected(task, recipients) { groups.push(['rejected', recipients.map((r) => r.address)]); },
  };
  const make = async (storage) => {
    const m = new MailTime({ ...config, queue: storage });
    instances.push(m); await m.ready(); m.pause(); return m;
  };
  try {
    const first = await make(queue);
    const uuid = await first.sendMail({ to: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'], text: 'hello' });
    await queue.iterate(); await first.drain();
    assert.deepEqual((await readPolicyTask(queue, uuid)).recipientResults.map((r) => r.status), ['sent', 'rejected', 'error', 'suppressed']);
    assert.lengthOf(groups, 0);
    await first.destroy({ drain: true });
    const secondQueue = createPolicyQueueLike(queue, queue.prefix);
    const second = await make(secondQueue);
    await secondQueue.iterate(); await second.drain();
    assert.deepEqual(envelopes, [['a@example.com', 'b@example.com', 'c@example.com'], ['c@example.com']]);
    assert.deepEqual(groups, [['sent', ['a@example.com', 'c@example.com']], ['suppressed', ['d@example.com']], ['rejected', ['b@example.com']]]);
    const stored = await readPolicyTask(secondQueue, uuid);
    if (keepHistory) {
      assert.isTrue(stored.isSettled); assert.isFalse(stored.isSent); assert.isTrue(stored.isFailed);
      assert.isFalse(await secondQueue.cancel(uuid));
    } else assert.isNull(stored);
    await secondQueue.iterate(); await second.drain();
    assert.lengthOf(envelopes, 2);

    // Legacy rows remain eligible; settled rows and exhausted legacy rows do not.
    const legacy = { uuid: 'legacy', tries: 0, sendAt: 1, isSent: false, isFailed: false, isCancelled: false, isSending: false, sendingAt: 0, transport: 0, mailOptions: [{ to: 'old@example.com', text: 'old' }] };
    await secondQueue.push({ ...legacy });
    await secondQueue.push({ ...legacy, uuid: 'settled', isSettled: true });
    await secondQueue.push({ ...legacy, uuid: 'exhausted', tries: 2 });
    const captured = [];
    const dispatch = second.___dispatch;
    second.___dispatch = async (task) => captured.push(task);
    await secondQueue.iterate();
    second.___dispatch = dispatch;
    assert.deepEqual(captured.map((t) => t.uuid), ['legacy']);
    const task = captured[0];
    const stamp = Date.now();
    const claim = { tries: 1, isSending: true, sendingAt: stamp, recipientResults: [] };
    const competing = createPolicyQueueLike(queue, queue.prefix);
    competing.mailTimeInstance = second;
    await competing.ready();
    const claims = await Promise.all([secondQueue.update({ ...task }, claim), competing.update({ ...task }, claim)]);
    assert.equal(claims.filter(Boolean).length, 1);
    assert.isFalse(await competing.update(task, { isSettled: true, leaseTries: 0, leaseSendingAt: 0 }));
    assert.isTrue(await secondQueue.cancel(task.uuid));
    assert.isFalse(await secondQueue.update(task, { isSettled: true, leaseTries: 1, leaseSendingAt: stamp }));
    await secondQueue.push({ ...legacy, uuid: 'recover', tries: 2, isSending: true, sendingAt: 1,
      recipientResults: [{ address: 'old@example.com', status: 'sent', reasons: [], attempt: 2 }] });
    await secondQueue.iterate(); await second.drain();
    assert.lengthOf(envelopes, 2, 'final-attempt recovery performs no SMTP');
    const recovered = await readPolicyTask(secondQueue, 'recover');
    if (keepHistory) { assert.isTrue(recovered.isSettled); assert.equal(recovered.tries, 2); }
    else assert.isNull(recovered);
  } finally {
    for (const m of instances) await m.destroy({ drain: true });
    await clearPolicyQueue(queue);
  }
};

import { afterEach, expect, it, jest } from '@jest/globals';
import { createPolicyMailTime, deferred } from './recipient-policy-helpers.js';

const instances = [];
const make = (opts = {}) => { const m = createPolicyMailTime(opts); instances.push(m); return m; };
const attempt = async (m, uuid) => m.___send(structuredClone(m.queue.records.get(uuid)));
const suppress = { name: 'list', beforeSend: ({ recipients }) => ({ decisions: recipients.map(({ address }) => ({ address, status: 'suppressed', reason: 'opt-out' })) }) };
afterEach(async () => { for (const m of instances.splice(0)) m.destroy(); });

it.each([true, false])('fully suppresses without SMTP or false delivery flags (history=%s)', async (keepHistory) => {
  const sendMail = jest.fn((mail, done) => done(null, { accepted: [mail.to] }));
  const onSent = jest.fn();
  const onError = jest.fn();
  const onSuppressed = jest.fn();
  const m = make({ keepHistory, retries: 0, recipientPolicies: [suppress], transports: [{ sendMail }], onSent, onError, onSuppressed });
  const uuid = await m.sendMail({ to: 'a@example.com', text: 'hello' });
  await attempt(m, uuid);
  expect(sendMail).not.toHaveBeenCalled();
  expect(onSent).not.toHaveBeenCalled();
  expect(onError).not.toHaveBeenCalled();
  expect(onSuppressed).toHaveBeenCalledTimes(1);
  expect(onSuppressed.mock.calls[0][0]).toMatchObject({ isSettled: true, isSent: false, isFailed: false, isSending: false, sendingAt: 0 });
  expect(m.queue.records.has(uuid)).toBe(keepHistory);
});
it.each(['a@example.com, b@example.com', '"Family, Given" <a@example.com>'])('reports terminal preparation failure with no invented recipients: %s', async (to) => {
  const onError = jest.fn();
  const m = make({ retries: 0, onError });
  const uuid = await m.sendMail({ to, text: 'hello' });
  await attempt(m, uuid);
  expect(onError).toHaveBeenCalledTimes(1);
  expect(onError.mock.calls[0][3]).toEqual([]);
  expect(m.queue.records.get(uuid)).toMatchObject({ tries: 1, isSettled: true, isFailed: true, isSent: false, recipientResults: [] });
});
it('consumes and rotates a failed policy attempt, preserves shouldFailOver veto, and runs every provider', async () => {
  const seen = [];
  const m = make({ failsToNext: 1, transports: [{}, {}], recipientPolicies: [suppress, { name: 'offline', beforeSend() { seen.push('offline'); throw new Error('offline'); } }, { name: 'last', beforeSend() { seen.push('last'); } }] });
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const uuid = await m.sendMail({ to: 'a@example.com', text: 'hello' });
  await attempt(m, uuid);
  expect(seen).toEqual(['offline', 'last']);
  expect(m.queue.records.get(uuid)).toMatchObject({ tries: 1, transport: 1, isSending: false, recipientResults: [{ status: 'error' }] });
  const veto = make({ failsToNext: 1, transports: [{}, {}], shouldFailOver: () => false });
  const id = await veto.sendMail({ to: 'ambiguous,list', text: 'hello' });
  await attempt(veto, id);
  expect(veto.queue.records.get(id).transport).toBe(0);
});
it('explicit envelope wins and original headers survive mixed suppression', async () => {
  const sent = [];
  const m = make({ recipientPolicies: [{ name: 'p', beforeSend() { return { decisions: [{ address: 'blocked@example.com', status: 'suppressed', reason: 'blocked' }] }; } }], transports: [{ sendMail(mail, done) { sent.push(mail); done(null, { accepted: mail.envelope.to }); } }] });
  const uuid = await m.sendMail({ to: '"Complex, Name" <header@example.com>', cc: 'header-cc@example.com', bcc: 'hidden@example.com', envelope: { from: '', to: ['actual@example.com', 'blocked@example.com'] }, text: 'hello' });
  await attempt(m, uuid);
  expect(sent[0].envelope).toEqual({ from: '', to: ['actual@example.com'] });
  expect(sent[0].to).toBe('"Complex, Name" <header@example.com>');
  expect(sent[0].bcc).toBe('hidden@example.com');
  expect(m.queue.records.get(uuid)).toMatchObject({ isSettled: true, isSent: false, isFailed: false });
});
it('strictPayload discards queued envelope while permitting trusted transport defaults', async () => {
  const envelopes = [];
  const m = make({ strictPayload: true, transports: [{ options: { mailOptions: { envelope: { to: ['trusted@example.com'] } } }, sendMail(mail, done) { envelopes.push(mail.envelope); done(null, { accepted: mail.envelope.to }); } }] });
  const uuid = await m.sendMail({ to: 'Complex: a@example.com;', envelope: { to: ['untrusted@example.com'] }, text: 'hello' });
  await attempt(m, uuid);
  expect(envelopes[0].to).toEqual(['trusted@example.com']);
});
it('persists acceptance before a slow classifier and retries only unresolved recipients', async () => {
  const entered = deferred();
  const proceed = deferred();
  const envelopes = [];
  const headers = [];
  let calls = 0;
  const m = make({ recipientPolicies: [{ name: 'bounce', async classifyRejections(ctx) {
    entered.resolve(ctx);
    await proceed.promise;
    return { decisions: [{ address: 'b@example.com', status: 'rejected', reason: 'hard-bounce' }] };
  } }], transports: [{ sendMail(mail, done) {
    envelopes.push(mail.envelope.to); headers.push(mail.to); calls++;
    done(null, calls === 1 ? { accepted: ['a@example.com'], rejected: ['b@example.com', 'c@example.com'] } : { accepted: ['c@example.com'] });
  } }] });
  const uuid = await m.sendMail({ to: ['a@example.com', 'b@example.com', 'c@example.com'], text: 'hello' });
  const send = attempt(m, uuid);
  try {
    const ctx = await Promise.race([entered.promise, send.then(() => { throw new Error('classifier did not run'); })]);
    expect(ctx.recipients.map((r) => r.address)).toEqual(['b@example.com', 'c@example.com']);
    expect(m.queue.records.get(uuid).recipientResults.find((r) => r.address === 'a@example.com').status).toBe('sent');
  } finally { proceed.resolve(); await send; }
  await attempt(m, uuid);
  expect(envelopes).toEqual([['a@example.com', 'b@example.com', 'c@example.com'], ['c@example.com']]);
  expect(headers[1]).toEqual(headers[0]);
  expect(m.queue.records.get(uuid)).toMatchObject({ isSettled: true, isFailed: true, recipientResults: [{ status: 'sent' }, { status: 'rejected' }, { status: 'sent' }] });
});
it.each([true, false])('publishes all four terminal groups in order after persistence (history=%s)', async (keepHistory) => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const groups = [];
  const summaries = [];
  const capture = (name, task, recipients, summary) => {
    expect(keepHistory ? m.queue.records.get(task.uuid).isSettled : !m.queue.records.has(task.uuid)).toBe(true);
    groups.push([name, recipients.map((r) => r.address)]); summaries.push(summary);
  };
  const m = make({ keepHistory, retries: 0, recipientPolicies: [{ name: 'p',
    beforeSend: () => ({ decisions: [{ address: 'd@example.com', status: 'suppressed', reason: 'opt-out' }] }),
    classifyRejections: () => ({ decisions: [{ address: 'b@example.com', status: 'rejected', reason: 'hard' }] }),
    observeAttempt: async () => { throw new Error('observer'); },
  }], transports: [{ sendMail(mail, done) { done(null, { accepted: ['a@example.com'], rejected: ['b@example.com', 'c@example.com'] }); } }],
  onSent(task, info, recipients, summary) { capture('sent', task, recipients, summary); throw new Error('callback'); },
  onError(error, task, info, recipients, summary) { capture('error', task, recipients, summary); return Promise.reject(new Error('async callback')); },
  onSuppressed(task, recipients, summary) { capture('suppressed', task, recipients, summary); },
  onRejected(task, recipients, summary) { capture('rejected', task, recipients, summary); },
  });
  const uuid = await m.sendMail({ to: ['a@example.com', 'b@example.com', 'c@example.com', 'd@example.com'], text: 'hello' });
  await attempt(m, uuid);
  expect(groups).toEqual([['sent', ['a@example.com']], ['error', ['c@example.com']], ['suppressed', ['d@example.com']], ['rejected', ['b@example.com']]]);
  expect(summaries.every((s) => s === summaries[0])).toBe(true);
});
it.each(['info', 'error'])('durably accepts recipients even when callback reports an error (%s)', async (source) => {
  const m = make({ retries: 0, transports: [{ sendMail(mail, done) {
    const error = new Error('partial error');
    const info = { rejected: ['b@example.com'] };
    (source === 'info' ? info : error).accepted = ['a@example.com', 'outside@example.com'];
    done(error, info);
  } }] });
  const uuid = await m.sendMail({ to: ['a@example.com', 'b@example.com'], text: 'hello' });
  await attempt(m, uuid);
  expect(m.queue.records.get(uuid).recipientResults.map((r) => r.status)).toEqual(['sent', 'error']);
  expect(m.queue.records.get(uuid).mailOptions[0].accepted).toEqual(['a@example.com']);
});
it('isolates synchronous transport throws and duplicate callbacks', async () => {
  const onSent = jest.fn();
  const m = make({ retries: 0, onSent, transports: [{ sendMail(mail, done) { done(null, { accepted: mail.envelope.to }); done(new Error('late')); throw new Error('later'); } }] });
  const uuid = await m.sendMail({ to: 'a@example.com', text: 'hello' });
  await attempt(m, uuid);
  expect(onSent).toHaveBeenCalledTimes(1);
  const onError = jest.fn();
  const failed = make({ retries: 0, onError, transports: [{ sendMail() { throw new Error('sync'); } }] });
  const id = await failed.sendMail({ to: 'a@example.com', text: 'hello' });
  await attempt(failed, id);
  expect(onError).toHaveBeenCalledTimes(1);
});
it('reruns beforeSend for pending errors and can suppress them on retry', async () => {
  const envelopes = [];
  const m = make({ recipientPolicies: [{ name: 'p', beforeSend({ attempt }) { return attempt === 1 ? void 0 : { decisions: [{ address: 'b@example.com', status: 'suppressed', reason: 'new opt-out' }] }; } }], transports: [{ sendMail(mail, done) { envelopes.push(mail.envelope.to); done(null, { accepted: ['a@example.com'], rejected: ['b@example.com'] }); } }] });
  const uuid = await m.sendMail({ to: ['a@example.com', 'b@example.com'], text: 'hello' });
  await attempt(m, uuid); await attempt(m, uuid);
  expect(envelopes).toHaveLength(1);
  expect(m.queue.records.get(uuid)).toMatchObject({ isSettled: true, isSent: false, isFailed: false });
});

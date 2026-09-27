import { afterEach, expect, it, jest } from '@jest/globals';
import { MailTime } from '../../index.js';
import { createPolicyMailTime, deferred } from './recipient-policy-helpers.js';

const instances = [];
const make = (opts = {}) => { const m = createPolicyMailTime(opts); instances.push(m); return m; };
const attempt = (m, uuid) => m.___send(structuredClone(m.queue.records.get(uuid)));
afterEach(() => { for (const m of instances.splice(0)) m.destroy(); });

it.each(['mixed', 'empty', 'terminal', 'ambiguous'])('settles stale final-attempt %s state without SMTP or policy hooks', async (kind) => {
  const sendMail = jest.fn((mail, done) => done(null, { accepted: mail.envelope.to }));
  const beforeSend = jest.fn();
  const m = make({ retries: 0, transports: [{ sendMail }], recipientPolicies: [{ name: 'p', beforeSend }] });
  const uuid = await m.sendMail({ to: kind === 'ambiguous' ? 'a@example.com,b@example.com' : ['a@example.com', 'b@example.com'], text: 'hello' });
  const row = m.queue.records.get(uuid);
  Object.assign(row, { tries: 1, isSending: true, sendingAt: Date.now() - m.sendingTimeout - 1, recipientResults: kind === 'empty' || kind === 'ambiguous' ? [] : [
    { address: 'a@example.com', status: 'sent', reasons: [], attempt: 1 },
    { address: 'b@example.com', status: kind === 'terminal' ? 'suppressed' : 'error', reasons: [], attempt: 1 },
  ] });
  await m.queue.iterate(); await m.drain();
  expect(sendMail).not.toHaveBeenCalled();
  expect(beforeSend).not.toHaveBeenCalled();
  expect(m.queue.records.get(uuid)).toMatchObject({ tries: 1, isSettled: true, isFailed: kind !== 'terminal' });
});
it('settles durable acceptance without recompiling or consuming another attempt after a lost completion', async () => {
  const sendMail = jest.fn((mail, done) => done(null, { accepted: mail.envelope.to }));
  const transport = { options: { from: 'sender@example.com', mailOptions: { envelope: { to: ['a@example.com'] } } }, sendMail };
  const onSent = jest.fn();
  const onError = jest.fn();
  const m = make({ transports: [transport], onSent, onError });
  const update = m.queue.update;
  let lostCompletion = false;
  m.queue.update = async (task, fields) => {
    if (fields.isSettled && !lostCompletion) { lostCompletion = true; return false; }
    return await update(task, fields);
  };
  const uuid = await m.sendMail({ to: 'a@example.com', text: 'hello' });
  await attempt(m, uuid);
  const row = m.queue.records.get(uuid);
  expect(row).toMatchObject({ tries: 1, isSettled: false, recipientResults: [{ status: 'sent' }] });
  row.sendingAt = Date.now() - m.sendingTimeout - 1;
  transport.options.mailOptions.envelope.to = ['b@example.com'];
  await m.queue.iterate();
  await m.drain();
  expect(m.queue.records.get(uuid)).toMatchObject({ tries: 1, isSent: true, isFailed: false, isSettled: true });
  expect(sendMail).toHaveBeenCalledTimes(1);
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(onError).not.toHaveBeenCalled();
});
it.each(['beforeSend', 'classifyRejections', 'observeAttempt'])('cancellation during %s prevents stale send/completion', async (phase) => {
  const entered = deferred();
  const release = deferred();
  const onError = jest.fn();
  const onSent = jest.fn();
  let sends = 0;
  const m = make({ retries: 0, onError, onSent, recipientPolicies: [{ name: 'held', async [phase]() { entered.resolve(); await release.promise; } }], transports: [{ sendMail(mail, done) { sends++; done(null, { accepted: [], rejected: mail.envelope.to }); } }] });
  const uuid = await m.sendMail({ to: 'a@example.com', text: 'hello' });
  const send = attempt(m, uuid);
  await entered.promise;
  expect(await m.cancelMail(uuid)).toBe(true);
  release.resolve(); await send;
  expect(sends).toBe(phase === 'beforeSend' ? 0 : 1);
  expect(onError).not.toHaveBeenCalled(); expect(onSent).not.toHaveBeenCalled();
  expect(m.queue.records.get(uuid).isCancelled).toBe(true);
  expect(m.queue.records.get(uuid).isSettled).toBe(false);
});
it.each([false, true])('a lost accepted checkpoint (%s=throw) prevents classifiers and callbacks', async (throws) => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const classifier = jest.fn();
  const onSent = jest.fn();
  const m = make({ retries: 0, onSent, recipientPolicies: [{ name: 'p', classifyRejections: classifier }], transports: [{ sendMail(mail, done) { done(null, { accepted: ['a@example.com'], rejected: ['b@example.com'] }); } }] });
  const original = m.queue.update;
  m.queue.update = async (task, fields) => {
    if (fields.recipientResults?.some((r) => r.status === 'sent')) {
      if (throws) throw new Error('write failed');
      return false;
    }
    return original(task, fields);
  };
  const uuid = await m.sendMail({ to: ['a@example.com', 'b@example.com'], text: 'hello' });
  await attempt(m, uuid);
  expect(classifier).not.toHaveBeenCalled(); expect(onSent).not.toHaveBeenCalled();
  expect(m.queue.records.get(uuid).isSending).toBe(true);
});
it.each([false, true])('shutdown during policy work honors drain=%s', async (drain) => {
  const entered = deferred();
  const release = deferred();
  const onSent = jest.fn();
  const m = make({ renewClaim: 5, maxRenewals: 100, onSent, recipientPolicies: [{ name: 'held', async beforeSend() { entered.resolve(); await release.promise; } }] });
  const uuid = await m.sendMail({ to: 'a@example.com', text: 'hello' });
  await m.___dispatch(structuredClone(m.queue.records.get(uuid)));
  await entered.promise;
  const stamp = m.queue.records.get(uuid).sendingAt;
  let finished = false;
  const shutdown = Promise.resolve(m.destroy(drain ? { drain: true } : void 0)).then(() => { finished = true; });
  await new Promise((resolve) => setTimeout(resolve, 25));
  if (drain) { expect(finished).toBe(false); expect(m.queue.records.get(uuid).sendingAt).toBeGreaterThan(stamp); }
  else expect(m.queue.records.get(uuid).sendingAt).toBe(stamp);
  release.resolve(); await m.drain(); await shutdown;
  expect(onSent).toHaveBeenCalledTimes(drain ? 1 : 0);
});
it('budget exhaustion does not let a superseded worker pass the next checkpoint', async () => {
  const entered = deferred();
  const release = deferred();
  const sendMail = jest.fn();
  const m = make({ maxRenewals: 0, recipientPolicies: [{ name: 'held', async beforeSend() { entered.resolve(); await release.promise; } }], transports: [{ sendMail }] });
  const uuid = await m.sendMail({ to: 'a@example.com', text: 'hello' });
  const sending = attempt(m, uuid);
  await entered.promise;
  const row = m.queue.records.get(uuid);
  row.tries++;
  row.sendingAt++;
  release.resolve(); await sending;
  expect(sendMail).not.toHaveBeenCalled();
  expect(row.isSending).toBe(true);
});
it('envelope drift fails closed and new concatenated content gets another task', async () => {
  const sent = [];
  const m = make({ concatEmails: true, concatDelay: 0, failsToNext: 1, transports: [
    { options: { mailOptions: { envelope: { to: ['a@example.com'] } } }, sendMail(mail, done) { sent.push(mail.envelope.to); done(new Error('retry')); } },
    { options: { mailOptions: { envelope: { to: ['b@example.com'] } } }, sendMail(mail, done) { sent.push(mail.envelope.to); done(null, { accepted: mail.envelope.to }); } },
  ] });
  const uuid = await m.sendMail({ to: 'header@example.com', text: 'one' });
  await attempt(m, uuid);
  const old = m.__recipientPolicies;
  m.__recipientPolicies = null;
  const next = await m.sendMail({ to: 'header@example.com', text: 'two' });
  m.__recipientPolicies = old;
  expect(next).not.toBe(uuid);
  await attempt(m, uuid);
  expect(sent).toEqual([['a@example.com']]);
  expect(m.queue.records.get(uuid).isFailed).toBe(true);
});
it('disabled policies never fall through to the legacy sender for policy-owned rows', async () => {
  const m = make();
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const uuid = await m.sendMail({ to: 'a@example.com', text: 'hello' });
  const row = m.queue.records.get(uuid);
  row.recipientResults = [];
  m.__recipientPolicies = null;
  await attempt(m, uuid);
  expect(row.tries).toBe(0);
});
it('a missing policy marker remains valid for no-policy clients', () => {
  const m = make();
  const queue = { ...m.queue, supportsRecipientPolicies: void 0 };
  const client = new MailTime({ type: 'client', queue });
  instances.push(client);
  expect(client).toBeInstanceOf(MailTime);
});

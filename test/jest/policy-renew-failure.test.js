import { afterEach, expect, it, jest } from '@jest/globals';
import { createPolicyMailTime } from './recipient-policy-helpers.js';

const instances = [];
afterEach(() => { jest.restoreAllMocks(); for (const m of instances.splice(0)) m.destroy(); });

it('a throwing claim-renewal write does not leave the policy outcome silent', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const onError = jest.fn();
  const onSent = jest.fn();
  const m = createPolicyMailTime({
    renewClaim: 20, maxRenewals: 100, onError, onSent,
    transports: [{ sendMail(mail, done) { setTimeout(() => done(null, { accepted: mail.envelope.to }), 120); } }],
  });
  instances.push(m);
  const realUpdate = m.queue.update.bind(m.queue);
  let renewThrows = 0;
  m.queue.update = async (task, fields) => {
    if (fields.isSending === true && fields.tries === void 0 && fields.recipientResults === void 0 && typeof fields.leaseTries === 'number') {
      renewThrows++;
      throw new Error('renew write failed');
    }
    return realUpdate(task, fields);
  };
  const uuid = await m.sendMail({ to: 'a@example.com', text: 'hello' });
  await m.___send(structuredClone(m.queue.records.get(uuid)));
  await m.drain();
  const row = m.queue.records.get(uuid);
  expect(renewThrows).toBeGreaterThanOrEqual(1);
  const outcomeWritten = row.isSent === true || row.isSettled === true;
  // With the lease kept open, the outcome write succeeds and delivery is recorded.
  expect(outcomeWritten).toBe(true);
  expect(onSent).toHaveBeenCalledTimes(1);
});

const lostAck = async ({ takeover }) => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const onError = jest.fn();
  const onSent = jest.fn();
  const m = createPolicyMailTime({
    renewClaim: 20, maxRenewals: 100, onError, onSent,
    transports: [{ sendMail(mail, done) { setTimeout(() => done(null, { accepted: mail.envelope.to }), 120); } }],
  });
  instances.push(m);
  const realUpdate = m.queue.update.bind(m.queue);
  let thrown = 0;
  const uuid = await m.sendMail({ to: 'a@example.com', text: 'hello' });
  m.queue.update = async (task, fields) => {
    const isRenew = fields.isSending === true && fields.tries === void 0 && fields.recipientResults === void 0 && typeof fields.leaseTries === 'number';
    const result = await realUpdate(task, fields);
    if (isRenew && thrown++ === 0) {
      if (takeover) m.queue.records.get(uuid).sendingAt += 100000;
      throw new Error('ack lost');
    }
    return result;
  };
  await m.___send(structuredClone(m.queue.records.get(uuid)));
  const { failedWrites } = await m.drain();
  expect(thrown).toBeGreaterThanOrEqual(1);
  return { failedWrites, onError, onSent, row: m.queue.records.get(uuid) };
};

it('a lost renewal ack (storage applied, driver threw) recovers with one retry and completes cleanly', async () => {
  const { failedWrites, onError, onSent, row } = await lostAck({ takeover: false });
  expect(failedWrites).toBe(0);
  expect(onError).not.toHaveBeenCalled();
  expect(onSent).toHaveBeenCalledTimes(1);
  expect(row.isSent === true || row.isSettled === true).toBe(true);
});

it('a lost renewal ack followed by a peer takeover is reported once and does not steal the row', async () => {
  const { failedWrites, onError, onSent, row } = await lostAck({ takeover: true });
  expect(failedWrites).toBe(1);
  const lost = onError.mock.calls.filter((c) => /outcome write lost/.test(c[0].message));
  expect(lost).toHaveLength(1);
  expect(['checkpoint', 'complete']).toContain(lost[0][2].phase);
  expect(onSent).not.toHaveBeenCalled();
  expect(row.isSending).toBe(true);
});

it('stale claim + renewal applied then threw + no peer: reported once at checkpoint, no retry, row stays sending', async () => {
  jest.spyOn(console, 'error').mockImplementation(() => {});
  const onError = jest.fn();
  const onSent = jest.fn();
  const m = createPolicyMailTime({
    sendingTimeout: 30, renewClaim: 60, maxRenewals: 100, onError, onSent,
    transports: [{ sendMail(mail, done) { setTimeout(() => done(null, { accepted: mail.envelope.to }), 150); } }],
  });
  instances.push(m);
  const realUpdate = m.queue.update.bind(m.queue);
  let thrown = 0;
  let checkpointWrites = 0;
  m.queue.update = async (task, fields) => {
    const isRenew = fields.isSending === true && fields.tries === void 0 && fields.recipientResults === void 0 && typeof fields.leaseTries === 'number';
    if (!isRenew && thrown > 0 && typeof fields.leaseTries === 'number') checkpointWrites++;
    const result = await realUpdate(task, fields);
    if (isRenew && thrown++ === 0) throw new Error('ack lost');
    return result;
  };
  const uuid = await m.sendMail({ to: 'a@example.com', text: 'hello' });
  await m.___send(structuredClone(m.queue.records.get(uuid)));
  const { failedWrites } = await m.drain();
  expect(thrown).toBeGreaterThanOrEqual(1);
  expect(failedWrites).toBe(1);
  const lost = onError.mock.calls.filter((c) => /outcome write lost/.test(c[0].message));
  expect(lost).toHaveLength(1);
  expect(lost[0][2].phase).toBe('checkpoint');
  expect(checkpointWrites).toBe(1);
  expect(onSent).not.toHaveBeenCalled();
  expect(m.queue.records.get(uuid).isSending).toBe(true);
});

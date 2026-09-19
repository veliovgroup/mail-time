import { describe, expect, it } from '@jest/globals';
import { MailTime } from '../../index.js';
import { createQueue } from './helpers.js';
import { normalizePolicyAddress, preparePolicyEnvelope, validateRecipientPolicies } from '../../recipient-policy.js';

const queue = { supportsRecipientPolicies: true };
const policy = { name: 'p', beforeSend() {} };

describe('policy envelope preparation', () => {
  it('deduplicates actual recipients and preserves source fields without mutation', () => {
    const input = { from: 'Sender <sender@example.com>', to: ['User <A+tag@example.com>', { address: 'b@example.com' }], cc: ' a+tag@EXAMPLE.COM ', bcc: 'b@example.com' };
    const copy = structuredClone(input);
    expect(preparePolicyEnvelope(input)).toEqual({
      envelope: { from: 'sender@example.com', to: ['a+tag@example.com', 'b@example.com'] },
      recipients: [{ address: 'a+tag@example.com', sources: ['to', 'cc'] }, { address: 'b@example.com', sources: ['to', 'bcc'] }],
    });
    expect(input).toEqual(copy);
  });
  it('honors explicit envelopes and ignores ambiguous headers', () => {
    expect(preparePolicyEnvelope({ to: '"Family, Given" <header@example.com>', cc: 'Actual@example.com', envelope: { from: '', to: [' Actual@example.com '] } })).toEqual({
      envelope: { from: '', to: ['actual@example.com'] }, recipients: [{ address: 'actual@example.com', sources: ['envelope', 'cc'] }],
    });
  });
  it.each(['a@example.com, b@example.com', 'Team: a@example.com;', '"Family, Given" <a@example.com>', '', 'a@example.com\r\n', 'A <a@example.com> B <b@example.com>', ['a@example.com'], null, {}])('rejects ambiguous single mailbox %j', (value) => {
    expect(() => normalizePolicyAddress(value)).toThrow('[mail-time] [recipientPolicies]');
  });
  it.each([{ to: [] }, { to: 'a@example.com', envelope: { to: [] } }, { to: [['a@example.com']] }, { to: 'a@example.com', cc: null }])('rejects empty or malformed batches %j', (value) => {
    expect(() => preparePolicyEnvelope(value)).toThrow();
  });
  it('accepts scalar objects and keeps plus tags, dots, and Unicode', () => {
    expect(normalizePolicyAddress({ address: ' A.B+tag@EXAMPLE.com ' })).toBe('a.b+tag@example.com');
    expect(normalizePolicyAddress('名字@example.com')).toBe('名字@example.com');
    expect(preparePolicyEnvelope({ to: { address: 'a@example.com' }, sender: 's@example.com' }).envelope.from).toBe('s@example.com');
    expect(preparePolicyEnvelope({ to: 'a@example.com', replyTo: 'r@example.com' }).envelope.from).toBe('r@example.com');
  });
  it('rejects recipient drift but accepts reordering', () => {
    const previous = [{ address: 'a@example.com' }, { address: 'b@example.com' }];
    expect(() => preparePolicyEnvelope({ to: ['a@example.com', 'c@example.com'] }, previous)).toThrow(/changed/);
    expect(preparePolicyEnvelope({ to: ['b@example.com', 'a@example.com'] }, previous).recipients).toHaveLength(2);
  });
});

describe('policy configuration', () => {
  it.each([[], null, {}, [{ name: ' ', beforeSend() {} }], [{ name: 'p', beforeSend: true }], [{ name: 'p', failureMode: 'ignore', beforeSend() {} }], [policy, policy], [{ name: 'p' }], [new Date()], [{ name: 'p'.repeat(129), beforeSend() {} }]])('rejects malformed providers %j', (value) => {
    expect(() => validateRecipientPolicies(value, queue)).toThrow('[mail-time] [recipientPolicies]');
  });
  it('requires capability only for configured policies and preserves hook receiver', () => {
    expect(validateRecipientPolicies(void 0, {})).toBe(null);
    expect(() => validateRecipientPolicies([policy], {})).toThrow(/support/);
    const provider = { name: ' p ', beforeSend() { return this; } };
    const normalized = validateRecipientPolicies([provider], queue);
    expect(normalized[0].name).toBe('p');
    expect(normalized[0].failureMode).toBe('retry');
    expect(normalized[0].beforeSend()).toBe(provider);
    expect(validateRecipientPolicies([{ name: 'p'.repeat(128), observeAttempt() {}, failureMode: 'continue' }], queue)[0].failureMode).toBe('continue');
  });
  it('rejects unsupported custom queues before assigning the instance', () => {
    const custom = createQueue();
    expect(() => new MailTime({ type: 'client', queue: custom, recipientPolicies: [policy] })).toThrow(/support/);
    expect(custom.mailTimeInstance).toBe(null);
  });
  it('enqueues a mailbox object without configuring providers on the client', async () => {
    const mailTime = new MailTime({ type: 'client', queue: createQueue() });
    try {
      const uuid = await mailTime.sendMail({ to: { address: 'a@example.com' }, text: 'hello' });
      expect(mailTime.queue.records.get(uuid)).toMatchObject({ isSettled: false, mailOptions: [{ to: { address: 'a@example.com' } }] });
      expect(mailTime.queue.records.get(uuid).recipientResults).toBeUndefined();
    } finally { mailTime.destroy(); }
  });
});

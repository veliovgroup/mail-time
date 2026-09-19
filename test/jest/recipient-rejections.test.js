import { expect, it, jest } from '@jest/globals';
import { normalizeRejections } from '../../recipient-rejections.js';
import { evaluatePolicyPhase, mergePolicyResults, summarizePolicyTask } from '../../recipient-policy.js';

const recipients = ['a@example.com', 'b@example.com'].map((address) => ({ address, sources: ['to'] }));
const context = { recipients, rejections: [{ address: 'a@example.com' }, { address: null }] };
const decision = { address: 'a@example.com', status: 'suppressed', reason: 'blocked' };

it('matches explicit recipients before position and retains unknown leaves', () => {
  const info = { rejected: ['a@example.com', 'b@example.com'], rejectedErrors: [
    { recipient: 'b@example.com', command: 'RCPT TO', responseCode: 550, message: 'b failed' },
    { errors: [{ recipient: 'a@example.com', response: '550 5.1.1 a failed' }, new Error('unknown')] },
  ] };
  const records = normalizeRejections(null, info, { index: 1, name: 'backup' });
  expect(records.map((r) => r.address)).toEqual(['b@example.com', 'a@example.com', null]);
  expect(records[0]).toMatchObject({ command: 'RCPT TO', responseCode: 550, transportIndex: 1, transportName: 'backup' });
  expect(info.rejectedErrors[0].recipient).toBe('b@example.com');
});
it('retains duplicates, stops cycles and skips aggregate wrappers', () => {
  const leaf = { recipient: 'a@example.com', message: 'rejected' };
  const wrapper = { message: 'aggregate', errors: [leaf, leaf] };
  wrapper.errors.push(wrapper);
  expect(normalizeRejections(wrapper, null, { index: 0 }).map((r) => r.address)).toEqual(['a@example.com', 'a@example.com']);
});
it('uses position only without contradictory explicit attribution and fills missing records', () => {
  const records = normalizeRejections({ rejected: ['a@example.com', 'b@example.com', 'c@example.com'], rejectedErrors: [{ message: 'positional' }, { recipient: 'bad', message: 'unknown' }] }, null, { index: 0 });
  expect(records.map((r) => r.address)).toEqual(['a@example.com', null, 'b@example.com', 'c@example.com']);
});
it('bounds scalars and never persists metadata', () => {
  const records = normalizeRejections({ address: 'A@example.com', command: 'RCPT TO', responseCode: 550, response: 'r'.repeat(3000), message: 'm'.repeat(3000), secret: {} }, { errors: [42, 'bad', {}] }, { index: 0, name: 'n'.repeat(200) });
  expect(records[0].response).toHaveLength(2048);
  expect(records[0].message).toHaveLength(2048);
  expect(records[0].transportName).toHaveLength(128);
  expect(records[0].secret).toBeUndefined();
  expect(records.slice(1).map((r) => r.address)).toEqual([null, null, null]);
});
it('handles absent records and simple to attribution', () => {
  expect(normalizeRejections(null, void 0, { index: 0 })).toEqual([]);
  expect(normalizeRejections({ to: 'a@example.com' }, null, { index: 0 })[0].address).toBe('a@example.com');
});
it('runs every provider on the same batch despite failures', async () => {
  const seen = [];
  const evaluated = await evaluatePolicyPhase([
    { name: 'first', beforeSend(ctx) { seen.push(ctx); return { decisions: [decision] }; } },
    { name: 'broken', beforeSend(ctx) { seen.push(ctx); throw new Error('offline'); } },
    { name: 'last', beforeSend(ctx) { seen.push(ctx); } },
  ], 'beforeSend', context, () => {});
  expect(seen).toEqual([context, context, context]);
  expect(evaluated.retryFailure).toBe(true);
  expect(evaluated.decisions).toEqual([{ ...decision, provider: 'first' }]);
});
it.each([null, [], true, { decisions: null }, { decisions: [{}] },
  { decisions: [{ ...decision, address: 'unknown@example.com' }] },
  { decisions: [{ ...decision, status: 'rejected' }] },
  { decisions: [{ ...decision, reason: '' }] },
  { decisions: [{ ...decision, reason: 'r'.repeat(513) }] },
  { decisions: [decision, { ...decision, reason: 'different' }] },
].map((value) => [value]))('discards the whole malformed result %j', async (result) => {
  const report = jest.fn();
  const evaluated = await evaluatePolicyPhase([{ name: 'p', beforeSend: async () => result }], 'beforeSend', context, report);
  expect(evaluated).toEqual({ retryFailure: true, decisions: [] });
  expect(report).toHaveBeenCalledTimes(1);
});
it('collapses identical decisions and permits abstention', async () => {
  const evaluated = await evaluatePolicyPhase([
    { name: 'p', beforeSend: () => ({ decisions: [decision, decision] }) },
    { name: 'empty', beforeSend: () => ({}) },
    { name: 'list', beforeSend: () => ({ decisions: [] }) },
    { name: 'nohook' },
    { name: 'open', failureMode: 'continue', beforeSend: async () => { throw new Error('offline'); } },
  ], 'beforeSend', context, () => {});
  expect(evaluated).toEqual({ retryFailure: false, decisions: [{ ...decision, provider: 'p' }] });
});
it('allows permanent rejection only for attributable current recipients', async () => {
  for (const address of ['a@example.com', 'b@example.com']) {
    const result = await evaluatePolicyPhase([{ name: 'p', classifyRejections: () => ({ decisions: [{ address, status: 'rejected', reason: '5.1.1' }] }) }], 'classifyRejections', context, () => {});
    expect(result.retryFailure).toBe(address === 'b@example.com');
  }
});
it('merges conservatively and preserves prior terminal recipients', () => {
  const details = { phase: 'beforeSend', attempt: 2, transportIndex: 0 };
  const evaluated = { retryFailure: false, decisions: [{ ...decision, provider: 'p' }] };
  let results = mergePolicyResults([], recipients, evaluated, details);
  expect(results.map((r) => r.status)).toEqual(['suppressed', 'error']);
  results = mergePolicyResults(results, recipients, { retryFailure: true, decisions: [] }, { ...details, accepted: ['b@example.com'] });
  expect(results.map((r) => r.status)).toEqual(['suppressed', 'sent']);
  expect(mergePolicyResults([], recipients, { ...evaluated, retryFailure: true }, details).map((r) => r.status)).toEqual(['error', 'error']);
  const summary = summarizePolicyTask({ uuid: 'u', tries: 2, recipientResults: results }, true);
  expect(summary.recipients.sent.map((r) => r.address)).toEqual(['b@example.com']);
  expect(summary.recipients.suppressed.map((r) => r.address)).toEqual(['a@example.com']);
  expect(summary.isSettled).toBe(true);
});
it('rejection overrides retry, includes all winning reasons, and replaces attempt details', () => {
  const evaluated = { retryFailure: false, decisions: [
    { address: 'a@example.com', status: 'retry', reason: 'temporary', provider: 'one' },
    { address: 'a@example.com', status: 'rejected', reason: 'hard', provider: 'two' },
    { address: 'a@example.com', status: 'rejected', reason: 'known', provider: 'three' },
    { address: 'b@example.com', status: 'retry', reason: 'unknown', provider: 'one' },
  ] };
  const results = mergePolicyResults([], recipients, evaluated, { phase: 'classifyRejections', attempt: 1, transportIndex: 1, transportName: 'backup', rejections: [{ address: 'a@example.com', message: 'rejected' }] });
  expect(results[0]).toMatchObject({ status: 'rejected', message: 'rejected', reasons: [{ provider: 'two', reason: 'hard' }, { provider: 'three', reason: 'known' }] });
  const retry = mergePolicyResults(results, recipients, { retryFailure: false, decisions: [] }, { phase: 'beforeSend', attempt: 2, transportIndex: 0 });
  expect(retry[1]).toMatchObject({ status: 'error', attempt: 2, reasons: [] });
  expect(retry[1].message).toBeUndefined();
});

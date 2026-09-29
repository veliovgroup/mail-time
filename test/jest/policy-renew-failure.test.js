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
  const { failedWrites } = await m.drain();
  const row = m.queue.records.get(uuid);
  expect(renewThrows).toBeGreaterThanOrEqual(1);
  const outcomeWritten = row.isSent === true || row.isSettled === true;
  const surfaced = failedWrites >= 1 && onError.mock.calls.length >= 1;
  expect(outcomeWritten || surfaced).toBe(true);
  // With the lease kept open, the outcome write succeeds and delivery is recorded.
  expect(outcomeWritten).toBe(true);
  expect(onSent).toHaveBeenCalledTimes(1);
});

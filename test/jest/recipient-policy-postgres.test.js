import { expect, it, jest } from '@jest/globals';
import { PostgresQueue } from '../../adapters/postgres.js';
import { createPostgresClient } from './helpers.js';

const make = async () => {
  const client = createPostgresClient();
  const queue = new PostgresQueue({ client, prefix: 'policy' });
  queue.mailTimeInstance = { maxTries: 2, sendingTimeout: 300000, keepHistory: true, ___dispatch: jest.fn() };
  await queue.ready();
  return { queue, client };
};
it('migrates policy columns before versioned indexes', async () => {
  const { client, queue } = await make();
  expect(queue.supportsRecipientPolicies).toBe(true);
  const sql = client.queries.map((q) => q.queryText).join('\n');
  expect(sql).toContain('ADD COLUMN IF NOT EXISTS is_settled');
  expect(sql).toContain('ADD COLUMN IF NOT EXISTS recipient_results');
  expect(sql.indexOf('ADD COLUMN IF NOT EXISTS is_settled')).toBeLessThan(sql.indexOf('idx_mail_time_queue_policy_due_v1'));
});
it('serializes both fields and guards policy checkpoint/claim/removal SQL', async () => {
  const { client, queue } = await make();
  await queue.update({ uuid: 'u', tries: 1 }, { recipientResults: [], isSettled: false, leaseTries: 1, leaseSendingAt: 10 });
  const query = client.queries.at(-1);
  expect(query.queryText).toMatch(/recipient_results = \$1/);
  expect(query.queryText).toContain('is_settled = false');
  expect(query.values[0]).toBe('[]');
  await queue.update({ uuid: 'u', tries: 1 }, { isSending: true, tries: 2, sendingAt: 20 });
  expect(client.queries.at(-1).queryText).toContain('is_settled = false');
  await queue.remove({ uuid: 'u' }, { leaseTries: 2, leaseSendingAt: 20 });
  expect(client.queries.at(-1).queryText).toContain('is_settled = false');
});
it('does not confuse empty result arrays with absence on insert', async () => {
  const { client, queue } = await make();
  for (const recipientResults of [void 0, []]) {
    await queue.push({ uuid: 'u', mailOptions: [], recipientResults });
    expect(client.queries.at(-1).queryText).toContain('recipient_results');
    expect(client.queries.at(-1).values.at(-1)).toBe(recipientResults ? '[]' : null);
  }
});
it.each(['[]', [], null])('returns result state %j from due rows and admits completion recovery', async (recipient_results) => {
  const { client, queue } = await make();
  client.query = async (sql) => {
    expect(sql).toContain('recipient_results IS NOT NULL');
    expect(sql).toContain('is_settled = false');
    return { rows: [{ uuid: 'u', tries: '2', send_at: '0', transport: '0', mail_options: '[]', recipient_results, is_settled: false }] };
  };
  await queue.iterate();
  expect(queue.mailTimeInstance.___dispatch.mock.calls[0][0].recipientResults).toEqual(recipient_results === null ? void 0 : []);
});
it('excludes initialized policy state from lookup and append', async () => {
  const { client, queue } = await make();
  await queue.getPendingTo('a@example.com', 100);
  expect(client.queries.at(-1).queryText).toContain('recipient_results IS NULL');
  await queue.update({ uuid: 'u' }, { appendMailOption: {} });
  expect(client.queries.at(-1).queryText).toContain('recipient_results IS NULL');
});

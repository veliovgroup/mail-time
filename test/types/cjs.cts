import mailTime = require('mail-time');
import type { RedisClusterType } from 'redis';

const pg = new mailTime.PostgresQueue({
  client: {
    async query(_queryText: string, _values?: unknown[]) {
      return {
        rows: [],
        rowCount: 0
      };
    }
  },
  prefix: 'types'
});

const client = new mailTime.MailTime({
  type: 'client',
  queue: pg,
  renewClaim: false,
  maxRenewals: 0,
  strictPayload: true,
  allowedMailFields: ['attachments']
});

const resolvedFrom: string | undefined = mailTime.MailTime.transportFrom({
  options: { from: 'noreply@example.com' }
});
void resolvedFrom;

client.ping();
void client.pause();
void client.resume();
void client.isPaused;

client.ping().then((result) => {
  const paused: boolean | undefined = result.paused;
  void paused;
});

void mailTime.MongoQueue;
void mailTime.RedisQueue;
declare const nodeRedisCluster: RedisClusterType;
void new mailTime.RedisQueue({ client: nodeRedisCluster, useHashTags: true });

const marketingPreset = mailTime.mailTimePreset('marketing');
void marketingPreset;
void mailTime.presets.newsletter;
void mailTime.presetNames;

type PolicyTypes = [
  mailTime.MailTimeMailbox, mailTime.MailTimeRecipientPolicy, mailTime.MailTimePolicyRecipient,
  mailTime.MailTimePolicyDecision, mailTime.MailTimePolicyResult, mailTime.MailTimePolicyContext,
  mailTime.MailTimeBeforeSendPolicyContext, mailTime.MailTimeRejectionPolicyContext,
  mailTime.MailTimeStructuredRejection, mailTime.MailTimeRecipientAttemptContext,
  mailTime.MailTimeRecipientResult, mailTime.MailTimeRecipientSummary,
  mailTime.MailTimePolicyTransport, mailTime.MailTimePolicyEnvelope,
];
declare const policyTypes: PolicyTypes;
void policyTypes;
const policy: mailTime.MailTimeRecipientPolicy = {
  name: 'cjs',
  beforeSend(context) {
    return { decisions: context.recipients.map(({ address }) => ({ address, status: 'suppressed', reason: 'blocked' })) };
  },
};
const policyOptions: mailTime.MailTimeOptions = {
  type: 'client', queue: pg, recipientPolicies: [policy],
  onSent(task, info, recipients, summary) { void task; void info; void recipients; void summary; },
  onError(error, task, info, recipients, summary) { void error; void task; void info; void recipients; void summary; },
  onSuppressed(task, recipients, summary) { void task; void recipients; void summary; },
  onRejected(task, recipients, summary) { void task; void recipients; void summary; },
};
void policyOptions;
// @ts-expect-error internal writer is not public
client.___completePolicyTask;

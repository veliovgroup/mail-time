import { MailTime, MongoQueue, type MailTimeOptions, type MailTimeRecipientPolicy, type MailTimeRecipientResult, type MailTimeScheduler } from 'meteor/ostrio:mailer';

declare const queue: MongoQueue;

const policy: MailTimeRecipientPolicy = {
  name: 'suppression',
  beforeSend({ recipients }) {
    return { decisions: recipients.map(({ address }) => ({ address, status: 'suppressed', reason: 'unsubscribed' })) };
  },
};

const options: MailTimeOptions = {
  type: 'client',
  queue,
  recipientPolicies: [policy],
  onSuppressed(task, recipients, summary) {
    const result: MailTimeRecipientResult = recipients[0];
    void [task.uuid, result.address, summary.isSettled];
  },
};

const mailTime = new MailTime(options);
type IsAny<T> = 0 extends (1 & T) ? true : false;
const shutdownIsTyped: false = false as IsAny<MailTimeScheduler['shutdown']>;
void shutdownIsTyped;
if (mailTime.scheduler) void mailTime.scheduler.shutdown({ timeout: 10000 });

// @ts-expect-error a provider cannot return an unknown decision status
const invalid: MailTimeRecipientPolicy = { name: 'invalid', beforeSend: () => ({ decisions: [{ address: 'a@example.com', status: 'sent', reason: 'not a policy decision' }] }) };
void invalid;
// @ts-expect-error the claim lifecycle is internal
mailTime.___sendWithRecipientPolicies;

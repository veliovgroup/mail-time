import mailTime = require('mail-time');

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

const marketingPreset = mailTime.mailTimePreset('marketing');
void marketingPreset;
void mailTime.presets.newsletter;
void mailTime.presetNames;

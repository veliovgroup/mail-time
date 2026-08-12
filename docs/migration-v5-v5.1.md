# Redis Cluster migration

MailTime 5.1 adds opt-in Redis Cluster support. Cluster queues use tagged keys and a different storage model:

```text
mailtime:{prefix}:letters
mailtime:{prefix}:schedule
mailtime:{prefix}:concatletter:<to>
mailtime:{prefix}:concatkeys
```

Enable both queue and scheduler settings:

```js
queue: new RedisQueue({ client, useHashTags: true }),
josk: { adapter: { type: 'redis', client, useHashTags: true } },
```

## Cutover

1. Stop queue producers. Let workers finish, or stop workers after SMTP sends drain.
2. Back up source Redis. Run migration before starting tagged workers:

```sh
node node_modules/mail-time/scripts/migrate-redis-queue-to-cluster.mjs \
  --source redis://standalone:6379 \
  --target redis://cluster-node:7000 \
  --prefix transactional \
  --sending-timeout 300000
```

From a git checkout the same file lives at `scripts/migrate-redis-queue-to-cluster.mjs`.

3. Start all clients and workers with both `useHashTags` settings enabled.
4. Verify `mailtime:{transactional}:letters` and `mailtime:{transactional}:schedule`, then resume producers.

`concatkeys` is an internal expiry-indexed sorted set used to safely clear tracked concat pointers during removal, completion, or migration overwrite. Migration refuses non-empty tagged task, schedule, or pointer-index keys. Pass `--overwrite` only when replacing target queue is intentional. It preserves task JSON, schedules idle tasks at `sendAt`, schedules in-flight tasks at `sendingAt + sendingTimeout`, and preserves concat-pointer TTLs.

Rollback before producers resume: stop tagged workers, restore source Redis, then deploy without `useHashTags`. There is no dual-read mode.

One prefix occupies one Redis Cluster slot. Shard high-volume mail classes across distinct prefixes. Use writable primaries only. Replica reads and active-active Redis or KeyDB are unsafe for queue claims.

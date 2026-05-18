# Dedicated mail host — several servers on one machine

On a **single mail VM** (good rDNS / PTR, fixed SMTP credentials), run **2–8 `server` processes** (~one per CPU core). Typical layout: **one process per email class** (`otp`, `transactional`, `marketing`) — each with its own `prefix`. That parallelizes drains across classes.

Extra processes with the **same** `prefix` only add **failover** (one JoSk lease winner per tick), not multiplied throughput. For very high volume on a single class, shard with different prefixes (`marketing-0`, `marketing-1`, …) and one systemd instance per shard.

This is **not** the same as scaling app pods on one queue: each `prefix` still has **one cluster-wide drain tick** at a time.

## Worker entry point

```js
// mail-worker.js — one process per class
import { otpMail, transactionalMail, marketingMail } from './mail-instances.js';

const workers = [otpMail, transactionalMail, marketingMail];
await Promise.all(workers.map((m) => m.ready()));

process.on('SIGTERM', () => {
  for (const m of workers) m.destroy();
});
```

## systemd unit (templated)

Run each class as its own unit. Adjust paths and env to your deploy.

`/etc/systemd/system/mailtime@.service`:

```ini
[Unit]
Description=MailTime server (%i)
After=network-online.target redis.service
Wants=network-online.target

[Service]
Type=simple
Environment=NODE_ENV=production
Environment=REDIS_URL=redis://127.0.0.1:6379
Environment=MAILTIME_CLASS=%i
ExecStart=/usr/bin/node /opt/mailtime/worker.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

`/opt/mailtime/worker.js` — one class per invocation (`otp`, `transactional`, `marketing`):

```js
import { startMailWorker } from './mail-instances.js';

const mailClass = process.env.MAILTIME_CLASS;
if (!mailClass) {
  throw new Error('MAILTIME_CLASS required (otp | transactional | marketing)');
}

const mailTime = await startMailWorker(mailClass);
process.on('SIGTERM', () => {
  mailTime.destroy();
  process.exit(0);
});
```

Enable and start:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now mailtime@otp mailtime@transactional mailtime@marketing
```

Optional **second unit on the same class** for hot standby (same `prefix`, different `lockOwnerId`) — only one drains per tick; the other takes over if the primary dies.

## See also

- [docs/multi-instance.md](./multi-instance.md) — wiring one `MailTime` per email class.
- [docs/tuning.md](./tuning.md) — throughput levers and tuning knobs.
- [Settings presets](../README.md#settings-presets) — the preset table.

# Recipient policies

`recipientPolicies` is optional. It lets application-owned providers suppress recipients before SMTP and classify attributable transport rejections. MailTime supplies no suppression store and never assumes every SMTP 5xx response is permanent. Clients can enqueue without configuring providers; every server on the same `prefix` must use the same policies.

## Provider hooks

Each plain-object provider needs a unique, nonblank `name` of at most 128 characters and at least one hook. Hooks run sequentially in declared order with the complete pending batch. They can return a Promise.

| Hook | Returns | Input |
| --- | --- | --- |
| `beforeSend(context)` | `{ decisions: [{ address, status: 'suppressed', reason }] }` or nothing | Pending recipients before each SMTP attempt |
| `classifyRejections(context)` | Decisions with `status: 'rejected'` or `'retry'`, or nothing | Unresolved recipients after SMTP; permanent rejection requires an attributable record |
| `observeAttempt(context)` | Nothing | Classified results after an attempt with unresolved recipients |

Contexts contain `task`, `attempt`, `transport: { index, name? }`, `envelope: { from?, to }`, and normalized `recipients: [{ address, sources }]`. Classification and observation also receive raw `error` and `info` plus normalized `rejections`; observation receives merged recipient results in `decisions`. Treat contexts as read-only. Decisions require a nonblank reason of at most 512 characters. Unknown addresses, invalid statuses, malformed results, and conflicting duplicate decisions invalidate that provider's whole invocation.

`failureMode: 'retry'` (default) blocks SMTP on a pre-send provider failure. After SMTP it keeps unresolved recipients retryable but never reverses acceptance. `failureMode: 'continue'` logs and discards that provider's failed invocation. Other providers still run. Suppression wins over abstention before SMTP; permanent rejection wins over retry after SMTP. Observation failures only log. Providers must impose their own I/O deadlines; lease renewal limits do not time out hooks.

For a transport-specific classifier, inspect the normalized rejection records instead of guessing from response codes:

```js
const classifyRejections = ({ rejections }) => ({
  decisions: rejections
    .filter(({ address, responseCode }) => address && responseCode === 550)
    .map(({ address }) => ({ address, status: 'rejected', reason: 'mailbox unavailable' })),
});
```

This rule is only an example of an application policy, not a MailTime default. An SMTP server may use code 550 for other reasons.

## Envelope, headers, and privacy

A compiled `envelope.to` is authoritative. Otherwise MailTime derives recipients from `to`, `cc`, and `bcc`. It trims and lowercases addresses, deduplicates them, and filters the explicit SMTP envelope before sending. It rewrites a display header only to quote a name that contains an unquoted `@`, `[`, `]`, `\`, `(` or `)`, so `John (Sales) <x@y.com>` is sent as `"John (Sales)" <x@y.com>`; stored `mailOptions` keep the original. Each entry must hold exactly one mailbox: `user@example.com`, `<user@example.com>`, `Name <user@example.com>`, a display name with quoted parts such as `"Doe, John" <user@example.com>` or `"A \"B\" C" <user@example.com>`, or `{ address, name? }`. Use an array for several recipients. The envelope sender comes from `envelope.from`, else `from`, `sender`, or `replyTo` (Nodemailer's order), and follows the same rules. MailTime rejects comma-separated address lists, groups (`Team: a@example.com;`), comments outside a display name, quoted local parts, an unquoted `<`, `>`, `,`, `:` or `;` in a display name, text after the closing `>`, and any line break or NUL character.

A rejected address fails the task on its current attempt without SMTP and without spending the remaining retries. The error has `code: 'MAIL_TIME_INVALID_ADDRESS'` and a `field` such as `from`, `to[1]`, or `envelope.to`. Its message names the field and the broken rule but never the address or display name. MailTime logs it with the task `uuid` and passes it to `onError`; the recipient group is empty unless an earlier attempt prepared recipients. Header `to`, `cc`, and `bcc` are not validated when an explicit `envelope.to` is present. An empty envelope consumes an attempt without SMTP and follows retry/failover rules. With `strictPayload`, queued `envelope` is dropped by default; use trusted transport `options.mailOptions.envelope` for complex headers.

**Suppression prevents SMTP delivery to an address; it does not redact headers or body.** Most Nodemailer SMTP transports remove BCC from MIME, but Nodemailer's stream transport retains BCC (`keepBcc`). A suppressed BCC can therefore remain in generated MIME. Remove sensitive addresses from headers and content before enqueueing if the message is forwarded, stored, or rendered elsewhere.

The recipient set is fixed after first preparation. Changed transport-default recipients on retry fail closed while any recipient is pending. Once a task has policy state, concatenated mail creates a separate task, including when the enqueue client has no providers.

## Persisted outcomes and callbacks

`recipientResults` stores one result per normalized address: `status` (`sent`, `error`, `suppressed`, or `rejected`), sources, provider/reason pairs, last attempt/transport identifiers, and scalar rejection diagnostics. Responses and messages are capped at 2,048 characters; MailTime does not persist raw transport errors or arbitrary provider metadata. Sent, suppressed, and rejected recipients do not retry. The remaining recipients are checked by `beforeSend` again on every attempt.

After terminal storage succeeds, MailTime calls nonempty groups in this order:

1. `onSent(task, info, recipients, summary)` for SMTP acceptance.
2. `onError(error, task, info, recipients, summary)` for exhausted pending errors.
3. `onSuppressed(task, recipients, summary)` for suppression.
4. `onRejected(task, recipients, summary)` for permanent rejection.

`summary` contains `uuid`, `tries`, `isSettled`, and `recipients: { sent, error, suppressed, rejected }`. `info` describes only the terminal SMTP attempt; the summary describes all attempts. Callback failures are isolated. Transport verification still reports `onError(error, null, details)`. A preparation failure with no known recipients, such as an invalid address, calls `onError` with an empty recipient group.

With `keepHistory`, `isSettled` marks terminal completion, including exhausted attempts; `isSent` means every recipient was accepted, and `isFailed` means an error or permanent rejection. A fully suppressed or sent-plus-suppressed task is settled but neither sent nor failed. Without history, terminal rows are removed. Callbacks are best-effort: a crash after storage completion may lose a notification.

## Recovery and rollout

SMTP acceptance is checkpointed before slow classifiers run. Lease renewal covers policy and observation work and continues during `destroy({ drain: true })`. A stale claim with only durable terminal results completes without another SMTP send or attempt, even if the retry budget remains; pending errors retry normally. A stale final-attempt claim completes from durable results without rerunning SMTP or provider hooks. SMTP acceptance just before a failed persistence write remains inherently ambiguous and may produce a duplicate delivery after recovery.

Deploy this version to **every server on a prefix with policies disabled first**. Verify versions, then enable the same policies on every server. Custom queues must declare `supportsRecipientPolicies = true` and implement the [recipient-policy queue contract](./queue-api.md#recipient-policy-capability). Do not disable policies or downgrade while policy state remains. Before a downgrade, stop and drain workers, then archive, remove, or isolate settled policy history as well: older readers cannot recognize a fully suppressed row.

Schema changes are additive. MongoDB adds `mailtime_policy_due_v1` and `mailtime_policy_pending_to_v1` indexes; PostgreSQL adds `is_settled`, `recipient_results`, and `idx_mail_time_queue_policy_due_v1` / `idx_mail_time_queue_policy_pending_to_v1`. Old indexes remain through rolling upgrades. After all old servers are gone, inspect them and remove only superseded due/pending indexes during maintenance, not UUID or new policy indexes.

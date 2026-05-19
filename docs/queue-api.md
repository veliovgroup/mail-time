# MailTime Custom Queue API

MailTime library supports 3rd party Queue drivers. By default MailTime ships with MongoDB, Redis, and PostgreSQL support (official `mongodb`, `redis`, and `pg` NPM drivers). This document is intended for developers of custom 3rd party "MailTime Queue Drivers".

## Create a new Queue

Start with copy of Queue's boilerplate [`blank-example.js`](https://github.com/veliovgroup/mail-time/blob/master/adapters/blank-example.js).

## Queue Class API

List of required methods and their arguments.

- `new Queue(opts)` constructor
  - `{object} opts`
  - `{string} [opts.prefix]` — optional prefix for scope isolation; use when creating multiple MailTime instances within the single application
  - `{mix} [opts.other]` — other options required for specific storage type
- async `Queue#ready() — {Promise<void 0>}` — optional; MailTime awaits it before first `ping()`
- async `Queue#ping() — {Promise<object>}`
- async `Queue#iterate(opts) — {Promise<void 0>}`
  - `{object} [opts]` — iteration options provided by MailTime
  - `{number} [opts.limit]` — when set (e.g. by `mode: 'one'`), stop after dispatching that many tasks per tick
  - `{number} [opts.sendingTimeout]` — milliseconds after which an `isSending=true` row is considered a zombie and becomes eligible again
- async `Queue#getPendingTo(to, sendAt) — {Promise<object|null>}`
  - `{string} to` — email address from `to` field
  - `{number} sendAt` — timestamp
  - Must exclude rows with `isSending === true` (concat must not mutate in-flight letters)
- async `Queue#push(email) — {Promise<void 0>}`
  - `{object} email` — task object (see structure below). Persist `isSending` and `sendingAt` along with the other fields.
- async `Queue#cancel(uuid) — {Promise<boolean>}`
  - `{string} uuid` — email's uuid
- async `Queue#remove(email, opts) — {Promise<boolean>}`
  - `{object} email` — email's object
  - `{object} [opts]` — optional lease guard. When `{ leaseTries: Number, leaseSendingAt: Number }` is passed, the delete **must succeed only if** the stored row still satisfies `tries === leaseTries AND isSending === true AND sendingAt === leaseSendingAt AND isCancelled === false AND isFailed === false`.
- async `Queue#update(email, updateObj) — {Promise<boolean>}`
  - `{object} email` — email's object (*see its structure below*)
  - `{object} updateObj` — fields with new values to update
  - **Atomic claim guard.** When `updateObj` contains `{ isSending: true, sendingAt: Number, tries: Number }`, MailTime is *claiming* a row for sending. This update **must be atomic** and must succeed only if all of the following hold for the stored row:
    - `isSent === false`
    - `isFailed === false`
    - `isCancelled === false`
    - `tries === email.tries` (caller's snapshot value, **before** the bump — this is the compare-and-set; do not predicate on `tries < maxTries`)
    - `isSending === false` **OR** `sendingAt <= now - sendingTimeout` (stale-lock recovery)
  - Use `updateObj.sendingAt` (fall back to `Date.now()`) as the `now` reference for the stale-lock arm. When the predicate fails, return `false` so the racing worker (in this process or another node) drops the row and JoSk picks up something else on the next tick. Return `true` only when the storage layer atomically flipped `isSending` to `true`.
  - **Lease release guard.** When `updateObj` contains `{ leaseTries: Number, leaseSendingAt: Number, ... }` (MailTime-internal keys stripped before persist), the update **must succeed only if** the stored row still holds that worker's lease: `tries === leaseTries AND isSending === true AND sendingAt === leaseSendingAt AND isCancelled === false AND isFailed === false`. Same predicate applies to `remove(email, { leaseTries, leaseSendingAt })`. When the guard fails, return `false` so a late SMTP callback from a superseded worker cannot complete or delete a row that another worker finalized or a user has since cancelled.
  - **Atomic concat append.** When `updateObj` contains `{ appendMailOption: object }`, atomically append one element to `mailOptions` only if the row is not in-flight (`isSending === false`) and not terminal.

## Iterate predicate

`iterate(opts)` must enumerate rows where every condition below is true:

- `isSent === false`
- `isFailed === false`
- `isCancelled === false`
- `sendAt <= now`
- `tries < mailTimeInstance.maxTries`
- `isSending === false` **OR** `sendingAt <= now - opts.sendingTimeout`

For each matching row, call `await this.mailTimeInstance.___dispatch(email)`. `___dispatch` performs the atomic claim, then hands the SMTP roundtrip off to MailTime's in-process worker pool (bounded by `concurrency`). It resolves as soon as the pool slot is acquired — **not** after the SMTP completes — which lets your `iterate` move on to the next due row and lets the surrounding JoSk lease be released quickly.

If `opts.limit` is provided (MailTime sends `1` when `mode: 'one'`), stop the scan after that many dispatches.

## Task object

In order to process and send emails, `Queue#iterate` must call `await this.mailTimeInstance.___dispatch(email)` for each due row. The passed email object is expected to have the following structure:

```js
({
  uuid: String,         // unique task ID
  to: String,           // optional; primary recipient (used for `concatEmails`)
  tries: Number,        // count of completed send attempts
  sendAt: Number,       // timestamp the row becomes due
  isSent: Boolean,      // true only when delivery is confirmed
  isCancelled: Boolean, // true when the user cancelled the row
  isFailed: Boolean,    // true after `maxTries` attempts have all failed
  isSending: Boolean,   // true while a worker is performing the SMTP roundtrip
  sendingAt: Number,    // timestamp when `isSending` was set; older than `now - sendingTimeout` means the row is recoverable
  template: String,
  transport: Number,
  concatSubject: String,
  mailOptions: [{
    to: String,
    from: String,
    text: String,
    html: String,
    subject: String,
    accepted: [String],
    rejected: [{ address: String, error: String }],
    // and other nodemailer `sendMail` options
    // or values for template placeholders
  }]
})
```

`isSending` + `sendingAt` are the two new fields that together act as a per-row lease. They replace the previous practice of re-purposing `isSent` as both an "in-flight" flag and a "delivered" flag.

For inspiration take a look at the [MongoDB, Redis, and PostgreSQL Queue implementations](https://github.com/veliovgroup/mail-time/tree/master/adapters).

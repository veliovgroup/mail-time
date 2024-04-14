# MailTime Custom Queue API

MailTime library supports 3rd party Queue drivers. By default MailTime shipped with MongoDB and Redis support (official `mongodb` and `redis` NPM drivers). This document intended for developers of custom 3rd party "MailTime Queue Drivers".

## Create a new Queue

Start with copy of Queue's boilerplate [`blank-queue.js`](https://github.com/veliovgroup/mail-time/blob/master/adapters/blank-example.js).

## Queue Class API

List of required methods and its arguments

- `new Queue(opts)` constructor
  - `{object} opts`
  - `{string} [opts.prefix]` — optional prefix for scope isolation; use when creating multiple MailTime instances within the single application
  - `{mix} [opts.other]` - other options required for specific storage type
- async `Queue#ping() - {Promise<object>}`
- async `Queue#iterate() - {Promise<void 0>}`
- async `Queue#getPendingTo(to, sendAt) - {Promise<object|null>}`
  - `{string} to` - Email address from `to` field
  - `{number} sendAt` - Timestamp
- async `Queue#push(email) - {Promise<void 0>}`
  - `{object} email` - Unique ID of the task
- async `Queue#cancel(uuid) - {Promise<boolean>}`
  - `{string} uuid` - Email's uuid
- async `Queue#remove(email) - {Promise<boolean>}`
  - `{object} email` - Email's object
- async `Queue#update(email, updateObj) - {Promise<boolean>}`
  - `{object} email` - Email's object (*see its structure below*)
  - `{object} updateObj` - Fields with new values to update

### Task object

In order to process and send emails, "Queue" must call `this.mailTimeInstance.___send(email)` method inside `Queue#iterate` method, passed email's object is expected to have the next structure:

```js
({
  uuid: String, // unique task's ID
  to: String,
  tries: Number,
  sendAt: Number,
  isSent: Boolean,
  isCancelled: Boolean,
  isFailed: Boolean,
  template: String,
  transport: Number,
  concatSubject: String,
  mailOptions: [{
    to: String,
    from: String,
    text: String,
    html: String,
    subject: String,
    // and other nodeMailer `sendMail` options...
    // or values for template placeholders
  }]
})
```

For inspiration take a look on [MongoDB and Redis Queue implementations](https://github.com/veliovgroup/mail-time/tree/master/adapters).

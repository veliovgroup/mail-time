import { afterEach, describe, expect, it, jest } from '@jest/globals';
import nodemailer from 'nodemailer';
import { normalizePolicyAddress, preparePolicyEnvelope, rewritePolicyHeaders } from '../../recipient-policy.js';
import { createPolicyMailTime } from './recipient-policy-helpers.js';

const instances = [];
const make = (opts = {}) => { const m = createPolicyMailTime(opts); instances.push(m); return m; };
const attempt = (m, uuid) => m.___send(structuredClone(m.queue.records.get(uuid)));
afterEach(async () => {
  jest.restoreAllMocks();
  for (const m of instances.splice(0)) await m.destroy({ drain: true });
});

const expectAddressError = (fn, field, secrets = []) => {
  let caught;
  try { fn(); } catch (error) { caught = error; }
  expect(caught).toBeInstanceOf(Error);
  expect(caught.code).toBe('MAIL_TIME_INVALID_ADDRESS');
  expect(caught.field).toBe(field);
  expect(caught.message).toContain('[mail-time] [recipientPolicies]');
  expect(caught.message).toContain(`\`${field}\``);
  for (const secret of secrets) expect(caught.message).not.toContain(secret);
  return caught;
};

describe('display-name mailboxes', () => {
  it.each([
    ['"ostr.io" <no-reply@ostr.io>', 'no-reply@ostr.io'],
    ['ostr.io <no-reply@ostr.io>', 'no-reply@ostr.io'],
    ['"Doe, John" <John.Doe@Example.com>', 'john.doe@example.com'],
    ['"A \\"quoted\\" name" <a@example.com>', 'a@example.com'],
    ['"back\\\\slash; semi: colon (paren) <angle> @" <a@example.com>', 'a@example.com'],
    ['"Given" Family <a@example.com>', 'a@example.com'],
    ['O\'Brien <a@example.com>', 'a@example.com'],
    ['Имя Фамилия <a@example.com>', 'a@example.com'],
    ['""<a@example.com>', 'a@example.com'],
    ['a@example.com <b@example.com>', 'b@example.com'],
    ['Back\\slash <a@example.com>', 'a@example.com'],
    ['[bracket] <a@example.com>', 'a@example.com'],
    ['John (Sales) <a@example.com>', 'a@example.com'],
    ['a( <a@example.com>', 'a@example.com'],
    ['a (b <a@example.com>', 'a@example.com'],
    ['@lead <a@example.com>', 'a@example.com'],
    ['  <a@example.com>  ', 'a@example.com'],
    ['a@example.com', 'a@example.com'],
    [{ name: 'Doe, "John"', address: 'a@example.com' }, 'a@example.com'],
    [{ address: ' A@Example.com ' }, 'a@example.com'],
    [Object.assign(Object.create(null), { name: 'Null Proto', address: 'a@example.com' }), 'a@example.com'],
  ])('parses %j', (value, address) => {
    expect(normalizePolicyAddress(value)).toBe(address);
  });

  it.each([
    ['a@example.com, b@example.com', 'list'],
    ['Team: a@example.com;', 'group'],
    ['a@example.com (comment)', 'comment'],
    ['"unterminated <a@example.com>', 'quote'],
    ['"trailing escape\\', 'quote'],
    ['A <a@example.com> B', 'trailing'],
    ['A <a@example.com> B <b@example.com>', 'two angles'],
    ['Doe, John <a@example.com>', 'unquoted comma'],
    ['A > B <a@example.com>', 'unquoted >'],
    ['a (b <c@example.com>) <a@example.com>', 'comment containing <'],
    ['a (b, c) <a@example.com>', 'comment containing ,'],
    ['John <a@example.com> (Sales)', 'trailing comment'],
    ['(c) a@example.com', 'comment on a bare address'],
    ['a <<a@example.com>>', 'nested angle'],
    ['<a@example.com', 'unclosed angle'],
    ['<>', 'empty angle'],
    ['"a b"@example.com', 'quoted local part'],
    ['', 'empty'],
    ['   ', 'blank'],
    ['a@example.com\r\n', 'CRLF'],
    ['"x\r\nBcc: evil@example.com" <a@example.com>', 'CRLF in quoted name'],
    ['x\nBcc: evil@example.com <a@example.com>', 'LF in name'],
    ['a@example.com\u0000', 'NUL'],
    [{ name: 'x\r\nBcc: evil@example.com', address: 'a@example.com' }, 'CRLF in object name'],
    [{ name: 42, address: 'a@example.com' }, 'non-string name'],
    [{ address: 'Name <a@example.com>' }, 'object address with display name'],
    [{}, 'object without address'],
    [['a@example.com'], 'nested array'],
    [null, 'null'],
  ])('rejects %j (%s) with a field-scoped error', (value) => {
    expectAddressError(() => normalizePolicyAddress(value, 'to'), 'to', ['evil@example.com', 'a@example.com']);
  });

  it('defaults the field label to `address`', () => {
    expectAddressError(() => normalizePolicyAddress('a@example.com, b@example.com'), 'address');
  });
});

describe('envelope preparation with display names', () => {
  it('derives the envelope sender from a quoted `from` display name', () => {
    expect(preparePolicyEnvelope({ from: '"ostr.io" <no-reply@ostr.io>', to: 'user@example.com' })).toEqual({
      envelope: { from: 'no-reply@ostr.io', to: ['user@example.com'] },
      recipients: [{ address: 'user@example.com', sources: ['to'] }],
    });
  });

  it('preserves recipient identity and sources across quoted to/cc/bcc forms', () => {
    const input = {
      from: { name: 'Sender, Inc.', address: 'sender@example.com' },
      to: ['"Doe, John" <John@Example.com>', 'plain@example.com'],
      cc: '"A \\"B\\" C" <plain@example.com>',
      bcc: { name: 'Hidden', address: 'hidden@example.com' },
    };
    const copy = structuredClone(input);
    expect(preparePolicyEnvelope(input)).toEqual({
      envelope: { from: 'sender@example.com', to: ['john@example.com', 'plain@example.com', 'hidden@example.com'] },
      recipients: [
        { address: 'john@example.com', sources: ['to'] },
        { address: 'plain@example.com', sources: ['to', 'cc'] },
        { address: 'hidden@example.com', sources: ['bcc'] },
      ],
    });
    expect(input).toEqual(copy);
  });

  it('accepts display names in explicit envelope overrides', () => {
    expect(preparePolicyEnvelope({ to: 'Complex: header@example.com;', envelope: { from: '"Bounce" <bounce@example.com>', to: ['"Doe, John" <actual@example.com>'] } })).toEqual({
      envelope: { from: 'bounce@example.com', to: ['actual@example.com'] },
      recipients: [{ address: 'actual@example.com', sources: ['envelope'] }],
    });
  });

  it.each([
    [{ from: 'Sender <s@example.com> trailing', to: 'a@example.com' }, 'from'],
    [{ sender: 'a@example.com, b@example.com', to: 'a@example.com' }, 'sender'],
    [{ replyTo: 'Team: r@example.com;', to: 'a@example.com' }, 'replyTo'],
    [{ from: 's@example.com', to: 'a@example.com', envelope: { from: 'x <y', to: ['a@example.com'] } }, 'envelope.from'],
    [{ to: 'a@example.com', envelope: { to: ['a@example.com', 'b@example.com, c@example.com'] } }, 'envelope.to[1]'],
    [{ to: 'a@example.com', envelope: { to: 'secret@example.com\r\nBcc: evil@example.com' } }, 'envelope.to'],
    [{ to: ['a@example.com', '"unterminated <b@example.com>'] }, 'to[1]'],
    [{ to: 'a@example.com', cc: 'x\r\nBcc: evil@example.com' }, 'cc'],
    [{ to: 'a@example.com', bcc: [{ name: 'n' }] }, 'bcc[0]'],
  ])('names the offending field in %j', (input, field) => {
    expectAddressError(() => preparePolicyEnvelope(input), field, ['secret@example.com', 'evil@example.com', 'b@example.com']);
  });

  it('never blames envelope.to for a sender problem', () => {
    const error = expectAddressError(() => preparePolicyEnvelope({ from: 'a@example.com, b@example.com', to: 'user@example.com' }), 'from');
    expect(error.message).not.toContain('envelope.to');
  });
});

describe('Nodemailer delivery with display names', () => {
  const streamTransport = () => {
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    const sent = [];
    return {
      sent,
      close: () => transport.close(),
      wrap: (accept = (envelope) => envelope.to) => ({ sendMail(mail, done) {
        transport.sendMail(mail, (error, info) => {
          if (info) sent.push({ envelope: info.envelope, messageId: info.messageId, message: info.message.toString() });
          done(error, info ? { ...info, accepted: accept(info.envelope, sent.length) } : info);
        });
      } }),
    };
  };

  it('delivers the reported `"ostr.io" <no-reply@ostr.io>` sender and quoted recipients with headers intact', async () => {
    const stream = streamTransport();
    const onSent = jest.fn();
    const onError = jest.fn();
    const m = make({ retries: 3, transports: [stream.wrap()], from: () => '"ostr.io" <no-reply@ostr.io>', onSent, onError });
    try {
      const uuid = await m.sendMail({
        to: '"Doe, John" <john@example.com>',
        cc: ['"A \\"B\\" C" <abc@example.com>', { name: 'Obj, Name', address: 'obj@example.com' }],
        bcc: 'hidden@example.com',
        subject: 'hi', text: 'hello',
      });
      await attempt(m, uuid);
      expect(stream.sent).toHaveLength(1);
      const [{ envelope, messageId, message }] = stream.sent;
      expect(envelope).toEqual({ from: 'no-reply@ostr.io', to: ['john@example.com', 'abc@example.com', 'obj@example.com', 'hidden@example.com'] });
      expect(message).toMatch(/^From: "ostr.io" <no-reply@ostr.io>$/m);
      expect(message).toMatch(/^To: "Doe, John" <john@example.com>$/m);
      expect(message).toMatch(/^Cc: "A \\"B\\" C" <abc@example.com>, "Obj, Name" <obj@example.com>$/m);
      expect(messageId).toMatch(/@ostr\.io>$/);
      expect(onError).not.toHaveBeenCalled();
      expect(onSent).toHaveBeenCalledTimes(1);
      expect(onSent.mock.calls[0][2].map((r) => r.address)).toEqual(['john@example.com', 'abc@example.com', 'obj@example.com', 'hidden@example.com']);
      expect(m.queue.records.get(uuid)).toMatchObject({ tries: 1, isSettled: true, isSent: true, isFailed: false, isSending: false });
    } finally { stream.close(); }
  });

  it('retries only unaccepted quoted recipients and keeps a caller Message-ID stable', async () => {
    const stream = streamTransport();
    const accept = (envelope, n) => (n === 1 ? ['john@example.com'] : envelope.to);
    const m = make({ retries: 3, transports: [stream.wrap(accept)], from: () => '"ostr.io" <no-reply@ostr.io>' });
    try {
      const uuid = await m.sendMail({ to: ['"Doe, John" <john@example.com>', '"Roe, Jane" <jane@example.com>'], messageId: '<fixed-1@ostr.io>', text: 'hello' });
      await attempt(m, uuid);
      expect(m.queue.records.get(uuid)).toMatchObject({ tries: 1, isSettled: false, isSending: false });
      await attempt(m, uuid);
      expect(stream.sent.map((s) => s.envelope.to)).toEqual([['john@example.com', 'jane@example.com'], ['jane@example.com']]);
      expect(stream.sent.map((s) => s.messageId)).toEqual(['<fixed-1@ostr.io>', '<fixed-1@ostr.io>']);
      for (const { message } of stream.sent) expect(message).toMatch(/^Message-ID: <fixed-1@ostr.io>$/m);
      expect(m.queue.records.get(uuid)).toMatchObject({ tries: 2, isSettled: true, isSent: true, isFailed: false });
      expect(m.queue.records.get(uuid).recipientResults.map((r) => [r.address, r.status, r.attempt])).toEqual([['john@example.com', 'sent', 1], ['jane@example.com', 'sent', 2]]);
    } finally { stream.close(); }
  });

  it('honors an explicit envelope while keeping quoted header presentation', async () => {
    const stream = streamTransport();
    const m = make({ transports: [stream.wrap()], from: () => '"ostr.io" <no-reply@ostr.io>' });
    try {
      const uuid = await m.sendMail({ to: '"Doe, John" <header@example.com>', envelope: { from: '"Bounce" <bounce@ostr.io>', to: ['"Real, Rcpt" <real@example.com>'] }, text: 'hello' });
      await attempt(m, uuid);
      expect(stream.sent[0].envelope).toEqual({ from: 'bounce@ostr.io', to: ['real@example.com'] });
      expect(stream.sent[0].message).toMatch(/^To: "Doe, John" <header@example.com>$/m);
      expect(m.queue.records.get(uuid)).toMatchObject({ isSettled: true, isSent: true });
    } finally { stream.close(); }
  });
});

describe('address parse failures', () => {
  it.each([
    [{ from: () => '"ostr.io" <no-reply@ostr.io> trailing' }, { to: 'user@example.com' }, 'from'],
    [{}, { to: ['ok@example.com', 'Doe, John <secret@example.com>'] }, 'to[1]'],
    [{}, { to: 'ok@example.com', envelope: { to: ['secret@example.com\r\nBcc: evil@example.com'] } }, 'envelope.to[0]'],
  ])('fail on the first attempt with an actionable diagnostic instead of consuming retries (%#)', async (opts, mail, field) => {
    const sendMail = jest.fn((mail, done) => done(null, { accepted: mail.envelope.to }));
    const onError = jest.fn();
    const logged = [];
    jest.spyOn(console, 'error').mockImplementation((...args) => { logged.push(args.map((a) => (a instanceof Error ? a.message : String(a))).join(' ')); });
    const m = make({ retries: 5, transports: [{ sendMail }], onError, ...opts });
    const uuid = await m.sendMail({ ...mail, text: 'hello' });
    await attempt(m, uuid);
    expect(sendMail).not.toHaveBeenCalled();
    expect(m.queue.records.get(uuid)).toMatchObject({ tries: 1, isSettled: true, isFailed: true, isSent: false, isSending: false, recipientResults: [] });
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, task, , recipients] = onError.mock.calls[0];
    expect(error).toMatchObject({ code: 'MAIL_TIME_INVALID_ADDRESS', field });
    expect(task.uuid).toBe(uuid);
    expect(recipients).toEqual([]);
    const diagnostic = logged.find((line) => line.includes(`\`${field}\``));
    expect(diagnostic).toBeDefined();
    expect(diagnostic).toContain(uuid);
    for (const line of logged) {
      expect(line).not.toContain('secret@example.com');
      expect(line).not.toContain('evil@example.com');
    }
  });
});

describe('auto-quoted display names', () => {
  it.each([
    ['a@example.com <B@Example.com>', { name: 'a@example.com', address: 'B@Example.com' }],
    ['John (Sales) <a@example.com>', { name: 'John (Sales)', address: 'a@example.com' }],
    ['a( <a@example.com>', { name: 'a(', address: 'a@example.com' }],
    ['Back\\slash  [x] <a@example.com>', { name: 'Back\\slash [x]', address: 'a@example.com' }],
    ['"Doe" @home <a@example.com>', { name: 'Doe @home', address: 'a@example.com' }],
  ])('rewrites %j to a { name, address } header entry', (input, entry) => {
    expect(rewritePolicyHeaders({ to: input }).to).toEqual(entry);
  });

  it.each([
    '"Doe, John" <a@example.com>',
    'Plain Name <a@example.com>',
    '<a@example.com>',
    'a@example.com',
    'Doe, John <a@example.com>',
  ])('leaves %j unchanged', (input) => {
    expect(rewritePolicyHeaders({ to: input }).to).toBe(input);
  });

  it('rewrites every header address field and array entry without mutating the input', () => {
    const input = {
      from: 'ostr.io@web <no-reply@ostr.io>',
      sender: 'plain@example.com',
      replyTo: '[support] <help@example.com>',
      to: ['John (Sales) <john@example.com>', { name: 'Obj', address: 'obj@example.com' }, 'plain@example.com'],
      cc: 'a( <x@example.com>',
      bcc: ['@b <b@example.com>'],
      envelope: { to: ['a@b <e@example.com>'] },
      subject: 'hi',
    };
    const copy = structuredClone(input);
    expect(rewritePolicyHeaders(input)).toEqual({
      ...copy,
      from: { name: 'ostr.io@web', address: 'no-reply@ostr.io' },
      replyTo: { name: '[support]', address: 'help@example.com' },
      to: [{ name: 'John (Sales)', address: 'john@example.com' }, { name: 'Obj', address: 'obj@example.com' }, 'plain@example.com'],
      cc: { name: 'a(', address: 'x@example.com' },
      bcc: [{ name: '@b', address: 'b@example.com' }],
    });
    expect(input).toEqual(copy);
  });

  it('returns the same object when nothing needs quoting', () => {
    const input = { from: 'Sender <s@example.com>', to: ['"Doe, John" <a@example.com>'] };
    expect(rewritePolicyHeaders(input)).toBe(input);
  });
});

describe('parity with Nodemailer address parsing', () => {
  it('never accepts a mailbox whose sent header differs from the envelope address', async () => {
    const { default: addressparser } = await import('nodemailer/lib/addressparser/index.js');
    const tokens = ['"', '\\', '<', '>', ',', ';', ':', '(', ')', '@', ' ', 'a', 'x@y.com', '"Q"', '\t', '[', ']', '=?utf-8?B?YQ==?='];
    let seed = 20260929;
    const next = () => (seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    let accepted = 0;
    for (let i = 0; i < 40000; i++) {
      let input = '';
      for (let j = 1 + Math.floor(next() * 9); j > 0; j--) input += tokens[Math.floor(next() * tokens.length)];
      if (next() < 0.5) input += ' <u@d.com>';
      let address;
      try { address = normalizePolicyAddress(input, 'to'); } catch { continue; }
      accepted++;
      const sent = rewritePolicyHeaders({ to: input }).to;
      if (typeof sent === 'string') {
        const parsed = addressparser(sent, { flatten: true });
        expect({ input, count: parsed.length, address: parsed[0]?.address?.toLowerCase() }).toEqual({ input, count: 1, address });
      } else {
        expect({ input, address: sent.address.toLowerCase() }).toEqual({ input, address });
      }
    }
    expect(accepted).toBeGreaterThan(500);
  });

  it('keeps a display name that looks like an address out of the envelope', () => {
    const { envelope } = preparePolicyEnvelope({ from: '"boss@corp.com" <real@example.com>', to: '"victim@corp.com, other@corp.com" <ok@example.com>' });
    expect(envelope).toEqual({ from: 'real@example.com', to: ['ok@example.com'] });
  });

  it.each(['to', 'cc', 'bcc'])('rejects header injection in %s display names and reports that field', (field) => {
    const mail = { to: 'ok@example.com', [field]: ['fine@example.com', '"x\r\nBcc: evil@example.com" <a@example.com>'] };
    const caught = (() => { try { preparePolicyEnvelope(mail); } catch (error) { return error; } })();
    expect(caught).toMatchObject({ code: 'MAIL_TIME_INVALID_ADDRESS', field: `${field}[1]` });
    expect(caught.message).not.toContain('evil@example.com');
  });
});

describe('Nodemailer delivery with auto-quoted display names', () => {
  it('sends headers that parse back to exactly the envelope addresses and keeps stored mailOptions raw', async () => {
    const { default: addressparser } = await import('nodemailer/lib/addressparser/index.js');
    const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
    let sent;
    const m = make({ transports: [{ sendMail(mail, done) {
      transport.sendMail(mail, (error, info) => { sent = info; done(error, info ? { ...info, accepted: info.envelope.to } : info); });
    } }] });
    const mail = {
      from: 'ostr.io@web <no-reply@ostr.io>',
      replyTo: 'Back\\slash <reply@example.com>',
      to: ['John (Sales) <john@example.com>', 'a (b <x@example.com>'],
      cc: [{ name: 'Obj', address: 'obj@example.com' }, '[bracket] <c@example.com>'],
      text: 'hello',
    };
    try {
      const uuid = await m.sendMail(mail);
      await attempt(m, uuid);
      expect(sent.envelope).toEqual({ from: 'no-reply@ostr.io', to: ['john@example.com', 'x@example.com', 'obj@example.com', 'c@example.com'] });
      const message = sent.message.toString();
      const header = (name) => addressparser(message.match(new RegExp(`^${name}: (.*)$`, 'm'))[1], { flatten: true });
      expect(header('From')).toEqual([{ name: 'ostr.io@web', address: 'no-reply@ostr.io' }]);
      expect(header('Reply-To')).toEqual([{ name: 'Back\\slash', address: 'reply@example.com' }]);
      expect(header('To')).toEqual([{ name: 'John (Sales)', address: 'john@example.com' }, { name: 'a (b', address: 'x@example.com' }]);
      expect(header('Cc')).toEqual([{ name: 'Obj', address: 'obj@example.com' }, { name: '[bracket]', address: 'c@example.com' }]);
      const [stored] = m.queue.records.get(uuid).mailOptions;
      expect({ from: stored.from, replyTo: stored.replyTo, to: stored.to, cc: stored.cc }).toEqual({ from: mail.from, replyTo: mail.replyTo, to: mail.to, cc: mail.cc });
      expect(m.queue.records.get(uuid)).toMatchObject({ isSettled: true, isSent: true, isFailed: false });
    } finally { transport.close(); }
  });
});

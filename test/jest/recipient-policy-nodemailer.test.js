import { expect, it } from '@jest/globals';
import nodemailer from 'nodemailer';
import { createPolicyMailTime } from './recipient-policy-helpers.js';

it('does not reintroduce suppressed BCC into Nodemailer MIME or the SMTP envelope', async () => {
  let captured;
  const transport = nodemailer.createTransport({ name: 'mime-fixture', version: '1', send(mail, done) {
    mail.message.build((error, message) => {
      captured = { message, envelope: mail.message.getEnvelope() };
      done(error, { ...captured, accepted: captured.envelope.to });
    });
  } });
  const m = createPolicyMailTime({ transports: [transport], recipientPolicies: [{ name: 'bcc', beforeSend() {
    return { decisions: [{ address: 'hidden@example.com', status: 'suppressed', reason: 'blocked' }] };
  } }] });
  try {
    const uuid = await m.sendMail({ to: 'ok@example.com', bcc: 'hidden@example.com', text: 'hello' });
    await m.___send(structuredClone(m.queue.records.get(uuid)));
    expect(captured.envelope.to).toEqual(['ok@example.com']);
    expect(captured.message.toString()).not.toMatch(/^Bcc:/mi);
  } finally { await m.destroy({ drain: true }); transport.close(); }
});

it.each(['sender@example.com', ''])('preserves Nodemailer stream transport behavior with envelope sender %j', async (from) => {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true });
  let captured;
  let submitted;
  const m = createPolicyMailTime({ retries: 0, transports: [{ sendMail(mail, done) {
    submitted = mail.envelope;
    transport.sendMail(mail, (error, info) => { captured = info; done(error, info ? { ...info, accepted: info.envelope.to } : info); });
  } }], recipientPolicies: [{ name: 'p', beforeSend({ recipients }) {
    return { decisions: recipients.filter((r) => r.address !== 'ok@example.com').map(({ address }) => ({ address, status: 'suppressed', reason: 'blocked' })) };
  } }] });
  try {
    const uuid = await m.sendMail({ from: 'Sender <sender@example.com>', to: ['ok@example.com', 'blocked@example.com'], cc: 'copy@example.com', bcc: 'hidden@example.com', envelope: { from, to: ['ok@example.com', 'blocked@example.com', 'copy@example.com', 'hidden@example.com'] }, text: 'hello' });
    await m.___send(structuredClone(m.queue.records.get(uuid)));
    expect(submitted).toEqual({ from, to: ['ok@example.com'] });
    expect(captured.envelope).toEqual({ from: from || false, to: ['ok@example.com'] });
    expect(captured.message.toString()).toMatch(/blocked@example.com/);
    expect(captured.message.toString()).toMatch(/^Cc: copy@example.com/m);
    // Nodemailer's stream transport deliberately sets keepBcc=true.
    expect(captured.message.toString()).toMatch(/^Bcc: hidden@example.com/m);
    expect(m.queue.records.get(uuid)).toMatchObject({ isSettled: true, isSent: false, isFailed: false });
  } finally { await m.destroy({ drain: true }); transport.close(); }
});

import { hasOwnProp, isPlainObject } from './helpers.js';

const policyError = (message) => new Error(`[mail-time] [recipientPolicies] ${message}`);
const SIMPLE_MAILBOX = /^[^\s<>,;:"()\\\[\]@]+@[^\s<>,;:"()\\\[\]@]+$/u;

const normalizePolicyAddress = (value) => {
  const input = typeof value === 'string' ? value : (!Array.isArray(value) && value?.address);
  if (typeof input !== 'string' || /[\r\n]/u.test(input)) {
    throw policyError('recipient requires a simple address without line breaks');
  }
  let address = input.trim();
  if (address.includes('<') || address.includes('>')) {
    const match = address.match(/^[^<>,;:"\r\n]*<([^<>]+)>$/u);
    if (!match) throw policyError('use a simple explicit envelope.to');
    address = match[1].trim();
  }
  if (!SIMPLE_MAILBOX.test(address)) throw policyError('use a simple explicit envelope.to');
  return address.toLowerCase();
};

const preparePolicyEnvelope = (compiled, previousResults = []) => {
  const recipients = new Map();
  const explicit = compiled.envelope && hasOwnProp(compiled.envelope, 'to');
  const add = (value, source, authoritative) => {
    for (const entry of Array.isArray(value) ? value : [value]) {
      let address;
      try { address = normalizePolicyAddress(entry); }
      catch (error) { if (authoritative) throw error; else continue; }
      if (!recipients.has(address)) {
        if (!authoritative) continue;
        recipients.set(address, { address, sources: [] });
      }
      const sources = recipients.get(address).sources;
      if (!sources.includes(source)) sources.push(source);
    }
  };
  if (explicit) add(compiled.envelope.to, 'envelope', true);
  for (const source of ['to', 'cc', 'bcc']) {
    if (hasOwnProp(compiled, source) && compiled[source] !== void 0) add(compiled[source], source, !explicit);
  }
  if (!recipients.size) throw policyError('envelope must contain at least one recipient');
  if (previousResults.length && (previousResults.length !== recipients.size || previousResults.some((r) => !recipients.has(r.address)))) {
    throw policyError('envelope recipient set changed between attempts');
  }
  const envelope = { to: [...recipients.keys()] };
  if (compiled.envelope && hasOwnProp(compiled.envelope, 'from')) {
    envelope.from = compiled.envelope.from === '' ? '' : normalizePolicyAddress(compiled.envelope.from);
  } else {
    const from = compiled.from || compiled.sender || compiled.replyTo;
    if (from) envelope.from = normalizePolicyAddress(from);
  }
  return { envelope, recipients: [...recipients.values()] };
};

const validateRecipientPolicies = (value, queue) => {
  if (value === void 0) return null;
  if (!Array.isArray(value) || !value.length) throw policyError('recipientPolicies must be a nonempty array');
  if (queue.supportsRecipientPolicies !== true) throw policyError('queue must declare recipient policy support');
  const names = new Set();
  return value.map((provider) => {
    if (!isPlainObject(provider)) throw policyError('each provider must be a plain object');
    const name = typeof provider.name === 'string' ? provider.name.trim() : '';
    if (!name || name.length > 128 || names.has(name)) throw policyError('provider names must be unique and contain 1-128 characters');
    names.add(name);
    const failureMode = provider.failureMode === void 0 ? 'retry' : provider.failureMode;
    if (failureMode !== 'retry' && failureMode !== 'continue') throw policyError('failureMode must be retry or continue');
    const normalized = { name, failureMode };
    let count = 0;
    for (const hook of ['beforeSend', 'classifyRejections', 'observeAttempt']) {
      if (hasOwnProp(provider, hook)) {
        if (typeof provider[hook] !== 'function') throw policyError(`${hook} must be a function`);
        normalized[hook] = provider[hook].bind(provider);
        count++;
      }
    }
    if (!count) throw policyError('provider requires at least one supported hook');
    return normalized;
  });
};

export { policyError, normalizePolicyAddress, preparePolicyEnvelope, validateRecipientPolicies };

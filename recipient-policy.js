import { hasOwnProp, isPlainObject } from './helpers.js';

const policyError = (message) => new Error(`[mail-time] [recipientPolicies] ${message}`);
const SIMPLE_MAILBOX = /^[^\s<>,;:"()\\\[\]@]+@[^\s<>,;:"()\\\[\]@]+$/u;
// RFC 5322 specials that are unambiguous only inside a quoted display name.
const PHRASE_SPECIALS = '<>()[]:;@\\,';
const UNSAFE_CHARS = /[\r\n\u0000]/u;

/**
 * Error for an address that cannot be parsed into exactly one mailbox. The message names
 * the field and the rule that failed, never the address or display name itself.
 */
const addressError = (field, reason) => {
  const error = policyError(`\`${field}\` ${reason}`);
  error.code = 'MAIL_TIME_INVALID_ADDRESS';
  error.field = field;
  return error;
};

const isAddressError = (error) => error?.code === 'MAIL_TIME_INVALID_ADDRESS';

const toMailbox = (address, field) => {
  const trimmed = address.trim();
  if (!SIMPLE_MAILBOX.test(trimmed)) throw addressError(field, 'must contain one address such as user@example.com; quoted local parts are not supported');
  return trimmed.toLowerCase();
};

/**
 * Parse one Nodemailer mailbox string: `addr`, `<addr>`, or `display name <addr>`, where the
 * display name is any mix of atoms and quoted strings with backslash escapes. Groups,
 * comments, and comma-separated lists are rejected rather than guessed at.
 */
const parseMailboxString = (input, field) => {
  let display = '';
  let angle = null;
  let quoted = false;
  for (let i = 0; i < input.length; i++) {
    const char = input[i];
    if (quoted) {
      if (char === '\\') {
        if (++i >= input.length) break;
      } else if (char === '"') {
        quoted = false;
      }
      continue;
    }
    if (char === '"') {
      quoted = true;
    } else if (char === '<') {
      const close = input.indexOf('>', i + 1);
      if (close === -1) throw addressError(field, 'has an unclosed angle bracket');
      angle = input.slice(i + 1, close);
      if (input.slice(close + 1).trim()) throw addressError(field, 'must end after the angle-bracket address; use an array for multiple recipients');
      break;
    } else if (char === ',') {
      throw addressError(field, 'must contain one mailbox; use an array for multiple recipients or quote a display name that contains a comma');
    } else if (char === ';' || char === ':') {
      throw addressError(field, 'must not use group syntax');
    } else if (char === '(' || char === ')') {
      throw addressError(field, 'must not contain comments; quote a display name that contains parentheses');
    } else {
      display += char;
    }
  }
  if (quoted) throw addressError(field, 'has an unterminated quoted display name');
  if (angle === null) {
    if (display !== input) throw addressError(field, 'must contain one address such as user@example.com; quoted local parts are not supported');
    return toMailbox(input, field);
  }
  for (const char of display) {
    if (PHRASE_SPECIALS.includes(char)) throw addressError(field, 'has an unquoted special character in its display name; wrap the name in double quotes');
  }
  return toMailbox(angle, field);
};

/**
 * Normalize exactly one mailbox (string or `{ name?, address }`) to its lowercase address.
 * @param {unknown} value
 * @param {string} [field] - Field label used in errors, e.g. `to[1]` or `envelope.from`.
 * @returns {string}
 */
const normalizePolicyAddress = (value, field = 'address') => {
  if (typeof value === 'string') {
    if (UNSAFE_CHARS.test(value)) throw addressError(field, 'must not contain line breaks or NUL characters');
    if (!value.trim()) throw addressError(field, 'must not be empty');
    return parseMailboxString(value.trim(), field);
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw addressError(field, 'must be an address string or a { name, address } object');
  if (typeof value.address !== 'string') throw addressError(field, 'object requires a string `address`');
  if (value.name !== void 0 && typeof value.name !== 'string') throw addressError(field, 'object `name` must be a string');
  if (UNSAFE_CHARS.test(value.address) || (value.name && UNSAFE_CHARS.test(value.name))) {
    throw addressError(field, 'must not contain line breaks or NUL characters');
  }
  return toMailbox(value.address, field);
};

const preparePolicyEnvelope = (compiled, previousResults = []) => {
  const recipients = new Map();
  const explicit = compiled.envelope && hasOwnProp(compiled.envelope, 'to');
  const add = (value, source, authoritative, label = source) => {
    const list = Array.isArray(value);
    const entries = list ? value : [value];
    for (let i = 0; i < entries.length; i++) {
      let address;
      try { address = normalizePolicyAddress(entries[i], list ? `${label}[${i}]` : label); }
      catch (error) { if (authoritative) throw error; else continue; }
      if (!recipients.has(address)) {
        if (!authoritative) continue;
        recipients.set(address, { address, sources: [] });
      }
      const sources = recipients.get(address).sources;
      if (!sources.includes(source)) sources.push(source);
    }
  };
  if (explicit) add(compiled.envelope.to, 'envelope', true, 'envelope.to');
  for (const source of ['to', 'cc', 'bcc']) {
    if (hasOwnProp(compiled, source) && compiled[source] !== void 0) add(compiled[source], source, !explicit);
  }
  if (!recipients.size) throw policyError('envelope must contain at least one recipient');
  if (previousResults.length && (previousResults.length !== recipients.size || previousResults.some((r) => !recipients.has(r.address)))) {
    throw policyError('envelope recipient set changed between attempts');
  }
  const envelope = { to: [...recipients.keys()] };
  if (compiled.envelope && hasOwnProp(compiled.envelope, 'from')) {
    envelope.from = compiled.envelope.from === '' ? '' : normalizePolicyAddress(compiled.envelope.from, 'envelope.from');
  } else {
    // Same precedence as Nodemailer's getEnvelope(): From, then Sender, then Reply-To.
    const field = ['from', 'sender', 'replyTo'].find((key) => compiled[key]);
    if (field) envelope.from = normalizePolicyAddress(compiled[field], field);
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

const validatePolicyResult = (raw, hook, context) => {
  if (raw === void 0) return [];
  if (!isPlainObject(raw)) throw policyError('hook must return a result object or nothing');
  if (raw.decisions === void 0) return [];
  if (!Array.isArray(raw.decisions)) throw policyError('decisions must be an array');
  const batch = new Set(context.recipients.map((r) => r.address));
  const attributable = new Set((context.rejections || []).map((r) => r.address).filter(Boolean));
  const decisions = new Map();
  for (const item of raw.decisions) {
    if (!isPlainObject(item)) throw policyError('decision must be an object');
    const address = normalizePolicyAddress(item.address, 'decision.address');
    if (!batch.has(address)) throw policyError('decision address is outside the input batch');
    const allowed = hook === 'beforeSend' ? item.status === 'suppressed' : (item.status === 'retry' || item.status === 'rejected');
    if (!allowed) throw policyError('invalid decision status for this phase');
    if (item.status === 'rejected' && !attributable.has(address)) throw policyError('permanent rejection requires an attributable record');
    if (typeof item.reason !== 'string' || !item.reason.trim() || item.reason.length > 512) throw policyError('reason must contain 1-512 characters');
    const previous = decisions.get(address);
    if (previous && (previous.status !== item.status || previous.reason !== item.reason)) throw policyError('conflicting duplicate decisions');
    decisions.set(address, { address, status: item.status, reason: item.reason });
  }
  return [...decisions.values()];
};

const evaluatePolicyPhase = async (providers, hook, context, report) => {
  const decisions = [];
  let retryFailure = false;
  for (const provider of providers) {
    if (typeof provider[hook] !== 'function') continue;
    try {
      const validated = validatePolicyResult(await provider[hook](context), hook, context);
      for (const decision of validated) decisions.push({ ...decision, provider: provider.name });
    } catch (error) {
      report(error, provider.name, hook);
      if (provider.failureMode !== 'continue') retryFailure = true;
    }
  }
  return { retryFailure, decisions };
};

const mergePolicyResults = (previous, recipients, evaluated, details) => {
  const results = new Map(previous.map((r) => [r.address, r]));
  const accepted = new Set(details.accepted || []);
  const decisions = new Map();
  for (const decision of evaluated.decisions) {
    if (!decisions.has(decision.address)) decisions.set(decision.address, []);
    decisions.get(decision.address).push(decision);
  }
  const diagnostics = new Map();
  for (const record of details.rejections || []) {
    if (record.address && !diagnostics.has(record.address)) diagnostics.set(record.address, record);
  }
  for (const recipient of recipients) {
    const prior = results.get(recipient.address);
    if (prior && prior.status !== 'error') continue;
    const candidates = decisions.get(recipient.address) || [];
    const terminal = details.phase === 'beforeSend' ? 'suppressed' : 'rejected';
    let status = 'error';
    if (accepted.has(recipient.address)) status = 'sent';
    else if (!evaluated.retryFailure && candidates.some((d) => d.status === terminal)) status = terminal;
    const reasons = [];
    if (!evaluated.retryFailure && status !== 'sent') {
      for (const candidate of candidates) {
        if (candidate.status === (status === 'error' ? 'retry' : status)) reasons.push({ provider: candidate.provider, reason: candidate.reason });
      }
    }
    const result = { address: recipient.address, status, sources: [...recipient.sources], reasons, attempt: details.attempt, transportIndex: details.transportIndex };
    if (typeof details.transportName === 'string') result.transportName = details.transportName.slice(0, 128);
    const record = diagnostics.get(recipient.address);
    if (record) {
      for (const key of ['command', 'response', 'message']) {
        if (typeof record[key] === 'string') result[key] = record[key].slice(0, 2048);
      }
      if (Number.isFinite(record.responseCode)) result.responseCode = record.responseCode;
    }
    results.set(recipient.address, result);
  }
  return [...results.values()];
};

const summarizePolicyTask = (task, isSettled) => {
  const recipients = { sent: [], error: [], suppressed: [], rejected: [] };
  for (const result of task.recipientResults || []) recipients[result.status].push(result);
  return { uuid: task.uuid, tries: task.tries, isSettled, recipients };
};

export { policyError, isAddressError, normalizePolicyAddress, preparePolicyEnvelope, validateRecipientPolicies, evaluatePolicyPhase, mergePolicyResults, summarizePolicyTask };

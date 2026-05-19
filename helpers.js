const hasOwn = Object.prototype.hasOwnProperty;

const debug = (isDebug, ...args) => {
  if (isDebug) {
    console.info('[DEBUG] [mail-time]', `${new Date()}`, ...args);
  }
};

const logError = (...args) => {
  console.error('[ERROR] [mail-time]', `${new Date()}`, ...args);
};

const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
};

/**
 * Minimal deep-merge sufficient for nodemailer-shaped mail options:
 * - plain objects merge key-by-key
 * - arrays concatenate
 * - other values (strings, numbers, Date, Buffer, streams, classes) replace
 * Source values override target values.
 */
const deepMerge = (target, source) => {
  if (!isPlainObject(source)) {
    return target;
  }

  const out = isPlainObject(target) ? { ...target } : {};

  for (const key of Object.keys(source)) {
    const sVal = source[key];
    const tVal = out[key];

    if (Array.isArray(sVal)) {
      out[key] = Array.isArray(tVal) ? tVal.concat(sVal) : sVal.slice();
    } else if (isPlainObject(sVal)) {
      out[key] = isPlainObject(tVal) ? deepMerge(tVal, sVal) : deepMerge({}, sVal);
    } else {
      out[key] = sVal;
    }
  }

  return out;
};

/**
 * Order-insensitive deep equality. Treats arrays as multisets and
 * objects as unordered maps. Designed for the small `mailOptions`
 * shape used by MailTime's email concatenation dedup.
 */
const equals = (a, b) => {
  if (a === b) {
    return true;
  }

  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') {
    return false;
  }

  if (a instanceof Date && b instanceof Date) {
    return a.valueOf() === b.valueOf();
  }

  if (Array.isArray(a)) {
    if (!Array.isArray(b) || a.length !== b.length) {
      return false;
    }

    const matched = new Array(b.length).fill(false);
    for (let i = 0; i < a.length; i++) {
      let found = false;
      for (let j = 0; j < b.length; j++) {
        if (!matched[j] && equals(a[i], b[j])) {
          matched[j] = true;
          found = true;
          break;
        }
      }
      if (!found) {
        return false;
      }
    }
    return true;
  }

  if (Array.isArray(b)) {
    return false;
  }

  const aKeys = Object.keys(a);
  const bKeys = Object.keys(b);

  if (aKeys.length !== bKeys.length) {
    return false;
  }

  for (let i = 0; i < aKeys.length; i++) {
    const key = aKeys[i];
    if (!hasOwn.call(b, key) || !equals(a[key], b[key])) {
      return false;
    }
  }

  return true;
};

/**
 * Extract the email part of a nodemailer-shaped recipient entry.
 * Accepts `'a@x.com'`, `'Name <a@x.com>'`, or `{ name, address }`.
 * Returns the address lowercased, or `null` when none can be parsed.
 */
const extractEmail = (entry) => {
  if (!entry) {
    return null;
  }
  if (typeof entry === 'object' && typeof entry.address === 'string') {
    return entry.address.trim().toLowerCase();
  }
  if (typeof entry !== 'string') {
    return null;
  }
  const angled = entry.match(/<([^>]+)>/);
  return (angled ? angled[1] : entry).trim().toLowerCase();
};

/**
 * Normalize a `to`/`cc`/`bcc` field into a flat list of lowercase addresses.
 */
const toAddressList = (field) => {
  if (!field) {
    return [];
  }
  if (Array.isArray(field)) {
    const out = [];
    for (const entry of field) {
      const addr = extractEmail(entry);
      if (addr) {
        out.push(addr);
      }
    }
    return out;
  }
  const single = extractEmail(field);
  return single ? [single] : [];
};

/**
 * Remove entries whose extracted address is in `acceptedSet` from a
 * nodemailer `to`/`cc`/`bcc` field. Returns `void 0` when the filtered
 * array would be empty or the single string is dropped.
 */
const filterAddressField = (field, acceptedSet) => {
  if (!field || !(acceptedSet instanceof Set) || acceptedSet.size === 0) {
    return field;
  }
  if (Array.isArray(field)) {
    const filtered = [];
    for (const entry of field) {
      const addr = extractEmail(entry);
      if (!addr || !acceptedSet.has(addr)) {
        filtered.push(entry);
      }
    }
    return filtered.length ? filtered : void 0;
  }
  const addr = extractEmail(field);
  if (addr && acceptedSet.has(addr)) {
    return void 0;
  }
  return field;
};

const isSendClaimUpdate = (updateObj) => {
  return updateObj && updateObj.isSending === true && typeof updateObj.tries === 'number';
};

const isSendLeaseGuardedUpdate = (updateObj) => {
  return updateObj && typeof updateObj.leaseTries === 'number' && typeof updateObj.leaseSendingAt === 'number';
};

const isAppendMailOptionUpdate = (updateObj) => {
  return updateObj && updateObj.appendMailOption !== void 0;
};

/** Strip MailTime-internal update keys before persisting to storage. */
const stripInternalUpdateMeta = (updateObj) => {
  const out = { ...updateObj };
  delete out.leaseTries;
  delete out.leaseSendingAt;
  delete out.appendMailOption;
  return out;
};

const isSendLeaseRemove = (opts) => {
  return opts && typeof opts.leaseTries === 'number' && typeof opts.leaseSendingAt === 'number';
};

export {
  debug,
  logError,
  isPlainObject,
  deepMerge,
  equals,
  extractEmail,
  toAddressList,
  filterAddressField,
  isSendClaimUpdate,
  isSendLeaseGuardedUpdate,
  isAppendMailOptionUpdate,
  stripInternalUpdateMeta,
  isSendLeaseRemove,
};

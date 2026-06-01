const hasOwn = Object.prototype.hasOwnProperty;

/**
 * @name hasOwnProp - `Object.hasOwn` (ES2022) polyfill.
 * @function
 * @param {object} obj
 * @param {PropertyKey} key
 * @returns {boolean} `true` if the object has the property, `false` otherwise.
 */
const hasOwnProp = (obj, key) => hasOwn.call(obj, key);

/**
 * @name debug - Debug logging.
 * @function
 * @param {boolean} isDebug
 * @param {...any} args
 * @returns {void}
 */
const debug = (isDebug, ...args) => {
  if (isDebug) {
    console.info('[DEBUG] [mail-time]', `${new Date()}`, ...args);
  }
};

/**
 * @name logError - Error logging.
 * @function
 * @param {...any} args
 * @returns {void}
 */
const logError = (...args) => {
  console.error('[ERROR] [mail-time]', `${new Date()}`, ...args);
};

/**
 * @name isPlainObject - Check whether a value is a plain object (literal or `Object.create(null)`).
 * @function
 * @param {any} value
 * @returns {boolean} `true` for plain objects, `false` for `null`, arrays, class instances, and primitives.
 */
const isPlainObject = (value) => {
  if (value === null || typeof value !== 'object') {
    return false;
  }
  const proto = Object.getPrototypeOf(value);
  return proto === null || proto === Object.prototype;
};

/**
 * @name deepMerge - Minimal deep-merge sufficient for nodemailer-shaped mail options:
 * - plain objects merge key-by-key
 * - arrays concatenate
 * - other values (strings, numbers, Date, Buffer, streams, classes) replace
 * Source values override target values.
 * @function
 * @param {any} target - Base value; merged into a shallow clone when a plain object, otherwise ignored.
 * @param {any} source - Overriding value; returns `target` unchanged when not a plain object.
 * @returns {any} The merged result (a new object), or `target` when `source` is not a plain object.
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
 * @name equals - Order-insensitive deep equality. Treats arrays as multisets and
 * objects as unordered maps. Designed for the small `mailOptions`
 * shape used by MailTime's email concatenation dedup.
 * @function
 * @param {any} a
 * @param {any} b
 * @returns {boolean} `true` when `a` and `b` are deeply equal ignoring array/key order.
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
 * @name extractEmail - Extract the email part of a nodemailer-shaped recipient entry.
 * Accepts `'a@x.com'`, `'Name <a@x.com>'`, or `{ name, address }`.
 * @function
 * @param {string|{name?: string, address?: string}|null|undefined} entry
 * @returns {string|null} The address lowercased and trimmed, or `null` when none can be parsed.
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
 * @name toAddressList - Normalize a `to`/`cc`/`bcc` field into a flat list of lowercase addresses.
 * @function
 * @param {string|Array<string|{name?: string, address?: string}>|null|undefined} field
 * @returns {string[]} Flat list of parsed lowercase addresses; empty when `field` is falsy or unparseable.
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
 * @name filterAddressField - Remove entries whose extracted address is in `acceptedSet` from a
 * nodemailer `to`/`cc`/`bcc` field.
 * @function
 * @param {string|Array<string|{name?: string, address?: string}>|null|undefined} field
 * @param {Set<string>} acceptedSet - Lowercase addresses to drop.
 * @returns {string|Array|undefined} The filtered field, or `void 0` when the filtered array would be
 * empty or the single string is dropped. Returns `field` unchanged when `acceptedSet` is empty.
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

/**
 * @name isSendClaimUpdate - Detect an atomic send-claim update (`{ isSending: true, tries: N }`).
 * @function
 * @param {object} updateObj
 * @returns {boolean} `true` when `updateObj` claims a row for sending.
 */
const isSendClaimUpdate = (updateObj) => {
  return updateObj && updateObj.isSending === true && typeof updateObj.tries === 'number';
};

/**
 * @name isSendLeaseGuardedUpdate - Detect an update guarded by a send lease
 * (carries `leaseTries` and `leaseSendingAt`).
 * @function
 * @param {object} updateObj
 * @returns {boolean} `true` when both lease guard fields are present numbers.
 */
const isSendLeaseGuardedUpdate = (updateObj) => {
  return updateObj && typeof updateObj.leaseTries === 'number' && typeof updateObj.leaseSendingAt === 'number';
};

/**
 * @name isAppendMailOptionUpdate - Detect an update that appends a mail option (for email concatenation).
 * @function
 * @param {object} updateObj
 * @returns {boolean} `true` when `updateObj.appendMailOption` is set.
 */
const isAppendMailOptionUpdate = (updateObj) => {
  return updateObj && updateObj.appendMailOption !== void 0;
};

/**
 * @name stripInternalUpdateMeta - Strip MailTime-internal update keys before persisting to storage.
 * @function
 * @param {object} updateObj
 * @returns {object} A shallow clone without `leaseTries`, `leaseSendingAt`, and `appendMailOption`.
 */
const stripInternalUpdateMeta = (updateObj) => {
  const out = { ...updateObj };
  delete out.leaseTries;
  delete out.leaseSendingAt;
  delete out.appendMailOption;
  return out;
};

/**
 * @name isSendLeaseRemove - Detect a remove guarded by a send lease
 * (carries `leaseTries` and `leaseSendingAt`).
 * @function
 * @param {object} opts
 * @returns {boolean} `true` when both lease guard fields are present numbers.
 */
const isSendLeaseRemove = (opts) => {
  return opts && typeof opts.leaseTries === 'number' && typeof opts.leaseSendingAt === 'number';
};

export {
  debug,
  logError,
  hasOwnProp,
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

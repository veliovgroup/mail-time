import { hasOwnProp } from './helpers.js';
import { normalizePolicyAddress } from './recipient-policy.js';

const diagnosticFields = (record) => {
  const result = {};
  for (const key of ['command', 'response', 'message']) {
    if (typeof record?.[key] === 'string') result[key] = record[key].slice(0, 2048);
  }
  if (Number.isFinite(record?.responseCode)) result.responseCode = record.responseCode;
  return result;
};

const normalizeRejections = (error, info, transport) => {
  const records = [];
  const ancestors = new WeakSet();
  const addressOf = (value) => {
    try { return normalizePolicyAddress(value); }
    catch { return null; }
  };
  const append = (node, address) => {
    const record = { address, ...diagnosticFields(node), transportIndex: transport.index };
    if (typeof transport.name === 'string') record.transportName = transport.name.slice(0, 128);
    if (typeof node === 'string') record.message = node.slice(0, 2048);
    records.push(record);
  };
  const visit = (node, positional = null, root = false, errorRoot = false) => {
    if (node === null || node === void 0) {
      if (!root) append(node, positional);
      return;
    }
    if (typeof node !== 'object') {
      append(node, positional);
      return;
    }
    if (ancestors.has(node)) return;
    ancestors.add(node);
    const start = records.length;
    const rejected = Array.isArray(node.rejected) ? node.rejected.map(addressOf) : [];
    for (const key of ['errors', 'rejectedErrors']) {
      if (Array.isArray(node[key])) {
        for (let i = 0; i < node[key].length; i++) visit(node[key][i], rejected[i] || null);
      }
    }
    if (records.length === start) {
      let address = positional;
      for (const key of ['recipient', 'address', 'to']) {
        if (hasOwnProp(node, key)) { address = addressOf(node[key]); break; }
      }
      if (!root || errorRoot || address || Object.keys(diagnosticFields(node)).length) append(node, address);
    }
    const attributed = new Set(records.slice(start).map((r) => r.address));
    for (const address of rejected) {
      if (address && !attributed.has(address)) append({ message: 'Recipient rejected by transport' }, address);
    }
    ancestors.delete(node);
  };
  visit(error, null, true, true);
  visit(info, null, true);
  return records;
};

export { normalizeRejections, diagnosticFields };

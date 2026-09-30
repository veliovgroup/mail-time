// Runtime-matrix probe. Runs from an install of the PACKED mail-time tarball
// plus exact josk, never from the repo tree. One JSON line per phase.
// usage: node probe.mjs <mongo-url-with-unique-db>
import { createRequire } from 'module';
import crypto from 'crypto';
import mongodb from 'mongodb';

const require = createRequire(import.meta.url);
const { MongoClient } = mongodb;
const url = process.argv[2];
const results = [];
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const waitUntil = async (fn, timeout = 8000) => {
  const t = Date.now();
  while (Date.now() - t < timeout) { if (fn()) return true; await wait(25); }
  return !!fn();
};
const phase = async (group, name, fn) => {
  let r;
  try { await fn(); r = { group, name, ok: true }; } catch (e) { r = { group, name, ok: false, error: String(e && e.message || e).slice(0, 200) }; }
  results.push(r);
  console.log(JSON.stringify(r));
};
const assert = (c, m) => { if (!c) throw new Error(m); };

// 1. parse + load (ESM and CommonJS entry points, plus the JoSk dependency)
let MailTime, MongoQueue, JoSk, MongoAdapter;
await phase('load', 'esm import mail-time', async () => { ({ MailTime } = await import('mail-time')); assert(typeof MailTime === 'function', 'no MailTime'); });
await phase('load', 'esm import mail-time/adapters/mongo', async () => { ({ MongoQueue } = await import('mail-time/adapters/mongo')); assert(typeof MongoQueue === 'function', 'no MongoQueue'); });
await phase('load', 'cjs require mail-time', async () => { const m = require('mail-time'); assert(typeof m.MailTime === 'function', 'no MailTime'); });
await phase('load', 'esm import josk', async () => { ({ JoSk, MongoAdapter } = await import('josk')); assert(typeof JoSk === 'function', 'no JoSk'); });

let client, db;
await phase('mongo', 'connect + ping', async () => {
  client = await MongoClient.connect(url, { connectTimeoutMS: 5000, serverSelectionTimeoutMS: 5000 });
  db = client.db();
  await db.command({ ping: 1 });
});

const stopAll = [];
if (db && MailTime && MongoQueue && JoSk) {
  const mk = (prefix, transport, extra = {}) => {
    const errors = [];
    const mt = new MailTime({
      queue: new MongoQueue({ db, prefix }), prefix, verifyTransports: false,
      transports: [transport], from: 'no-reply@example.com', retries: 0, keepHistory: false,
      revolvingInterval: 20,
      josk: { adapter: { type: 'mongo', db, prefix }, minRevolvingDelay: 10, maxRevolvingDelay: 20, onError: (title) => errors.push(title) },
      ...extra,
    });
    stopAll.push(mt);
    return { mt, errors };
  };
  const stub = (sends, ms) => ({ options: { from: 'no-reply@example.com' }, sendMail(mail, done) { sends.push(mail.to); setTimeout(() => done(null, { accepted: [mail.to], rejected: [], response: 'OK' }), ms); } });
  const rows = (prefix) => db.collection(`__mailTimeQueue__${prefix}`).find({}).toArray();
  const uid = () => `mx${crypto.randomBytes(4).toString('hex')}`;

  // 2. Mongo behavior + stub-transport send (no external SMTP)
  await phase('mongo', 'queue send via stub transport', async () => {
    const p = uid(); const sends = []; const { mt } = mk(p, stub(sends, 5));
    await mt.ready();
    await mt.sendMail({ to: 'one@example.com', text: 'x' });
    assert(await waitUntil(() => sends.length === 1), 'not sent');
    assert(await mt.destroy({ drain: true }) === true, 'drain false');
  });

  // 3. JoSk-only shutdown control (no MailTime)
  const joskOnly = async (handlerMs, timeout) => {
    const p = uid(); const errs = [];
    const j = new JoSk({ adapter: new MongoAdapter({ db, prefix: p }), minRevolvingDelay: 10, maxRevolvingDelay: 20, onError: (t) => errs.push(t) });
    let started = false;
    await j.setInterval((ready) => { started = true; setTimeout(ready, handlerMs); }, 50, `t${p}`);
    assert(await waitUntil(() => started, 5000), 'handler never started');
    const finished = await j.shutdown({ timeout });
    return { finished, errs };
  };
  await phase('shutdown', 'josk-only: handler finishes inside timeout -> true, no error', async () => {
    const { finished, errs } = await joskOnly(150, 1500);
    assert(finished === true, `shutdown=${finished}`); assert(errs.length === 0, `errors ${errs}`);
  });
  await phase('shutdown', 'josk-only: unfinished handler -> false + [shutdown] timeout error', async () => {
    const { finished, errs } = await joskOnly(1500, 100);
    assert(finished === false, `shutdown=${finished}`); assert(errs.includes('[shutdown] timeout'), `errors ${errs}`);
  });

  // 4. MailTime backlog regression: concurrency 1, 3 due, send 400ms > schedulerTimeout 150
  const backlog = async () => {
    const p = uid(); const sends = []; const { mt, errors } = mk(p, stub(sends, 400), { concurrency: 1 });
    await mt.ready();
    for (const n of ['a', 'b', 'c']) await mt.sendMail({ to: `${n}@example.com`, text: 'x' });
    assert(await waitUntil(() => sends.length === 1), 'first send did not start');
    return { p, mt, sends, errors };
  };
  const untouched = (rs) => rs.filter((r) => r.isSent === false && r.isSending === false && r.tries === 0).length;
  await phase('shutdown', 'mailtime backlog: destroy({drain}) -> true, 1 send, 2 rows unclaimed, no scheduler error', async () => {
    const { p, mt, sends, errors } = await backlog();
    const r = await mt.destroy({ drain: true, schedulerTimeout: 150 });
    assert(r === true, `destroy=${r}`);
    await wait(150);
    assert(sends.length === 1, `sends=${sends.length}`);
    assert(errors.length === 0, `errors ${errors}`);
    const rs = await rows(p);
    assert(rs.length === 2 && untouched(rs) === 2, `rows ${JSON.stringify(rs.map((x) => [x.isSent, x.isSending, x.tries]))}`);
  });
  await phase('shutdown', 'mailtime backlog: destroy() no drain -> no new sends, rows unclaimed', async () => {
    const { p, mt, sends } = await backlog();
    assert(mt.destroy() === true, 'destroy false');
    await mt.drain(); await wait(600);
    assert(sends.length === 1, `sends=${sends.length}`);
    const rs = await rows(p);
    assert(rs.length >= 2 && rs.filter((x) => x.isSent === false && x.tries === 0).length === 2, 'unexpected rows');
  });
  await phase('shutdown', 'mailtime backlog: pause() drops queued, resume() sends the rest', async () => {
    const { p, mt, sends } = await backlog();
    assert(mt.pause() === true, 'pause false');
    await mt.drain(); await wait(150);
    assert(sends.length === 1, `after pause sends=${sends.length}`);
    assert(mt.resume() === true, 'resume false');
    assert(await waitUntil(() => sends.length === 3, 10000), `after resume sends=${sends.length}`);
    assert(await mt.destroy({ drain: true }) === true, 'drain false');
  });
  await phase('shutdown', 'mailtime genuinely unfinished scan -> destroy({drain}) false', async () => {
    const p = uid(); const sends = []; const { mt, errors } = mk(p, stub(sends, 5));
    await mt.ready();
    // wedge the queue scan itself so the scheduler task cannot finish
    let entered = false;
    mt.queue.iterate = () => { entered = true; return new Promise((r) => setTimeout(r, 2500)); };
    await mt.sendMail({ to: 'w@example.com', text: 'x' });
    assert(await waitUntil(() => entered, 5000), 'scan never entered');
    const r = await mt.destroy({ drain: true, schedulerTimeout: 100 });
    assert(r === false, `destroy=${r}`);
    assert(errors.includes('[shutdown] timeout'), `errors ${errors}`);
  });
}

for (const mt of stopAll) { try { await mt.destroy({ drain: true, schedulerTimeout: 200 }); } catch (e) {} }
if (client) await client.close();
const bad = results.filter((r) => !r.ok).length;
console.log(JSON.stringify({ summary: true, node: process.version, total: results.length, failed: bad }));
process.exit(bad ? 1 : 0);

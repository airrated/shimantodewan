const fs = require('fs');
const src = fs.readFileSync('api/order.js', 'utf8');

// fail: { to, throws }  any Resend call addressed to `to` is answered with an
// error status, or throws when `throws` is set
function load(env, fail) {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body });
    if (String(url).includes('siteverify')) {
      const sent = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ success: sent.response === 'good-token' }) };
    }
    if (String(url).includes('resend')) {
      if (fail && JSON.parse(opts.body).to.includes(fail.to)) {
        if (fail.throws) throw new Error('network down');
        return { ok: false, status: 500, text: async () => 'boom', json: async () => ({}) };
      }
      return { ok: true, text: async () => 'ok', json: async () => ({ id: 'x' }) };
    }
    return { ok: true, text: async () => 'ok' };
  };
  // lib/codes reads process.env, so it has to see the same fake env
  const libSrc = fs.readFileSync('lib/codes.js', 'utf8');
  const libMod = { exports: {} };
  new Function('module', 'exports', 'process', libSrc)(libMod, libMod.exports, { env });
  const req = (name) => {
    if (name.includes('codes')) return libMod.exports;
    throw new Error('unexpected require: ' + name);
  };

  const mod = { exports: {} };
  new Function('module', 'exports', 'process', 'fetch', 'console', 'require', src)(
    mod, mod.exports, { env }, fakeFetch,
    { error: () => {}, log: () => {} }, req
  );
  return { handler: mod.exports, calls };
}

function res() {
  const o = { code: 0, body: null, headers: {} };
  o.status = (c) => { o.code = c; return o; };
  o.json = (b) => { o.body = b; return o; };
  o.setHeader = (k, v) => { o.headers[k] = v; };
  return o;
}

const ENV = { RESEND_API_KEY: 'test', ORDER_TO: 'contact@shimantodewan.com', ORDER_DISPATCH: 'late November 2026' };
const fails = [];
const ok = (c, label, extra) => { console.log((c ? 'pass  ' : 'FAIL  ') + label + (extra ? '  ' + extra : '')); if (!c) fails.push(label); };

// The buyer's email is required, so every valid order below carries one
const EMAIL = 'karim@example.com';

// The buyer's copy is sent first, so mails are told apart by recipient, not position
const OWNER = 'contact@shimantodewan.com';
const resendMails = (calls) => calls.filter(c => c.url.includes('resend')).map(c => JSON.parse(c.body));
const ownerOf = (calls) => resendMails(calls).find(m => m.to.includes(OWNER));
const buyerOf = (calls) => resendMails(calls).find(m => !m.to.includes(OWNER));

(async () => {
  // --- happy path, all four -------------------------------------------
  {
    const { handler, calls } = load(ENV);
    const r = res();
    await handler({ method: 'POST', headers: {}, body: {
      name: 'Rifat Hossain', phone: '01712345678', email: 'rifat@example.com',
      address: 'House 4, Road 11, Banani, Dhaka 1213',
      items: [{id:'original',qty:1},{id:'inside',qty:1},{id:'influence',qty:1},{id:'shadows',qty:1}],
    }}, r);
    ok(r.code === 200, 'valid order returns 200', 'got ' + r.code);
    ok(r.body && r.body.ok === true, 'response ok');
    ok(/^BTE-[A-Z2-9]{5}$/.test(r.body.ref || ''), 'reference generated', r.body && r.body.ref);
    const mails = resendMails(calls);
    ok(mails.length === 2, 'two emails sent, owner and buyer', 'got ' + mails.length);
    const owner = ownerOf(calls), buyer = buyerOf(calls);
    ok(mails[0].to[0] === 'rifat@example.com' && mails[1].to.includes(OWNER), 'buyer copy is sent first, owner copy second');
    ok(owner.to.length === 1 && owner.to[0] === 'contact@shimantodewan.com', 'owner email addressed to ORDER_TO only when no CC is set');
    ok(owner.reply_to === 'rifat@example.com', 'reply-to is the buyer');
    ok(buyer.to[0] === 'rifat@example.com', 'buyer confirmation addressed correctly');
    ok(owner.text.includes('BDT 4,999'), 'bundle price in owner email');
    ok(owner.text.includes('- BDT 997'), 'bundle saving shown');
    ok(owner.text.includes('WhatsApp: 01712345678'), 'owner email labels the number WhatsApp');
    ok(!/Phone/.test(owner.text) && !/Phone/.test(owner.html), 'owner email no longer says Phone');
    ok(owner.html.includes('WhatsApp'), 'owner html shows a WhatsApp field');
    ok(owner.text.includes('Email:    rifat@example.com') && owner.html.includes('rifat@example.com'), 'buyer email always shown to the owner');
    ok(!/not given|NO BUYER EMAIL/.test(owner.text + owner.html), 'no "no buyer email" wording left');
    ok(owner.html.includes('CONFIRMATION SENT TO BUYER') && !/CONFIRMATION FAILED/.test(owner.html), 'owner html reports the confirmation as sent');
    ok(owner.text.includes('Confirmation sent to buyer.') && !/FAILED/.test(owner.text), 'owner text reports the confirmation as sent');
    ok(buyer.text.includes('late November 2026'), 'dispatch date in buyer email');
    ok(buyer.text.includes('cancel any time before dispatch'), 'cancellation terms in buyer email');
    ok(buyer.html.includes('do not send payment'), 'payment warning in buyer email');
    ok(buyer.text.includes('I will message you on WhatsApp at 01712345678'), 'buyer text says message on WhatsApp');
    ok(buyer.html.includes('I will message you on WhatsApp at <b>01712345678</b>'), 'buyer html says message on WhatsApp');
    ok(!/I will contact you/.test(buyer.text + buyer.html), 'old "contact you on" wording gone');
    ok(buyer.text.includes('To cancel, reply to this email with CANCEL in capitals.'), 'cancel instruction in buyer text');
    ok(buyer.html.includes('TO CANCEL, REPLY TO THIS EMAIL WITH CANCEL IN CAPITALS.'), 'cancel instruction in buyer html is in the footer\'s capitals');
    ok(!buyer.html.includes('To cancel, reply'), 'buyer html has no sentence-case copy of it');
    ok(!buyer.text.includes('TO CANCEL, REPLY'), 'buyer text keeps sentence case');
    ok(buyer.text.indexOf('To cancel, reply') > buyer.text.indexOf('cancel any time before dispatch'), 'cancel instruction follows the existing cancellation line');
    ok(!/CANCEL IN CAPITALS|CANCEL in capitals/i.test(owner.text + owner.html), 'cancel instruction is for the buyer only');
  }

  // --- second notification address ---------------------------------------
  {
    const { handler, calls } = load({ ...ENV, ORDER_TO_CC: 'partner@example.com' });
    const r = res();
    await handler({ method:'POST', headers:{}, body:{
      name:'Karim Ahmed', phone:'01812345678', email: EMAIL, address:'Road 9, Dhanmondi, Dhaka',
      items:[{id:'shadows',qty:1}] }}, r);
    const mails = resendMails(calls);
    const owner = ownerOf(calls), buyer = buyerOf(calls);
    ok(r.code === 200 && mails.length === 2, 'order with ORDER_TO_CC still sends exactly two emails');
    ok(owner.to.length === 2 && owner.to[0] === 'contact@shimantodewan.com' && owner.to[1] === 'partner@example.com', 'owner email goes to ORDER_TO and ORDER_TO_CC');
    ok(owner.reply_to === EMAIL, 'reply-to unchanged with a CC');
    ok(buyer.to.length === 1 && buyer.to[0] === EMAIL, 'buyer is never copied to the CC');
  }
  {
    const { handler, calls } = load({ ...ENV, ORDER_TO_CC: '   ' });
    await handler({ method:'POST', headers:{}, body:{
      name:'Karim Ahmed', phone:'01812345678', email: EMAIL, address:'Road 9, Dhanmondi, Dhaka',
      items:[{id:'shadows',qty:1}] }}, res());
    const owner = ownerOf(calls);
    ok(owner.to.length === 1 && owner.to[0] === 'contact@shimantodewan.com', 'blank ORDER_TO_CC is skipped');
  }
  {
    const { handler, calls } = load({ ...ENV, ORDER_TO_CC: 'contact@shimantodewan.com' });
    await handler({ method:'POST', headers:{}, body:{
      name:'Karim Ahmed', phone:'01812345678', email: EMAIL, address:'Road 9, Dhanmondi, Dhaka',
      items:[{id:'shadows',qty:1}] }}, res());
    const owner = ownerOf(calls);
    ok(owner.to.length === 1, 'CC equal to ORDER_TO is not listed twice');
  }

  // --- the buyer's email is required --------------------------------------
  {
    const { handler, calls } = load(ENV);
    const r = res();
    await handler({ method:'POST', headers:{}, body:{
      name:'Karim', phone:'01812345678', address:'Road 9, Dhanmondi, Dhaka',
      items:[{id:'shadows',qty:1}] }}, r);
    ok(r.code === 400, 'order without email rejected', 'got ' + r.code);
    ok(r.body && Array.isArray(r.body.errors) && r.body.errors.includes('email'), 'missing email reported as an email error');
    ok(calls.filter(c => c.url.includes('resend')).length === 0, 'nothing is sent for an order without email');
  }

  // --- the owner email reports what happened to the buyer's copy ------------
  const karim = { name:'Karim', phone:'01812345678', email: EMAIL, address:'Road 9, Dhanmondi, Dhaka',
                  items:[{id:'shadows',qty:1}] };
  for (const [fail, how] of [[{ to: EMAIL }, 'is rejected'], [{ to: EMAIL, throws: true }, 'throws']]) {
    const { handler, calls } = load(ENV, fail);
    const r = res();
    await handler({ method:'POST', headers:{}, body: karim }, r);
    const owner = ownerOf(calls);
    ok(r.code === 200 && r.body.ok === true, 'buyer send that ' + how + ' does not fail the order');
    ok(resendMails(calls).length === 2, 'owner email still sent when the buyer send ' + how);
    ok(!!owner && owner.html.includes('CONFIRMATION FAILED, RESEND MANUALLY'), 'owner html says the confirmation failed (' + how + ')');
    ok(!!owner && !owner.html.includes('SENT TO BUYER'), 'owner html does not claim it was sent (' + how + ')');
    ok(!!owner && owner.text.includes('CONFIRMATION FAILED, RESEND MANUALLY'), 'owner text says the confirmation failed (' + how + ')');
  }

  // --- if the owner copy fails the order is reported failed but not lost -----
  for (const [fail, how] of [[{ to: OWNER }, 'is rejected'], [{ to: OWNER, throws: true }, 'throws']]) {
    const env = { ...ENV, KV_REST_API_URL:'https://kv.example.com', KV_REST_API_TOKEN:'tok' };
    const { handler, calls } = load(env, fail);
    const r = res();
    await handler({ method:'POST', headers:{}, body: karim }, r);
    ok(r.code === 502 && r.body.error === 'send_failed', 'owner send that ' + how + ' reports send_failed', 'code ' + r.code);
    const kv = calls.find(c => c.url.includes('kv.example.com'));
    const saved = kv && JSON.parse(kv.body);
    ok(!!saved && saved.email === EMAIL && saved.ownerEmail === 'failed', 'order is written to the log when the owner send ' + how);
  }

  // --- validation ------------------------------------------------------
  const base = { name:'Karim Ahmed', phone:'01712345678', email: EMAIL, address:'Road 9, Dhanmondi, Dhaka', items:[{id:'shadows',qty:1}] };
  const bad = [
    [{ ...base, name:'X' }, 'name too short'],
    [{ ...base, phone:'12345' }, 'bad phone'],
    [{ ...base, address:'short' }, 'address too short'],
    [{ ...base, items:[] }, 'no items'],
    [{ ...base, email:'nope' }, 'bad email'],
    [{ ...base, email:'' }, 'empty email'],
    [{ ...base, email:'   ' }, 'blank email'],
    [{ ...base, email:'a'.repeat(115) + '@b.com' }, 'email over the length limit'],
    [{ ...base, items:[{id:'fake',qty:1}] }, 'unknown book id'],
  ];
  for (const [body, label] of bad) {
    const { handler, calls } = load(ENV);
    const r = res();
    await handler({ method:'POST', headers:{}, body }, r);
    ok(r.code === 400 && calls.filter(c => c.url.includes('resend')).length === 0, 'rejected: ' + label, 'code ' + r.code);
  }
  {
    // each rejection is for the reason named, not for something else
    const { handler } = load(ENV);
    const r = res();
    await handler({ method:'POST', headers:{}, body:{ ...base, email:'nope' } }, r);
    ok(JSON.stringify(r.body.errors) === '["email"]', 'a bad email is the only error reported', JSON.stringify(r.body.errors));
  }

  // --- price tampering --------------------------------------------------
  {
    const { handler, calls } = load(ENV);
    const r = res();
    await handler({ method:'POST', headers:{}, body:{
      ...base, subtotal: 1, price: 1 }}, r);
    const mail = ownerOf(calls);
    ok(mail.text.includes('BDT 1,499'), 'client-sent price ignored, server price used');
  }

  // --- quantity clamping -------------------------------------------------
  {
    const { handler, calls } = load(ENV);
    const r = res();
    await handler({ method:'POST', headers:{}, body:{
      ...base, items:[{id:'shadows',qty:999}] }}, r);
    const mail = ownerOf(calls);
    ok(mail.text.includes('x5'), 'quantity clamped to 5');
  }

  // --- honeypot ----------------------------------------------------------
  {
    const { handler, calls } = load(ENV);
    const r = res();
    await handler({ method:'POST', headers:{}, body:{
      name:'Bot', phone:'01712345678', address:'Road 9, Dhanmondi, Dhaka',
      items:[{id:'shadows',qty:1}], company:'spam co' }}, r);
    ok(r.code === 200 && calls.length === 0, 'honeypot: silently accepted, nothing sent');
  }

  // --- method guard -------------------------------------------------------
  {
    const { handler } = load(ENV);
    const r = res();
    await handler({ method:'GET', headers:{} }, r);
    ok(r.code === 405, 'GET rejected');
  }

  // --- missing API key ----------------------------------------------------
  {
    const { handler } = load({ ORDER_TO:'contact@shimantodewan.com' });
    const r = res();
    await handler({ method:'POST', headers:{}, body: base }, r);
    ok(r.code === 500 && r.body.error === 'not_configured', 'missing key reported honestly');
  }

  // --- turnstile ----------------------------------------------------------
  {
    const env = { ...ENV, TURNSTILE_SECRET: 'secret' };
    const a = load(env), ra = res();
    await a.handler({ method:'POST', headers:{}, body:{
      ...base, 'cf-turnstile-response':'bad-token' }}, ra);
    ok(ra.code === 400 && ra.body.error === 'verification', 'turnstile rejects a bad token');

    const b = load(env), rb = res();
    await b.handler({ method:'POST', headers:{}, body:{
      ...base, 'cf-turnstile-response':'good-token' }}, rb);
    ok(rb.code === 200, 'turnstile accepts a good token');
  }

  // --- order log ----------------------------------------------------------
  {
    const env = { ...ENV, KV_REST_API_URL:'https://kv.example.com', KV_REST_API_TOKEN:'tok' };
    const { handler, calls } = load(env);
    const r = res();
    await handler({ method:'POST', headers:{}, body: base }, r);
    const kv = calls.find(c => c.url.includes('kv.example.com'));
    ok(!!kv && kv.url.includes('/lpush/orders'), 'order appended to the log');
    ok(kv && JSON.parse(kv.body).ref, 'logged record carries the reference');
    ok(kv && JSON.parse(kv.body).email === EMAIL, 'logged record carries the buyer email');
  }

  // --- discount codes ------------------------------------------------------
  {
    const env = { ...ENV, ORDER_CODES: 'PREORDER20,FRIENDS', ORDER_CODE_PERCENT: '20' };
    const four = [{id:'original',qty:1},{id:'inside',qty:1},{id:'influence',qty:1},{id:'shadows',qty:1}];

    const a = load(env), ra = res();
    await a.handler({ method:'POST', headers:{}, body:{
      name:'Rifat Hossain', phone:'01712345678', email:'rifat@example.com', address:'House 4, Banani, Dhaka',
      items: four, code:'preorder20' }}, ra);
    const ma = ownerOf(a.calls);
    ok(ra.code === 200, 'order with a valid code accepted');
    ok(ma.text.includes('- BDT 1,000'), 'twenty percent taken off in the email');
    ok(ma.text.includes('BDT 3,999'), 'books total after discount', ma.text.match(/Books:.*/)[0]);
    ok(ma.text.includes('BDT 4,099'), 'grand total after discount');

    // a wrong code must change nothing
    const b = load(env), rb = res();
    await b.handler({ method:'POST', headers:{}, body:{
      name:'Rifat Hossain', phone:'01712345678', email:'rifat@example.com', address:'House 4, Banani, Dhaka',
      items: four, code:'NOTACODE' }}, rb);
    const mb = ownerOf(b.calls);
    ok(rb.code === 200, 'order with a bad code still accepted');
    ok(!mb.text.includes('% off'), 'no discount applied for a bad code');
    ok(mb.text.includes('BDT 5,099'), 'full total kept for a bad code');

    // the critical one: the browser cannot grant itself a discount
    const c = load(env), rc = res();
    await c.handler({ method:'POST', headers:{}, body:{
      name:'Rifat Hossain', phone:'01712345678', email:'rifat@example.com', address:'House 4, Banani, Dhaka',
      items: four, code:'NOTACODE', discount: 4000, payable: 999, codePercent: 90 }}, rc);
    const mc = ownerOf(c.calls);
    ok(mc.text.includes('BDT 5,099'), 'forged discount fields in the request are ignored');

    // with no codes configured nothing is discounted
    const e = load({ ...ENV }), re_ = res();
    await e.handler({ method:'POST', headers:{}, body:{
      name:'Rifat Hossain', phone:'01712345678', email:'rifat@example.com', address:'House 4, Banani, Dhaka',
      items: four, code:'PREORDER20' }}, re_);
    const me = ownerOf(e.calls);
    ok(me.text.includes('BDT 5,099'), 'no ORDER_CODES set means no code works');
  }

  console.log('\n' + (fails.length ? fails.length + ' FAILURES' : 'all server checks passed'));
  process.exit(fails.length ? 1 : 0);
})();

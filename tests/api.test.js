const fs = require('fs');
const src = fs.readFileSync('api/order.js', 'utf8');

function load(env) {
  const calls = [];
  const fakeFetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body });
    if (String(url).includes('siteverify')) {
      const sent = JSON.parse(opts.body);
      return { ok: true, json: async () => ({ success: sent.response === 'good-token' }) };
    }
    if (String(url).includes('resend')) return { ok: true, text: async () => 'ok', json: async () => ({ id: 'x' }) };
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
    const mails = calls.filter(c => c.url.includes('resend'));
    ok(mails.length === 2, 'two emails sent, owner and buyer', 'got ' + mails.length);
    const owner = JSON.parse(mails[0].body), buyer = JSON.parse(mails[1].body);
    ok(owner.to[0] === 'contact@shimantodewan.com', 'owner email addressed correctly');
    ok(owner.reply_to === 'rifat@example.com', 'reply-to is the buyer');
    ok(buyer.to[0] === 'rifat@example.com', 'buyer confirmation addressed correctly');
    ok(owner.text.includes('BDT 4,999'), 'bundle price in owner email');
    ok(owner.text.includes('- BDT 997'), 'bundle saving shown');
    ok(buyer.text.includes('late November 2026'), 'dispatch date in buyer email');
    ok(buyer.text.includes('cancel any time before dispatch'), 'cancellation terms in buyer email');
    ok(buyer.html.includes('do not send payment'), 'payment warning in buyer email');
  }

  // --- no buyer email: one mail only -----------------------------------
  {
    const { handler, calls } = load(ENV);
    const r = res();
    await handler({ method:'POST', headers:{}, body:{
      name:'Karim', phone:'01812345678', address:'Road 9, Dhanmondi, Dhaka',
      items:[{id:'shadows',qty:1}] }}, r);
    ok(r.code === 200, 'order without email accepted');
    ok(calls.filter(c => c.url.includes('resend')).length === 1, 'only the owner is emailed');
  }

  // --- validation ------------------------------------------------------
  const bad = [
    [{ name:'X', phone:'01712345678', address:'Road 9, Dhanmondi, Dhaka', items:[{id:'shadows',qty:1}] }, 'name too short'],
    [{ name:'Karim Ahmed', phone:'12345', address:'Road 9, Dhanmondi, Dhaka', items:[{id:'shadows',qty:1}] }, 'bad phone'],
    [{ name:'Karim Ahmed', phone:'01712345678', address:'short', items:[{id:'shadows',qty:1}] }, 'address too short'],
    [{ name:'Karim Ahmed', phone:'01712345678', address:'Road 9, Dhanmondi, Dhaka', items:[] }, 'no items'],
    [{ name:'Karim Ahmed', phone:'01712345678', address:'Road 9, Dhanmondi, Dhaka', email:'nope', items:[{id:'shadows',qty:1}] }, 'bad email'],
    [{ name:'Karim Ahmed', phone:'01712345678', address:'Road 9, Dhanmondi, Dhaka', items:[{id:'fake',qty:1}] }, 'unknown book id'],
  ];
  for (const [body, label] of bad) {
    const { handler, calls } = load(ENV);
    const r = res();
    await handler({ method:'POST', headers:{}, body }, r);
    ok(r.code === 400 && calls.filter(c => c.url.includes('resend')).length === 0, 'rejected: ' + label, 'code ' + r.code);
  }

  // --- price tampering --------------------------------------------------
  {
    const { handler, calls } = load(ENV);
    const r = res();
    await handler({ method:'POST', headers:{}, body:{
      name:'Karim Ahmed', phone:'01712345678', address:'Road 9, Dhanmondi, Dhaka',
      items:[{id:'shadows',qty:1}], subtotal: 1, price: 1 }}, r);
    const mail = JSON.parse(calls.find(c => c.url.includes('resend')).body);
    ok(mail.text.includes('BDT 1,499'), 'client-sent price ignored, server price used');
  }

  // --- quantity clamping -------------------------------------------------
  {
    const { handler, calls } = load(ENV);
    const r = res();
    await handler({ method:'POST', headers:{}, body:{
      name:'Karim Ahmed', phone:'01712345678', address:'Road 9, Dhanmondi, Dhaka',
      items:[{id:'shadows',qty:999}] }}, r);
    const mail = JSON.parse(calls.find(c => c.url.includes('resend')).body);
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
    await handler({ method:'POST', headers:{}, body:{
      name:'Karim Ahmed', phone:'01712345678', address:'Road 9, Dhanmondi, Dhaka',
      items:[{id:'shadows',qty:1}] }}, r);
    ok(r.code === 500 && r.body.error === 'not_configured', 'missing key reported honestly');
  }

  // --- turnstile ----------------------------------------------------------
  {
    const env = { ...ENV, TURNSTILE_SECRET: 'secret' };
    const a = load(env), ra = res();
    await a.handler({ method:'POST', headers:{}, body:{
      name:'Karim Ahmed', phone:'01712345678', address:'Road 9, Dhanmondi, Dhaka',
      items:[{id:'shadows',qty:1}], 'cf-turnstile-response':'bad-token' }}, ra);
    ok(ra.code === 400 && ra.body.error === 'verification', 'turnstile rejects a bad token');

    const b = load(env), rb = res();
    await b.handler({ method:'POST', headers:{}, body:{
      name:'Karim Ahmed', phone:'01712345678', address:'Road 9, Dhanmondi, Dhaka',
      items:[{id:'shadows',qty:1}], 'cf-turnstile-response':'good-token' }}, rb);
    ok(rb.code === 200, 'turnstile accepts a good token');
  }

  // --- order log ----------------------------------------------------------
  {
    const env = { ...ENV, KV_REST_API_URL:'https://kv.example.com', KV_REST_API_TOKEN:'tok' };
    const { handler, calls } = load(env);
    const r = res();
    await handler({ method:'POST', headers:{}, body:{
      name:'Karim Ahmed', phone:'01712345678', address:'Road 9, Dhanmondi, Dhaka',
      items:[{id:'shadows',qty:1}] }}, r);
    const kv = calls.find(c => c.url.includes('kv.example.com'));
    ok(!!kv && kv.url.includes('/lpush/orders'), 'order appended to the log');
    ok(kv && JSON.parse(kv.body).ref, 'logged record carries the reference');
  }

  // --- discount codes ------------------------------------------------------
  {
    const env = { ...ENV, ORDER_CODES: 'PREORDER20,FRIENDS', ORDER_CODE_PERCENT: '20' };
    const four = [{id:'original',qty:1},{id:'inside',qty:1},{id:'influence',qty:1},{id:'shadows',qty:1}];

    const a = load(env), ra = res();
    await a.handler({ method:'POST', headers:{}, body:{
      name:'Rifat Hossain', phone:'01712345678', address:'House 4, Banani, Dhaka',
      items: four, code:'preorder20' }}, ra);
    const ma = JSON.parse(a.calls.find(c => c.url.includes('resend')).body);
    ok(ra.code === 200, 'order with a valid code accepted');
    ok(ma.text.includes('- BDT 1,000'), 'twenty percent taken off in the email');
    ok(ma.text.includes('BDT 3,999'), 'books total after discount', ma.text.match(/Books:.*/)[0]);
    ok(ma.text.includes('BDT 4,099'), 'grand total after discount');

    // a wrong code must change nothing
    const b = load(env), rb = res();
    await b.handler({ method:'POST', headers:{}, body:{
      name:'Rifat Hossain', phone:'01712345678', address:'House 4, Banani, Dhaka',
      items: four, code:'NOTACODE' }}, rb);
    const mb = JSON.parse(b.calls.find(c => c.url.includes('resend')).body);
    ok(rb.code === 200, 'order with a bad code still accepted');
    ok(!mb.text.includes('% off'), 'no discount applied for a bad code');
    ok(mb.text.includes('BDT 5,099'), 'full total kept for a bad code');

    // the critical one: the browser cannot grant itself a discount
    const c = load(env), rc = res();
    await c.handler({ method:'POST', headers:{}, body:{
      name:'Rifat Hossain', phone:'01712345678', address:'House 4, Banani, Dhaka',
      items: four, code:'NOTACODE', discount: 4000, payable: 999, codePercent: 90 }}, rc);
    const mc = JSON.parse(c.calls.find(c2 => c2.url.includes('resend')).body);
    ok(mc.text.includes('BDT 5,099'), 'forged discount fields in the request are ignored');

    // with no codes configured nothing is discounted
    const e = load({ ...ENV }), re_ = res();
    await e.handler({ method:'POST', headers:{}, body:{
      name:'Rifat Hossain', phone:'01712345678', address:'House 4, Banani, Dhaka',
      items: four, code:'PREORDER20' }}, re_);
    const me = JSON.parse(e.calls.find(c2 => c2.url.includes('resend')).body);
    ok(me.text.includes('BDT 5,099'), 'no ORDER_CODES set means no code works');
  }

  console.log('\n' + (fails.length ? fails.length + ' FAILURES' : 'all server checks passed'));
  process.exit(fails.length ? 1 : 0);
})();

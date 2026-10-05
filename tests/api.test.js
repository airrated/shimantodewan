const fs = require('fs');
const src = fs.readFileSync('api/order.js', 'utf8');

// fail: { to, throws }  any Resend call addressed to `to` is answered with an
// error status, or throws when `throws` is set. { kv: 'status' | 'throws' }
// makes the Redis reference check fail instead.
// taken: reference codes already claimed in the fake Redis, e.g. ['AA2']
function load(env, fail, taken) {
  const calls = [];
  const store = new Set((taken || []).map((c) => 'ref:' + c));
  const fakeFetch = async (url, opts) => {
    calls.push({ url: String(url), body: opts && opts.body });
    if (String(url).includes('kv.example.com')) {
      if (String(url).includes('/lpush/')) return { ok: true, text: async () => 'ok', json: async () => ({ result: 1 }) };
      // the reference claim: ["SET", "ref:CODE", "1", "NX"]
      if (fail && fail.kv === 'throws') throw new Error('redis down');
      if (fail && fail.kv === 'status') return { ok: false, status: 500, json: async () => ({ error: 'boom' }) };
      const cmd = JSON.parse(opts.body);
      if (store.has(cmd[1])) return { ok: true, json: async () => ({ result: null }) };
      store.add(cmd[1]);
      return { ok: true, json: async () => ({ result: 'OK' }) };
    }
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
  return { handler: mod.exports, calls, store };
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
const lpushOf = (calls) => calls.find(c => c.url.includes('/lpush/orders'));

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
    ok(/^[A-HJ-NP-Z]{2}[2-9]$/.test(r.body.ref || ''), 'reference is two letters and a digit', r.body && r.body.ref);
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
    // the cancel instruction is its own block in the body, stated once
    const plain = buyer.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
    const at = (s, needle) => s.indexOf(needle);
    ok(buyer.html.includes('CHANGED YOUR MIND'), 'buyer html has the CHANGED YOUR MIND label');
    ok(buyer.html.includes('Reply to this email with the word <b style="color:#96382A;">CANCEL</b> in capitals'), 'CANCEL is bold in the accent colour');
    ok(/Reply to this email with the word CANCEL in capitals, any time before your order goes out\. No payment, no questions\./.test(plain), 'buyer html cancel wording is exact');
    ok(at(buyer.html, 'CHANGED YOUR MIND') > at(buyer.html, 'Please do not send payment') && at(buyer.html, 'CHANGED YOUR MIND') < at(buyer.html, 'Delivering to'), 'cancel block sits directly below What happens next');
    ok(/border-top:1px solid #DED3C6[^>]*>\s*CHANGED YOUR MIND/.test(buyer.html), 'thin rule above the cancel block');
    ok(/font-size:16px;line-height:1\.65[^>]*>\s*Reply to this email with the word/.test(buyer.html), 'cancel text is in the body serif at reading size');
    ok(!/TO CANCEL, REPLY/i.test(buyer.html), 'footer metadata no longer carries a cancel instruction');
    ok((buyer.html.match(/in capitals/g) || []).length === 1, 'buyer html states it once');
    ok(buyer.html.includes('CANCEL ANY TIME BEFORE DISPATCH FOR A FULL REFUND'), 'existing refund line left in the footer');
    ok(/\n\nChanged your mind\? Reply to this email with the word CANCEL in capitals, any time\nbefore your order goes out\. No payment, no questions\.\n\n/.test(buyer.text), 'buyer text has the paragraph with a blank line either side');
    ok(at(buyer.text, 'Changed your mind?') > at(buyer.text, 'Please do not send payment') && at(buyer.text, 'Changed your mind?') < at(buyer.text, 'Delivering to:'), 'text paragraph follows What happens next');
    ok(!/To cancel, reply/i.test(buyer.text), 'trailing text lines no longer carry the old cancel line');
    ok((buyer.text.match(/in capitals/g) || []).length === 1, 'buyer text states it once');
    ok(!/in capitals/i.test(owner.text + owner.html), 'cancel instruction is for the buyer only');
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

  // --- order reference: two letters and a digit, lengthened on a repeat -------
  {
    const KVENV = { ...ENV, KV_REST_API_URL:'https://kv.example.com', KV_REST_API_TOKEN:'tok' };
    const PLAIN = /^[A-HJ-NP-Z]{2}[2-9]$/;
    const body = { name:'Rifat Hossain', phone:'01712345678', email: EMAIL,
      address:'House 4, Road 11, Banani, Dhaka 1213', items:[{id:'shadows',qty:1}] };
    const place = async (h) => { const r = res(); await h.handler({ method:'POST', headers:{}, body }, r); return r; };
    const withRandom = async (fn) => { const real = Math.random; Math.random = () => 0; try { return await fn(); } finally { Math.random = real; } };

    // no Redis: nothing to check against, so the plain code is used
    {
      const h = load(ENV);
      const r = await place(h);
      ok(r.code === 200 && PLAIN.test(r.body.ref), 'without Redis the reference is plain two letters and a digit', r.body.ref);
      ok(!h.calls.some(c => c.url.includes('kv.example.com')), 'without Redis nothing is called to check it');
    }

    // the alphabet: no I or O, digits 2 to 9 only, over many draws
    {
      const h = load(ENV);
      let bad = 0; const seen = new Set();
      for (let i = 0; i < 400; i++) {
        const r = await place(h);
        if (!PLAIN.test(r.body.ref)) bad++;
        seen.add(r.body.ref);
      }
      ok(bad === 0, 'every one of 400 references uses only A-Z without I and O, and digits 2 to 9', bad + ' bad');
      ok(seen.size > 100, 'references vary between orders', seen.size + ' distinct of 400');
    }

    // with Redis a free code is claimed and used as it is
    {
      const h = load(KVENV);
      const r = await place(h);
      ok(PLAIN.test(r.body.ref), 'a free code stays at two letters and a digit', r.body.ref);
      ok(h.store.has('ref:' + r.body.ref), 'the code is claimed in Redis');
      ok(h.calls.findIndex(c => c.url.includes('kv.example.com') && !c.url.includes('/lpush/')) < h.calls.findIndex(c => c.url.includes('resend')), 'the code is claimed before any email is sent');
    }

    // a taken code gets another digit, and again, until it is free
    {
      const h = load(KVENV);                       // Math.random() = 0 always draws A, A, 2
      const refs = await withRandom(async () => [(await place(h)).body.ref, (await place(h)).body.ref, (await place(h)).body.ref, (await place(h)).body.ref]);
      ok(refs[0] === 'AA2', 'first order gets the plain code', refs[0]);
      ok(refs[1] === 'AA22', 'a repeat gets one more digit', refs[1]);
      ok(refs[2] === 'AA222', 'a second repeat gets another', refs[2]);
      ok(refs[3] === 'AA2222', 'and a third', refs[3]);
    }
    {
      const h = load(KVENV, null, ['AA2']);        // a code left over from earlier orders
      const r = await withRandom(() => place(h));
      ok(r.body.ref === 'AA22', 'a code taken before this run is lengthened too', r.body.ref);
    }

    // however many orders arrive, no two ever share a reference
    {
      const h = load(KVENV);
      const seen = new Set(); let longer = 0, bad = 0;
      for (let i = 0; i < 500; i++) {
        const ref = (await place(h)).body.ref;
        seen.add(ref);
        if (!/^[A-HJ-NP-Z]{2}[2-9]+$/.test(ref)) bad++;
        if (ref.length > 3) longer++;
      }
      ok(seen.size === 500, '500 orders give 500 different references', seen.size + ' distinct');
      ok(bad === 0, 'lengthened references keep the shape letters then digits', bad + ' bad');
      ok(longer > 0, 'some of the 500 needed a longer code, as the maths predicts', longer + ' longer');
    }

    // the check is best effort: Redis trouble never fails or holds up an order
    for (const [fail, how] of [[{ kv: 'status' }, 'returns an error'], [{ kv: 'throws' }, 'is unreachable']]) {
      const h = load(KVENV, fail);
      const r = await place(h);
      ok(r.code === 200 && PLAIN.test(r.body.ref), 'order still goes through when Redis ' + how, r.body.ref);
      ok(resendMails(h.calls).length === 2, 'both emails still sent when Redis ' + how);
    }

    // the same reference appears everywhere it is used
    {
      const h = load(KVENV);
      const r = await place(h);
      const ref = r.body.ref, owner = ownerOf(h.calls), buyer = buyerOf(h.calls), kv = lpushOf(h.calls);
      ok(owner.subject.startsWith('Pre-order ' + ref + ' - '), 'owner subject carries the reference', owner.subject);
      ok(buyer.subject.includes(ref), 'buyer subject carries the reference', buyer.subject);
      ok(owner.text.includes('Reference: ' + ref) && owner.html.includes(ref), 'owner email bodies carry the reference');
      ok(buyer.text.includes('Reference: ' + ref) && buyer.html.includes(ref), 'buyer email bodies carry the reference');
      ok(!!kv && JSON.parse(kv.body).ref === ref, 'order log record carries the same reference');
      ok(!/BTE/.test(owner.text + owner.html + buyer.text + buyer.html + owner.subject + buyer.subject), 'no trace of the old BTE format');
    }
  }

  // --- owner and buyer emails show the same numbers --------------------------
  // Both are built from the same helpers, so they cannot disagree. This is the
  // check that would have caught the owner email ignoring bundle and discount.
  {
    const four = [{id:'original',qty:1},{id:'inside',qty:1},{id:'influence',qty:1},{id:'shadows',qty:1}];
    const codeEnv = { ...ENV, ORDER_CODES: 'PREORDER20', ORDER_CODE_PERCENT: '20' };
    const cases = [
      { label: 'a single book',                 env: ENV,     body: { items: [{id:'shadows',qty:1}] },        grand: 1599, bundle: false, discount: false },
      { label: 'all four with the bundle',      env: ENV,     body: { items: four },                          grand: 5099, bundle: true,  discount: false },
      { label: 'all four with a discount code', env: codeEnv, body: { items: four, code: 'preorder20' },      grand: 4099, bundle: true,  discount: true  },
    ];
    const flat = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&times;/g, 'x').replace(/&nbsp;/g, ' ').replace(/&middot;/g, ' ').replace(/\s+/g, ' ');
    const num = (m) => (m ? Number(m[1].replace(/,/g, '')) : NaN);
    const sumItems = (s) => [...s.matchAll(/x\d+ BDT ([\d,]+)/g)].reduce((a, m) => a + Number(m[1].replace(/,/g, '')), 0);
    const moneyLines = (t) => t.split('\n').filter((l) => /^  \S.*BDT/.test(l));

    for (const c of cases) {
      const { handler, calls } = load(c.env);
      const r = res();
      await handler({ method:'POST', headers:{}, body:{ name:'Rifat Hossain', phone:'01712345678', email:'rifat@example.com',
        address:'House 4, Road 11, Banani, Dhaka 1213', ...c.body } }, r);
      const owner = ownerOf(calls), buyer = buyerOf(calls);
      const oh = flat(owner.html), bh = flat(buyer.html);

      const grandOf = (s) => num(s.match(/Approximate total BDT ([\d,]+)/));
      const grandText = (t) => num(t.match(/Approximate total: BDT ([\d,]+)/));
      ok(grandOf(oh) === c.grand, c.label + ': owner html grand total', 'BDT ' + grandOf(oh));
      ok(grandOf(bh) === c.grand, c.label + ': buyer html grand total', 'BDT ' + grandOf(bh));
      ok(grandText(owner.text) === c.grand, c.label + ': owner text grand total', 'BDT ' + grandText(owner.text));
      ok(grandText(buyer.text) === c.grand, c.label + ': buyer text grand total', 'BDT ' + grandText(buyer.text));

      // the lines shown must add up to the total shown, in each HTML email
      for (const [who, s] of [['owner', oh], ['buyer', bh]]) {
        const saving = num(s.match(/Bundle, all four x\d+ - BDT ([\d,]+)/)) || 0;
        const disc = num(s.match(/% off - BDT ([\d,]+)/)) || 0;
        const delivery = num(s.match(/Delivery, Pathao, approx\. BDT ([\d,]+)/));
        const shown = sumItems(s) - saving - disc + delivery;
        ok(shown === c.grand, c.label + ': ' + who + ' html lines add up to the total', shown + ' vs ' + c.grand);
        ok(/Bundle, all four/.test(s) === c.bundle, c.label + ': ' + who + ' html bundle row ' + (c.bundle ? 'shown' : 'absent'));
        ok(/% off/.test(s) === c.discount, c.label + ': ' + who + ' html discount row ' + (c.discount ? 'shown' : 'absent'));
      }

      // and the plain-text order blocks are identical, line for line
      ok(moneyLines(owner.text).length > 0 && JSON.stringify(moneyLines(owner.text)) === JSON.stringify(moneyLines(buyer.text)),
         c.label + ': owner and buyer text show identical order lines');
    }
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
    const kv = lpushOf(calls);
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
    const kv = lpushOf(calls);
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
    ok(ma.text.includes('BDT 3,999'), 'books total after discount', (ma.text.match(/Books total:.*/) || [''])[0]);
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

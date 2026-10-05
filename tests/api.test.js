const fs = require('fs');
const src = fs.readFileSync('api/order.js', 'utf8');

// fail: { to, throws }  any Resend call addressed to `to` is answered with an
// error status, or throws when `throws` is set. { kv: 'status' | 'throws' }
// makes the Redis reference check fail instead.
// taken: reference codes already claimed in the fake Redis, e.g. ['AA2']
// source: a modified copy of api/order.js to run instead, e.g. with a price
// changed so the floor can be driven; `warns` collects console.warn output
function load(env, fail, taken, source) {
  const calls = [], warns = [];
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
  new Function('module', 'exports', 'process', 'fetch', 'console', 'require', source || src)(
    mod, mod.exports, { env }, fakeFetch,
    { error: () => {}, log: () => {}, warn: (...a) => { warns.push(a.join(' ')); } }, req
  );
  return { handler: mod.exports, calls, store, warns };
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
    ok(owner.text.includes('Books total: BDT 3,799'), 'set price in owner email');
    ok(owner.text.includes('Bundle:  - BDT 197'), 'bundle saving shown against four singles at 999');
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
    {
      const flatText = buyer.text.replace(/\s+/g, ' '), flatHtml = buyer.html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ');
      const want = 'send the payment details for bKash, Nagad, Bank Transfer or RedotPay then.';
      ok(flatText.includes(want), 'buyer text names all four payment options');
      ok(flatHtml.includes(want), 'buyer html names all four payment options');
      ok(!/the bKash details/.test(flatText + flatHtml), 'no bKash-only wording left in the buyer email');
      ok(flatText.includes(want + ' Please do not send payment before that.') && flatHtml.includes(want + ' Please do not send payment before that.'), 'the do-not-pay-yet line follows, intact');
      ok(buyer.html.includes('<b>Please do not send payment before that.</b>'), 'and stays bold in the html');
    }
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

  // --- fixed prices, and the owner and buyer emails showing the same numbers ---
  // The expected figures are written out here by hand, not read from the code
  // under test: a book is 999, or 699 with a code; all four are 3,799, or 2,499
  // with a code; delivery is 100 and never discounted. Savings are shown against
  // every book at 999, as a Bundle line, a Code line, or both. No percentages.
  const SAK = { ...ENV, ORDER_CODES: 'SAKURA30' };
  const one = [{id:'shadows',qty:1}];
  const four = [{id:'original',qty:1},{id:'inside',qty:1},{id:'influence',qty:1},{id:'shadows',qty:1}];
  const five = [{id:'original',qty:2},{id:'inside',qty:1},{id:'influence',qty:1},{id:'shadows',qty:1}];   // a set plus one single
  const eight = [{id:'original',qty:2},{id:'inside',qty:2},{id:'influence',qty:2},{id:'shadows',qty:2}];  // two sets
  const fmt = (n) => n.toLocaleString('en-US');
  const flat = (h) => h.replace(/<[^>]+>/g, ' ').replace(/&times;/g, 'x').replace(/&nbsp;/g, ' ').replace(/&middot;/g, ' ').replace(/\s+/g, ' ');
  const num = (m) => (m ? Number(m[1].replace(/,/g, '')) : NaN);
  const sumItems = (s) => [...s.matchAll(/x\d+ BDT ([\d,]+)/g)].reduce((a, m) => a + Number(m[1].replace(/,/g, '')), 0);
  const bundleOf = (s) => num(s.match(/Bundle - BDT ([\d,]+)/)) || 0;
  const codeOf = (s) => num(s.match(/Code \S+ - BDT ([\d,]+)/)) || 0;
  const deliveryOf = (s) => num(s.match(/Delivery, Pathao, approx\. BDT ([\d,]+)/));
  const moneyLines = (t) => t.split('\n').filter((l) => /^  \S.*BDT/.test(l));
  const person = { name:'Rifat Hossain', phone:'01712345678', email:'rifat@example.com', address:'House 4, Road 11, Banani, Dhaka 1213' };
  {
    const cases = [
      { label: 'one book',                  env: ENV, body: { items: one },                     books: 999,  grand: 1099, bundle: 0,   code: 0 },
      { label: 'one book with code',        env: SAK, body: { items: one,   code: 'sakura30' }, books: 699,  grand: 799,  bundle: 0,   code: 300 },
      { label: 'four books',                env: ENV, body: { items: four },                    books: 3799, grand: 3899, bundle: 197, code: 0 },
      { label: 'four books with code',      env: SAK, body: { items: four,  code: 'sakura30' }, books: 2499, grand: 2599, bundle: 197, code: 1300 },
      { label: 'five books (set + single)', env: ENV, body: { items: five },                    books: 4798, grand: 4898, bundle: 197, code: 0 },
      { label: 'five books with code',      env: SAK, body: { items: five,  code: 'sakura30' }, books: 3198, grand: 3298, bundle: 197, code: 1600 },
      { label: 'eight books (two sets)',    env: ENV, body: { items: eight },                   books: 7598, grand: 7698, bundle: 394, code: 0 },
      { label: 'eight books with code',     env: SAK, body: { items: eight, code: 'sakura30' }, books: 4998, grand: 5098, bundle: 394, code: 2600 },
    ];

    for (const c of cases) {
      const { handler, calls } = load(c.env);
      const r = res();
      await handler({ method:'POST', headers:{}, body:{ ...person, ...c.body } }, r);
      const owner = ownerOf(calls), buyer = buyerOf(calls);
      const oh = flat(owner.html), bh = flat(buyer.html);
      ok(r.code === 200, c.label + ': order accepted');
      ok(owner.text.includes('Books total: BDT ' + fmt(c.books)), c.label + ': books total is BDT ' + fmt(c.books), (owner.text.match(/Books total:.*/) || [''])[0]);

      const grandOf = (s) => num(s.match(/Approximate total BDT ([\d,]+)/));
      const grandText = (t) => num(t.match(/Approximate total: BDT ([\d,]+)/));
      ok(grandOf(oh) === c.grand, c.label + ': owner html grand total BDT ' + fmt(c.grand), 'BDT ' + grandOf(oh));
      ok(grandOf(bh) === c.grand, c.label + ': buyer html grand total', 'BDT ' + grandOf(bh));
      ok(grandText(owner.text) === c.grand, c.label + ': owner text grand total', 'BDT ' + grandText(owner.text));
      ok(grandText(buyer.text) === c.grand, c.label + ': buyer text grand total', 'BDT ' + grandText(buyer.text));
      ok(owner.text.includes('Delivery, approx: BDT 100') && deliveryOf(oh) === 100, c.label + ': delivery is 100 and never discounted');

      // the lines shown must add up to the total shown, in each HTML email
      for (const [who, s] of [['owner', oh], ['buyer', bh]]) {
        const shown = sumItems(s) - bundleOf(s) - codeOf(s) + deliveryOf(s);
        ok(shown === c.grand, c.label + ': ' + who + ' html lines add up to the total', shown + ' vs ' + c.grand);
        ok(bundleOf(s) === c.bundle && /Bundle - BDT/.test(s) === (c.bundle > 0), c.label + ': ' + who + ' Bundle line ' + (c.bundle ? '- BDT ' + fmt(c.bundle) : 'absent'), 'got ' + bundleOf(s));
        ok(codeOf(s) === c.code && /Code SAKURA30 - BDT/.test(s) === (c.code > 0), c.label + ': ' + who + ' Code SAKURA30 line ' + (c.code ? '- BDT ' + fmt(c.code) : 'absent'), 'got ' + codeOf(s));
      }
      ok(owner.text.includes('Bundle:  - BDT ' + fmt(c.bundle)) === (c.bundle > 0), c.label + ': text Bundle line matches');
      ok(owner.text.includes('Code SAKURA30:  - BDT ' + fmt(c.code)) === (c.code > 0), c.label + ': text Code line matches');
      ok(!/%/.test(oh + bh + owner.text + buyer.text), c.label + ': no percentage appears in either email');

      // and the plain-text order blocks are identical, line for line
      ok(moneyLines(owner.text).length > 0 && JSON.stringify(moneyLines(owner.text)) === JSON.stringify(moneyLines(buyer.text)),
         c.label + ': owner and buyer text show identical order lines');
    }
  }

  // --- the price floor: never less than 599 a book -------------------------------
  // At today's prices it cannot bind (2,499 for four is 625 a book), so the
  // test changes a price in a copy of the server source to drive it.
  {
    const tweak = (from, to) => { const s = src.replace(from, to); if (s === src) throw new Error('test setup: ' + from + ' not found in api/order.js'); return s; };
    const place = async (h, items) => { const r = res(); await h.handler({ method:'POST', headers:{}, body:{ ...person, items, code: 'sakura30' } }, r); return r; };

    // at the real prices it never fires, even on the cheapest orders
    {
      const h = load(SAK);
      await place(h, one); await place(h, four); await place(h, five); await place(h, eight);
      ok(h.warns.length === 0, 'at the real prices the floor never fires and nothing is logged', h.warns.length + ' warnings');
    }

    // four for 1,999 is under the floor of 4 x 599 = 2,396
    {
      const h = load(SAK, null, null, tweak('SET_CODE = 2499', 'SET_CODE = 1999'));
      const r = await place(h, four), owner = ownerOf(h.calls), buyer = buyerOf(h.calls), oh = flat(owner.html);
      ok(r.code === 200, 'an order that hits the floor is still accepted');
      ok(owner.text.includes('Books total: BDT 2,396'), 'the books are charged the floor, BDT 2,396', (owner.text.match(/Books total:.*/) || [''])[0]);
      ok(!owner.text.includes('Books total: BDT 1,999'), 'the lower computed price is not charged');
      ok(owner.text.includes('Approximate total: BDT 2,496') && buyer.text.includes('Approximate total: BDT 2,496'), 'the floor carries into the total in both emails');
      const shown = sumItems(oh) - bundleOf(oh) - codeOf(oh) + deliveryOf(oh);
      ok(shown === 2496, 'the owner email lines still add up when the floor has changed the price', shown + ' vs 2496');
      ok(h.warns.length === 1, 'exactly one warning is logged', h.warns.length + ' warnings');
      const w = h.warns[0] || '';
      ok(/PRICE FLOOR/.test(w), 'the warning says what happened', w);
      ok(w.includes('BDT 1,999'), 'it names the computed subtotal', w);
      ok(w.includes('BDT 2,396'), 'it names the floor', w);
      ok(w.includes(r.body.ref) && /^[A-HJ-NP-Z]{2}[2-9]/.test(r.body.ref), 'it names the order reference', w);
    }

    // one book at 399 is under the floor of 599
    {
      const h = load(SAK, null, null, tweak('SINGLE_CODE = 699', 'SINGLE_CODE = 399'));
      const r = await place(h, one), owner = ownerOf(h.calls);
      ok(owner.text.includes('Books total: BDT 599') && owner.text.includes('Approximate total: BDT 699'), 'a single is charged the floor, BDT 599');
      ok(h.warns.length === 1 && h.warns[0].includes('BDT 399') && h.warns[0].includes('BDT 599') && h.warns[0].includes(r.body.ref), 'and the warning names 399, 599 and the reference', h.warns[0]);
    }

    // prices above the floor are never touched: 2,396 is exactly 599 a book, 2,400 is above it
    for (const [price, tag] of [[2396, 'exactly at'], [2400, 'above']]) {
      const h = load(SAK, null, null, tweak('SET_CODE = 2499', 'SET_CODE = ' + price));
      await place(h, four);
      ok(ownerOf(h.calls).text.includes('Books total: BDT ' + fmt(price)) && h.warns.length === 0, 'a set price ' + tag + ' the floor is charged as it is, with no warning', fmt(price));
    }

    // without a code the floor is checked too
    {
      const h = load(ENV, null, null, tweak('SINGLE = 999', 'SINGLE = 500'));
      const r = res();
      await h.handler({ method:'POST', headers:{}, body:{ ...person, items: one } }, r);
      ok(ownerOf(h.calls).text.includes('Books total: BDT 599') && h.warns.length === 1, 'the floor also applies to orders without a code');
    }
  }

  // --- the pages and the server agree on every total -----------------------------
  // Each page's own priceOrder is driven through its real controls (ticking
  // books, choosing quantities, applying the code) and compared with what the
  // server puts in the owner email for the same order. Run on both pages.
  {
    const { JSDOM } = require('jsdom');
    const codesLib = (() => { const m = { exports: {} }; new Function('module', 'exports', 'process', fs.readFileSync('lib/codes.js', 'utf8'))(m, m.exports, { env: SAK }); return m.exports; })();
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const toItems = (o) => Object.keys(o).map((id) => ({ id, qty: o[id] }));
    const moneyNum = (t) => Number(String(t).replace(/[^0-9]/g, ''));
    const sels = [
      ['one book',               { shadows: 1 }],
      ['two books',              { original: 1, inside: 1 }],
      ['three books',            { original: 1, inside: 1, influence: 1 }],
      ['all four',               { original: 1, inside: 1, influence: 1, shadows: 1 }],
      ['a set and one single',   { original: 2, inside: 1, influence: 1, shadows: 1 }],
      ['two sets',               { original: 2, inside: 2, influence: 2, shadows: 2 }],
      ['a set and four singles', { original: 5, inside: 1, influence: 1, shadows: 1 }],
      ['five of one book',       { shadows: 5 }],
      ['the largest order',      { original: 5, inside: 5, influence: 5, shadows: 5 }],
    ];

    async function agree(tag, pageHtml, serverSrc) {
      const dom = new JSDOM(pageHtml, {
        runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://shimantodewan.com/contact',
        beforeParse(w) {
          w.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} };
          w.matchMedia = w.matchMedia || (q => ({ matches:false, media:q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
          w.scrollTo = () => {};
          w.fetch = (url, opts) => {
            if (String(url).includes('/api/code')) return Promise.resolve({ ok: true, json: () => Promise.resolve({ valid: codesLib.valid(JSON.parse(opts.body).code) }) });
            return Promise.reject(new Error('blocked ' + url));
          };
        },
      });
      const w = dom.window, d = w.document;
      await wait(150); w.dispatchEvent(new w.Event('load')); await wait(50);
      const boxes = [...d.querySelectorAll('input[name="book"]')];
      const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
      const server = load(SAK, null, null, serverSrc);

      const choose = (sel) => boxes.forEach((b) => {
        const want = sel[b.value] || 0;
        b.checked = want > 0; fire(b, 'change');
        if (want) { const s = b.closest('.pick').querySelector('select'); s.value = String(want); fire(s, 'change'); }
      });
      const fromPage = () => {
        const shown = (id) => !d.getElementById(id).hidden;
        return {
          baseline: moneyNum(d.getElementById('t-sub').textContent),
          bundle: shown('t-save') ? moneyNum(d.getElementById('t-save-val').textContent) : 0,
          code: shown('t-disc') ? moneyNum(d.getElementById('t-disc-val').textContent) : 0,
          grand: moneyNum(d.getElementById('t-grand').textContent),
        };
      };
      const fromServer = async (sel, withCode) => {
        const r = res();
        await server.handler({ method:'POST', headers:{}, body:{ ...person, items: toItems(sel), code: withCode ? 'sakura30' : '' } }, r);
        const t = resendMails(server.calls).filter((m) => m.to.includes(OWNER)).pop().text;
        const n = (re) => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, '')) : 0; };
        return {
          baseline: [...t.matchAll(/ x\d+   BDT ([\d,]+)/g)].reduce((a, m) => a + Number(m[1].replace(/,/g, '')), 0),
          bundle: n(/Bundle:  - BDT ([\d,]+)/),
          code: n(/Code \S+:  - BDT ([\d,]+)/),
          grand: n(/Approximate total: BDT ([\d,]+)/),
        };
      };

      for (const withCode of [false, true]) {
        if (withCode) {
          const input = d.getElementById('o-code');
          input.value = 'sakura30';
          d.getElementById('code-go').dispatchEvent(new w.Event('click', { bubbles: true }));
          await wait(60);
          ok(d.getElementById('code-msg').textContent === 'Code applied' && !/%/.test(d.getElementById('code-msg').textContent), tag + ': the code is accepted, with no percentage in the message', d.getElementById('code-msg').textContent);
        }
        for (const [label, sel] of sels) {
          choose(sel);
          const page = fromPage(), srv = await fromServer(sel, withCode);
          ok(JSON.stringify(page) === JSON.stringify(srv), tag + ': ' + label + (withCode ? ' with code' : '') + ' - page and server agree', 'page ' + JSON.stringify(page) + ' / server ' + JSON.stringify(srv));
        }
      }
      // the code row carries the code's name and never a percentage
      choose(sels[3][1]);
      ok(d.getElementById('t-disc-label').textContent === 'Code SAKURA30', tag + ': the code row is labelled Code SAKURA30', d.getElementById('t-disc-label').textContent);
      ok(d.querySelector('#t-save > span').textContent === 'Bundle', tag + ': the bundle row is labelled Bundle', d.querySelector('#t-save > span').textContent);
      ok(!/%/.test(d.getElementById('totals').textContent), tag + ': no percentage anywhere in the totals');
      w.close();
    }

    for (const file of ['contact/index.html', 'info/index.html']) {
      const html = fs.readFileSync(file, 'utf8');
      await agree(file, html, src);

      // and when the floor binds: lower the code set price in both copies and compare again
      const lowPage = html.replace('SET_CODE = 2499', 'SET_CODE = 1999');
      const lowSrc = src.replace('SET_CODE = 2499', 'SET_CODE = 1999');
      ok(lowPage !== html && lowSrc !== src, file + ': test setup changed the set code price in both copies');
      await agree(file + ' (floor binding)', lowPage, lowSrc);
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
    ok(mail.text.includes('Books total: BDT 999'), 'client-sent price ignored, server price used');
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
  // A code switches the order to the fixed code prices; it takes no percentage.
  {
    const env = { ...ENV, ORDER_CODES: 'SAKURA30,FRIENDS' };
    const order = async (e, extra) => {
      const h = load(e), r = res();
      await h.handler({ method:'POST', headers:{}, body:{ ...person, items: four, ...extra } }, r);
      return { r, mail: ownerOf(h.calls) };
    };

    const a = await order(env, { code: 'sakura30' });
    ok(a.r.code === 200, 'order with a valid code accepted');
    ok(a.mail.text.includes('Code SAKURA30:  - BDT 1,300'), 'the code takes BDT 1,300 off the set, to 2,499');
    ok(a.mail.text.includes('Books total: BDT 2,499') && a.mail.text.includes('Approximate total: BDT 2,599'), 'books total BDT 2,499 and BDT 2,599 with delivery', (a.mail.text.match(/Books total:.*/) || [''])[0]);
    ok(!/%/.test(a.mail.text), 'no percentage in the email');

    // case and spacing are never the reason a code fails, and the label shows the clean code
    const sp = await order(env, { code: '  Sakura 30 ' });
    ok(sp.mail.text.includes('Code SAKURA30:  - BDT 1,300'), 'case and spaces in the typed code are ignored');
    const fr = await order(env, { code: 'friends' });
    ok(fr.mail.text.includes('Code FRIENDS:  - BDT 1,300') && fr.mail.text.includes('Books total: BDT 2,499'), 'every code in ORDER_CODES gives the same prices');

    // a wrong code must change nothing
    const b = await order(env, { code: 'NOTACODE' });
    ok(b.r.code === 200, 'order with a bad code still accepted');
    ok(!/\n  Code /.test(b.mail.text), 'no code line at all for a bad code');
    ok(b.mail.text.includes('Books total: BDT 3,799') && b.mail.text.includes('Approximate total: BDT 3,899'), 'full prices kept for a bad code');

    // the critical one: the browser cannot grant itself a price
    const c = await order(env, { code: 'NOTACODE', discount: 4000, payable: 999, codePercent: 90, price: 1, subtotal: 1, codeSaving: 9999, bundleSaving: 9999 });
    ok(c.mail.text.includes('Books total: BDT 3,799') && c.mail.text.includes('Approximate total: BDT 3,899'), 'forged price and discount fields in the request are ignored');

    // with no codes configured nothing is discounted, and the retired code is dead
    const e = await order({ ...ENV }, { code: 'SAKURA30' });
    ok(e.mail.text.includes('Approximate total: BDT 3,899'), 'no ORDER_CODES set means no code works');
    const old = await order(env, { code: 'PREORDER20' });
    ok(old.mail.text.includes('Approximate total: BDT 3,899'), 'a code that is not in ORDER_CODES gives nothing');
  }

  // --- /api/code answers yes or no, never a percentage ---------------------------
  {
    const codeSrc = fs.readFileSync('api/code.js', 'utf8');
    const libSrc = fs.readFileSync('lib/codes.js', 'utf8');
    const run = async (env, body, method) => {
      const lib = { exports: {} }; new Function('module', 'exports', 'process', libSrc)(lib, lib.exports, { env });
      const mod = { exports: {} };
      new Function('module', 'exports', 'require', codeSrc)(mod, mod.exports, () => lib.exports);
      const r = res(); await mod.exports({ method: method || 'POST', body, headers: {} }, r); return r;
    };
    const yes = await run({ ORDER_CODES: 'SAKURA30' }, { code: ' sakura30 ' });
    ok(yes.code === 200 && JSON.stringify(yes.body) === '{"valid":true}', '/api/code says valid, and nothing else', JSON.stringify(yes.body));
    const no = await run({ ORDER_CODES: 'SAKURA30' }, { code: 'nope' });
    ok(no.code === 200 && JSON.stringify(no.body) === '{"valid":false}', '/api/code says not valid, and nothing else', JSON.stringify(no.body));
    const none = await run({}, { code: 'SAKURA30' });
    ok(none.body.valid === false, '/api/code rejects everything when ORDER_CODES is unset');
    const get = await run({ ORDER_CODES: 'SAKURA30' }, {}, 'GET');
    ok(get.code === 405 && get.headers.Allow === 'POST', '/api/code only answers POST');
    ok(!/percent/i.test(libSrc.replace(/\/\*[\s\S]*?\*\//, '')) && !/ORDER_CODE_PERCENT/.test(libSrc + codeSrc + src), 'ORDER_CODE_PERCENT is no longer used anywhere in the code');
  }

  console.log('\n' + (fails.length ? fails.length + ' FAILURES' : 'all server checks passed'));
  process.exit(fails.length ? 1 : 0);
})();

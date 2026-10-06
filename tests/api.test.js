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
  // lib/codes reads process.env, so it has to see the same fake env, and its
  // warnings (a malformed code variable) land in the same `warns` list
  const con = { error: () => {}, log: () => {}, warn: (...a) => { warns.push(a.join(' ')); } };
  const libSrc = fs.readFileSync('lib/codes.js', 'utf8');
  const libMod = { exports: {} };
  new Function('module', 'exports', 'process', 'console', libSrc)(libMod, libMod.exports, { env }, con);
  const req = (name) => {
    if (name.includes('codes')) return libMod.exports;
    throw new Error('unexpected require: ' + name);
  };

  const mod = { exports: {} };
  new Function('module', 'exports', 'process', 'fetch', 'console', 'require', source || src)(
    mod, mod.exports, { env }, fakeFetch, con, req
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

  // --- fixed prices, both codes, and the emails showing the same numbers --------
  // The expected figures are written out here by hand, not read from the code
  // under test. Without a code: a book is 999, all four 3,799. FIXEDCODE is the
  // fixed-price code: 699 a book, 2,499 for all four. EYES20 is 20% off the
  // books after the bundle, at normal prices, rounded to the nearest taka.
  // Delivery is 100 and never discounted. Savings are shown against every book
  // at 999: a Bundle line, a Code line, or both. Never a percentage.
  const FIX = { ...ENV, ORDER_CODE_FIXEDCODE: 'fixed' };
  const EYES = { ...ENV, ORDER_CODE_EYES20: 'percent:20' };
  const ALLCODES = { ...ENV, ORDER_CODE_FIXEDCODE: 'fixed', ORDER_CODE_EYES20: 'percent:20', ORDER_CODE_SAYKAMONI: 'free' };
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
    // typed: what the buyer types; name: how the code is shown. code: the Code line, 0 when absent
    const S = ['fixedcode', 'FIXEDCODE'], E = ['eyes20', 'EYES20'];
    const cases = [
      { label: 'one book',                    items: one,   books: 999,  grand: 1099, bundle: 0,   code: 0 },
      { label: 'four books',                  items: four,  books: 3799, grand: 3899, bundle: 197, code: 0 },
      { label: 'five books (set + single)',   items: five,  books: 4798, grand: 4898, bundle: 197, code: 0 },
      { label: 'eight books (two sets)',      items: eight, books: 7598, grand: 7698, bundle: 394, code: 0 },

      { label: 'FIXEDCODE, one book',          items: one,   cd: S, books: 699,  grand: 799,  bundle: 0,   code: 300 },
      { label: 'FIXEDCODE, four books',        items: four,  cd: S, books: 2499, grand: 2599, bundle: 197, code: 1300 },
      { label: 'FIXEDCODE, five books',        items: five,  cd: S, books: 3198, grand: 3298, bundle: 197, code: 1600 },
      { label: 'FIXEDCODE, eight books',       items: eight, cd: S, books: 4998, grand: 5098, bundle: 394, code: 2600 },

      { label: 'EYES20, one book',            items: one,   cd: E, books: 799,  grand: 899,  bundle: 0,   code: 200 },
      { label: 'EYES20, four books',          items: four,  cd: E, books: 3039, grand: 3139, bundle: 197, code: 760 },
      { label: 'EYES20, five books',          items: five,  cd: E, books: 3838, grand: 3938, bundle: 197, code: 960 },
      { label: 'EYES20, eight books',         items: eight, cd: E, books: 6078, grand: 6178, bundle: 394, code: 1520 },
    ];

    for (const c of cases) {
      const { handler, calls } = load(ALLCODES);
      const r = res();
      await handler({ method:'POST', headers:{}, body:{ ...person, items: c.items, ...(c.cd ? { code: c.cd[0] } : {}) } }, r);
      const owner = ownerOf(calls), buyer = buyerOf(calls);
      const oh = flat(owner.html), bh = flat(buyer.html), name = c.cd ? c.cd[1] : null;
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
        ok(codeOf(s) === c.code && (name ? new RegExp('Code ' + name + ' - BDT').test(s) : !/Code \S+ - BDT/.test(s)), c.label + ': ' + who + ' ' + (name ? 'Code ' + name + ' line - BDT ' + fmt(c.code) : 'no Code line'), 'got ' + codeOf(s));
      }
      ok(owner.text.includes('Bundle:  - BDT ' + fmt(c.bundle)) === (c.bundle > 0), c.label + ': text Bundle line matches');
      ok(name ? owner.text.includes('Code ' + name + ':  - BDT ' + fmt(c.code)) : !/\n  Code /.test(owner.text), c.label + ': text Code line matches');
      ok(!/%/.test(oh + bh + owner.text + buyer.text), c.label + ': no percentage appears in either email');

      // and the plain-text order blocks are identical, line for line
      ok(moneyLines(owner.text).length > 0 && JSON.stringify(moneyLines(owner.text)) === JSON.stringify(moneyLines(buyer.text)),
         c.label + ': owner and buyer text show identical order lines');
    }
  }

  // --- the price floor: never less than 599 a book, for every outcome ------------
  // At today's prices it cannot bind (2,499 for four is 625 a book), so the
  // test changes a price in a copy of the server source, or uses a large
  // percentage, to drive it.
  {
    const tweak = (from, to) => { const s = src.replace(from, to); if (s === src) throw new Error('test setup: ' + from + ' not found in api/order.js'); return s; };
    const place = async (h, items, code) => { const r = res(); await h.handler({ method:'POST', headers:{}, body:{ ...person, items, code: code || 'fixedcode' } }, r); return r; };

    // at the real prices it never fires, for either code, even on the cheapest orders
    {
      const h = load(ALLCODES);
      for (const code of ['fixedcode', 'eyes20']) for (const items of [one, four, five, eight]) await place(h, items, code);
      ok(h.warns.length === 0, 'at the real prices the floor never fires for either code and nothing is logged', h.warns.length + ' warnings');
    }

    // four for 1,999 is under the floor of 4 x 599 = 2,396
    {
      const h = load(FIX, null, null, tweak('SET_CODE = 2499', 'SET_CODE = 1999'));
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
      const h = load(FIX, null, null, tweak('SINGLE_CODE = 699', 'SINGLE_CODE = 399'));
      const r = await place(h, one), owner = ownerOf(h.calls);
      ok(owner.text.includes('Books total: BDT 599') && owner.text.includes('Approximate total: BDT 699'), 'a single is charged the floor, BDT 599');
      ok(h.warns.length === 1 && h.warns[0].includes('BDT 399') && h.warns[0].includes('BDT 599') && h.warns[0].includes(r.body.ref), 'and the warning names 399, 599 and the reference', h.warns[0]);
    }

    // a percentage code obeys the floor too: 90% off a book is 100, floored to 599
    {
      const big = { ...ENV, ORDER_CODE_EYES20: 'percent:90' };
      const h1 = load(big);
      const r1 = await place(h1, one, 'eyes20'), o1 = ownerOf(h1.calls);
      ok(o1.text.includes('Books total: BDT 599') && o1.text.includes('Approximate total: BDT 699'), 'a percent code cannot take a single under 599');
      ok(h1.warns.length === 1 && h1.warns[0].includes('BDT 100') && h1.warns[0].includes('BDT 599') && h1.warns[0].includes(r1.body.ref), 'and the warning names the computed 100, the floor and the reference', h1.warns[0]);
      const h4 = load(big);
      await place(h4, four, 'eyes20');
      const o4 = ownerOf(h4.calls);
      ok(o4.text.includes('Books total: BDT 2,396') && h4.warns.length === 1 && h4.warns[0].includes('BDT 380'), 'a percent code cannot take four under 2,396 either', h4.warns[0]);
      const oh4 = flat(o4.html), s4 = sumItems(oh4) - bundleOf(oh4) - codeOf(oh4) + deliveryOf(oh4);
      ok(s4 === 2496, 'the lines still add up after a percent code is floored', s4 + ' vs 2496');
    }

    // prices above the floor are never touched: 2,396 is exactly 599 a book, 2,400 is above it
    for (const [price, tag] of [[2396, 'exactly at'], [2400, 'above']]) {
      const h = load(FIX, null, null, tweak('SET_CODE = 2499', 'SET_CODE = ' + price));
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

  // --- the pages and the server agree on every total, for both codes -------------
  // Each page's own priceOrder is driven through its real controls (ticking
  // books, choosing quantities, applying a code) and compared with what the
  // server puts in the owner email for the same order. The page talks to the
  // real api/code.js, so the shape of its answer is tested too. Run on both
  // pages, and again with the floor binding.
  {
    const { JSDOM } = require('jsdom');
    const wait = (ms) => new Promise((r) => setTimeout(r, ms));
    const toItems = (o) => Object.keys(o).map((id) => ({ id, qty: o[id] }));
    const moneyNum = (t) => Number(String(t).replace(/[^0-9]/g, ''));
    const quiet = { error: () => {}, log: () => {}, warn: () => {} };
    const codeApi = (env) => {
      const lib = { exports: {} };
      new Function('module', 'exports', 'process', 'console', fs.readFileSync('lib/codes.js', 'utf8'))(lib, lib.exports, { env }, quiet);
      const mod = { exports: {} };
      new Function('module', 'exports', 'require', fs.readFileSync('api/code.js', 'utf8'))(mod, mod.exports, () => lib.exports);
      return mod.exports;
    };
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
      const apiCode = codeApi(ALLCODES);
      const dom = new JSDOM(pageHtml, {
        runScripts: 'dangerously', pretendToBeVisual: true, url: 'https://shimantodewan.com/contact',
        beforeParse(w) {
          w.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} };
          w.matchMedia = w.matchMedia || (q => ({ matches:false, media:q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
          w.scrollTo = () => {};
          w.fetch = async (url, opts) => {
            if (!String(url).includes('/api/code')) throw new Error('blocked ' + url);
            const r = res();
            await apiCode({ method: 'POST', headers: {}, body: JSON.parse(opts.body) }, r);
            return { ok: true, json: async () => r.body };
          };
        },
      });
      const w = dom.window, d = w.document;
      await wait(150); w.dispatchEvent(new w.Event('load')); await wait(50);
      const boxes = [...d.querySelectorAll('input[name="book"]')];
      const fire = (el, type) => el.dispatchEvent(new w.Event(type, { bubbles: true }));
      const server = load(ALLCODES, null, null, serverSrc);

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
          delivery: moneyNum(d.getElementById('t-deliv').textContent),
          grand: moneyNum(d.getElementById('t-grand').textContent),
        };
      };
      const fromServer = async (sel, typed) => {
        const r = res();
        await server.handler({ method:'POST', headers:{}, body:{ ...person, items: toItems(sel), code: typed || '' } }, r);
        const t = resendMails(server.calls).filter((m) => m.to.includes(OWNER)).pop().text;
        const n = (re) => { const m = t.match(re); return m ? Number(m[1].replace(/,/g, '')) : 0; };
        return {
          baseline: [...t.matchAll(/ x\d+   BDT ([\d,]+)/g)].reduce((a, m) => a + Number(m[1].replace(/,/g, '')), 0),
          bundle: n(/Bundle:  - BDT ([\d,]+)/),
          code: n(/Code \S+:  - BDT ([\d,]+)/),
          delivery: n(/Delivery, approx: BDT ([\d,]+)/),
          grand: n(/Approximate total: BDT ([\d,]+)/),
        };
      };

      // no code, then each code in turn on the same page, with the field never
      // locked. Applying a second code replaces the first (they never stack); an
      // unknown code leaves the applied one in place; an empty field plus Apply
      // removes it. The page must agree with the server for whichever is applied.
      let applied = null;
      for (const typed of [null, 'fixedcode', 'eyes20', 'saykamoni', 'fixedcode', 'nope', '']) {
        if (typed !== null) {
          const input = d.getElementById('o-code');
          ok(input.readOnly === false, tag + ': the code field is editable before typing "' + typed + '"');
          input.value = typed;
          d.getElementById('code-go').dispatchEvent(new w.Event('click', { bubbles: true }));
          await wait(60);
          const msg = d.getElementById('code-msg').textContent;
          const unknown = typed === 'nope';
          const want = typed === '' ? '' : unknown ? 'That code is not recognised. ' + applied.toUpperCase() + ' is still applied.' : typed === 'saykamoni' ? "For my adorable wife, it's free." : 'Code applied';
          if (typed === '') applied = null; else if (!unknown) applied = typed;
          ok(msg === want && !/%/.test(msg), tag + ': Apply with "' + typed + '" gives "' + want + '", no percentage', msg);
          if (typed === 'saykamoni') ok(/\bis-free\b/.test(d.getElementById('code-msg').className), tag + ': the free message has its own style class');
        }
        for (const [label, sel] of sels) {
          choose(sel);
          const page = fromPage(), srv = await fromServer(sel, applied);
          ok(JSON.stringify(page) === JSON.stringify(srv), tag + ': ' + label + ' with ' + (applied || 'no code') + (typed === 'nope' ? ' (after an unknown code)' : '') + ' - page and server agree', 'page ' + JSON.stringify(page) + ' / server ' + JSON.stringify(srv));
        }
        if (applied) {
          choose(sels[3][1]);
          const name = applied.toUpperCase();
          ok(d.getElementById('t-disc-label').textContent === 'Code ' + name, tag + ': the code row is labelled Code ' + name + ', no percentage', d.getElementById('t-disc-label').textContent);
          ok(!/%/.test(d.getElementById('totals').textContent), tag + ': no percentage anywhere in the totals with ' + name);
        }
      }
      ok(d.querySelector('#t-save > span').textContent === 'Bundle', tag + ': the bundle row is labelled Bundle', d.querySelector('#t-save > span').textContent);
      w.close();
    }

    for (const file of ['contact/index.html', 'info/index.html']) {
      const html = fs.readFileSync(file, 'utf8');
      await agree(file, html, src);

      // and when the floor binds: lower the fixed set price in both copies and compare again
      const lowPage = html.replace('SET_CODE = 2499', 'SET_CODE = 1999');
      const lowSrc = src.replace('SET_CODE = 2499', 'SET_CODE = 1999');
      ok(lowPage !== html && lowSrc !== src, file + ': test setup changed the fixed set price in both copies');
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

  // --- a free code: books and delivery waived, floor bypassed, no buyer email ----
  // SAYKAMONI is `free`: the books and the delivery are both BDT 0, the 599 a
  // book floor does not apply, and the buyer is sent no email at all. Everything
  // else (validation, the owner email, the order log) works as for any order.
  {
    const FREE = { ...ENV, ORDER_CODE_SAYKAMONI: 'free' };
    const KV = { KV_REST_API_URL: 'https://kv.example.com', KV_REST_API_TOKEN: 'tok' };
    const placeFree = async (env, items, extra, source) => {
      const h = load(env, null, null, source), r = res();
      await h.handler({ method:'POST', headers:{}, body:{ ...person, items, code: 'saykamoni', ...extra } }, r);
      return { h, r, owner: ownerOf(h.calls), mails: resendMails(h.calls) };
    };
    const totalOf = (s) => num(s.match(/Approximate total BDT ([\d,]+)/));
    const tweak = (from, to) => { const s = src.replace(from, to); if (s === src) throw new Error('test setup: ' + from + ' not found in api/order.js'); return s; };

    const sizes = [['one book', one, 999], ['four books', four, 3996], ['five books', five, 4995], ['eight books', eight, 7992]];
    for (const [label, items, base] of sizes) {
      const { h, r, owner, mails } = await placeFree(FREE, items);
      const oh = flat(owner.html);
      ok(r.code === 200 && r.body.ok === true, 'free, ' + label + ': the order is accepted');
      ok(r.body.free === true && /^[A-HJ-NP-Z]{2}[2-9]/.test(r.body.ref || ''), 'free, ' + label + ': the response says it is free and carries the reference', JSON.stringify(r.body));
      ok(owner.text.includes('Books total: BDT 0'), 'free, ' + label + ': the books come to BDT 0', (owner.text.match(/Books total:.*/) || [''])[0]);
      ok(owner.text.includes('Delivery, approx: BDT 0') && deliveryOf(oh) === 0, 'free, ' + label + ': delivery is BDT 0, shown and not hidden');
      ok(owner.text.includes('Approximate total: BDT 0') && totalOf(oh) === 0, 'free, ' + label + ': the total is BDT 0 in both versions of the owner email');
      ok(sumItems(oh) === base, 'free, ' + label + ': the items are still listed at 999 each', sumItems(oh) + ' vs ' + base);
      const shown = sumItems(oh) - bundleOf(oh) - codeOf(oh) + deliveryOf(oh);
      ok(shown === 0 && /Code SAYKAMONI - BDT/.test(oh) && !/%/.test(oh + owner.text), 'free, ' + label + ': the lines add up to 0, with a Code SAYKAMONI line and no percentage', 'lines give ' + shown);
      ok(h.warns.length === 0, 'free, ' + label + ': the floor does not clamp it, so there is no PRICE FLOOR warning', h.warns.join(' | '));
      ok(mails.length === 1 && mails[0].to.includes(OWNER) && buyerOf(h.calls) === undefined, 'free, ' + label + ': exactly one email is sent, the owner\'s, and none to the buyer', mails.length + ' emails');
    }

    // the owner email makes the zero obvious, and a skipped confirmation is never a failed one
    {
      const { owner, r } = await placeFree(FREE, four);
      const oh = flat(owner.html);
      ok(owner.subject === 'Pre-order ' + r.body.ref + ' - Rifat Hossain - 4 book(s) - FREE ORDER, BDT 0', 'free: the subject says FREE ORDER, BDT 0', owner.subject);
      ok(owner.text.includes('*** FREE ORDER: NOTHING TO PAY, TOTAL BDT 0 ***') && /FREE ORDER \/ NOTHING TO PAY \/ TOTAL BDT 0/.test(oh), 'free: a banner says nothing is to be paid and the total is BDT 0');
      ok(oh.includes('NO CONFIRMATION SENT, FREE ORDER') && owner.text.includes('NO CONFIRMATION SENT, FREE ORDER.'), 'free: the status line says NO CONFIRMATION SENT, FREE ORDER');
      ok(!/CONFIRMATION FAILED|RESEND MANUALLY|CONFIRMATION SENT TO BUYER|Confirmation sent to buyer/.test(oh + owner.text), 'free: it is never described as failed, and never as sent');
      ok(owner.text.includes(r.body.ref) && owner.html.includes('Rifat Hossain') && owner.html.includes('Banani'), 'free: the owner email still carries the reference, the buyer and the address');
      ok(owner.reply_to === 'rifat@example.com', 'free: reply-to is still the buyer');
    }

    // the owner copy still goes to ORDER_TO and ORDER_TO_CC
    {
      const { owner, mails } = await placeFree({ ...FREE, ORDER_TO_CC: 'partner@example.com' }, four);
      ok(mails.length === 1 && owner.to.length === 2 && owner.to[1] === 'partner@example.com', 'free: the owner email still goes to both ORDER_TO and ORDER_TO_CC');
    }

    // typed in any case or spacing, like every code
    for (const typed of [' Say Ka Moni ', 'SAYKAMONI', 'saykamoni']) {
      const { owner, mails } = await placeFree(FREE, one, { code: typed });
      ok(owner.text.includes('Approximate total: BDT 0') && mails.length === 1, 'free: typed "' + typed + '" is the free code');
    }

    // the floor is bypassed, only for this kind
    {
      const high = tweak('FLOOR = 599', 'FLOOR = 99999');
      const f = await placeFree(FREE, four, {}, high);
      ok(f.owner.text.includes('Books total: BDT 0') && f.h.warns.length === 0, 'free: even a floor of 99,999 a book does not touch it');
      const fixedHigh = await placeFree({ ...FREE, ORDER_CODE_FIXEDCODE: 'fixed' }, four, { code: 'fixedcode' }, high);
      ok(fixedHigh.owner.text.includes('Books total: BDT ' + fmt(99999 * 4)), 'the same high floor still holds a fixed-code order (control)', (fixedHigh.owner.text.match(/Books total:.*/) || [''])[0]);
      ok(fixedHigh.h.warns.length === 1 && /PRICE FLOOR/.test(fixedHigh.h.warns[0]), 'and still logs the PRICE FLOOR warning (control)');
    }

    // the order is still written to the log, as for any order, plus a free flag
    {
      const kvEnv = { ...ALLCODES, ...KV };
      const f = await placeFree(kvEnv, four);
      const rec = JSON.parse(lpushOf(f.h.calls).body);
      ok(rec.free === true && rec.payable === 0 && rec.code === 'SAYKAMONI' && rec.ref === f.r.body.ref && rec.email === 'rifat@example.com', 'free: the order is written to the Upstash log with free:true, payable 0, the code and the reference', JSON.stringify(rec).slice(0, 160));
      ok(rec.buyerSent === false && !('ownerEmail' in rec), 'free: the record shows no buyer email sent and no owner failure');
      const n = load(kvEnv), nr = res();
      await n.handler({ method:'POST', headers:{}, body:{ ...person, items: four } }, nr);
      const normal = JSON.parse(lpushOf(n.calls).body);
      ok(JSON.stringify(Object.keys(normal).sort()) === JSON.stringify(Object.keys(rec).filter((k) => k !== 'free').sort()), 'the log record has exactly the same fields as a normal order, plus free:true', Object.keys(rec).filter((k) => !(k in normal)).join(','));
      ok(!('free' in normal) && !('free' in nr.body), 'a normal order has no free flag in its record or its response');
      ok(f.h.store.has('ref:' + f.r.body.ref), 'free: the reference is claimed in Redis like any other');
    }

    // an owner email that cannot be sent still fails the order, and the free order is kept
    {
      const kvEnv = { ...FREE, ...KV };
      const h = load(kvEnv, { to: OWNER }), r = res();
      await h.handler({ method:'POST', headers:{}, body:{ ...person, items: four, code: 'saykamoni' } }, r);
      const rec = lpushOf(h.calls) && JSON.parse(lpushOf(h.calls).body);
      ok(r.code === 502 && r.body.error === 'send_failed', 'free: if the owner email fails the order is reported failed');
      ok(!!rec && rec.free === true && rec.ownerEmail === 'failed', 'and it is written to the log, marked free and owner-failed, so it is not lost');
      ok(resendMails(h.calls).every((m) => m.to.includes(OWNER)), 'and still nothing was sent to the buyer');
    }

    // the browser cannot grant itself a free order
    {
      const forged = await placeFree(ALLCODES, four, { code: 'NOTACODE', free: true, kind: 'free', delivery: 0, payable: 0, offer: { kind: 'free' } });
      ok(forged.owner.text.includes('Books total: BDT 3,799') && forged.owner.text.includes('Delivery, approx: BDT 100') && forged.owner.text.includes('Approximate total: BDT 3,899'), 'forged free flags in the request are ignored');
      ok(forged.mails.length === 2 && !('free' in forged.r.body), 'and the buyer is still emailed');
      const twoCodes = await placeFree(ALLCODES, four, { code: 'EYES20', codes: ['SAYKAMONI'], code2: 'SAYKAMONI' });
      ok(twoCodes.owner.text.includes('Books total: BDT 3,039') && twoCodes.mails.length === 2, 'a second code in the request cannot turn another code free');
      const joined = await placeFree(ALLCODES, four, { code: 'SAYKAMONI EYES20' });
      ok(joined.owner.text.includes('Approximate total: BDT 3,899') && joined.mails.length === 2, 'two codes typed together are no code at all');
    }

    // every other order is exactly as before: both emails, delivery charged, the payment instruction kept
    for (const [label, code, books, grand] of [['no code', undefined, 3799, 3899], ['fixed code', 'fixedcode', 2499, 2599], ['percent code', 'eyes20', 3039, 3139]]) {
      const n = load(ALLCODES), r = res();
      await n.handler({ method:'POST', headers:{}, body:{ ...person, items: four, ...(code ? { code } : {}) } }, r);
      const mails = resendMails(n.calls), owner = ownerOf(n.calls), buyer = buyerOf(n.calls);
      ok(mails.length === 2 && !!buyer && buyer.to[0] === 'rifat@example.com', label + ': a normal order still sends both emails, buyer first');
      ok(owner.text.includes('Books total: BDT ' + fmt(books)) && owner.text.includes('Delivery, approx: BDT 100') && owner.text.includes('Approximate total: BDT ' + fmt(grand)), label + ': prices and the BDT 100 delivery are unchanged');
      ok(!/FREE ORDER/.test(owner.subject + owner.text + owner.html) && owner.html.includes('CONFIRMATION SENT TO BUYER') && !owner.html.includes('NO CONFIRMATION SENT'), label + ': the owner email has no free wording and says the confirmation was sent');
      const bflat = flat(buyer.html).replace(/\s+/g, ' ') + ' ' + buyer.text.replace(/\s+/g, ' ');
      ok(buyer.text.includes('Please do not send payment before that.') && buyer.html.includes('<b>Please do not send payment before that.</b>') && /payment details for bKash, Nagad, Bank Transfer or RedotPay/.test(bflat), label + ': the buyer email keeps its payment instruction');
      ok(!('free' in r.body) && r.body.ok === true, label + ': the response has no free flag');
    }

    // and a normal order whose buyer email fails is still reported as FAILED, never as a free order
    {
      const h = load(ALLCODES, { to: 'rifat@example.com' }), r = res();
      await h.handler({ method:'POST', headers:{}, body:{ ...person, items: four } }, r);
      const owner = ownerOf(h.calls);
      ok(r.code === 200 && owner.html.includes('CONFIRMATION FAILED, RESEND MANUALLY') && !owner.html.includes('NO CONFIRMATION SENT'), 'a real send failure still says CONFIRMATION FAILED, RESEND MANUALLY (third state does not replace it)');
    }

    // the code itself: kind, spellings, and /api/code
    {
      const apiOf = (env) => {
        const lib = { exports: {} };
        new Function('module', 'exports', 'process', 'console', fs.readFileSync('lib/codes.js', 'utf8'))(lib, lib.exports, { env }, { warn: () => {}, error: () => {}, log: () => {} });
        const mod = { exports: {} };
        new Function('module', 'exports', 'require', fs.readFileSync('api/code.js', 'utf8'))(mod, mod.exports, () => lib.exports);
        return mod.exports;
      };
      const ask = async (env, code) => { const r = res(); await apiOf(env)({ method:'POST', headers:{}, body:{ code } }, r); return r; };
      const a = await ask(ALLCODES, ' say ka moni ');
      ok(JSON.stringify(a.body) === '{"valid":true,"code":"SAYKAMONI","kind":"free"}', '/api/code says SAYKAMONI is a free code', JSON.stringify(a.body));
      for (const v of ['free', 'FREE', ' Free ']) {
        const x = await ask({ ORDER_CODE_SAYKAMONI: v }, 'saykamoni');
        ok(x.body.valid === true && x.body.kind === 'free', 'ORDER_CODE_SAYKAMONI=' + JSON.stringify(v) + ' is understood as free');
      }
    }
  }

  // --- discount codes: one environment variable per code -------------------------
  // ORDER_CODE_<NAME> = fixed | percent:N. A code does exactly what its variable
  // says, only one applies to an order, and it is never read from the page.
  {
    const order = async (e, extra, items) => {
      const h = load(e), r = res();
      await h.handler({ method:'POST', headers:{}, body:{ ...person, items: items || four, ...extra } }, r);
      return { r, mail: ownerOf(h.calls), warns: h.warns };
    };
    const FULL = ['Books total: BDT 3,799', 'Approximate total: BDT 3,899'];       // four, no discount
    const isFull = (m) => FULL.every((s) => m.text.includes(s)) && !/\n  Code /.test(m.text);

    const fix = await order(ALLCODES, { code: 'fixedcode' });
    ok(fix.r.code === 200, 'order with a valid code accepted');
    ok(fix.mail.text.includes('Code FIXEDCODE:  - BDT 1,300') && fix.mail.text.includes('Books total: BDT 2,499') && fix.mail.text.includes('Approximate total: BDT 2,599'), 'FIXEDCODE gives the fixed code prices: 2,499 for four');
    const eyes = await order(ALLCODES, { code: 'eyes20' });
    ok(eyes.mail.text.includes('Code EYES20:  - BDT 760') && eyes.mail.text.includes('Books total: BDT 3,039') && eyes.mail.text.includes('Approximate total: BDT 3,139'), 'EYES20 takes 20% off the books after the bundle: 3,799 becomes 3,039, delivery untouched');
    ok(!/%/.test(fix.mail.text + eyes.mail.text), 'no percentage in either email');
    ok(fix.warns.length === 0 && eyes.warns.length === 0, 'well-formed variables log nothing');

    // case and spaces in the typed code are never the reason it fails
    for (const typed of ['  Fixed Code ', 'FIXEDCODE', 'fixedcode']) {
      const x = await order(ALLCODES, { code: typed });
      ok(x.mail.text.includes('Code FIXEDCODE:  - BDT 1,300'), 'typed "' + typed + '" is FIXEDCODE');
    }
    for (const typed of [' Eyes 20 ', 'EYES20', 'eyes20']) {
      const x = await order(ALLCODES, { code: typed });
      ok(x.mail.text.includes('Code EYES20:  - BDT 760'), 'typed "' + typed + '" is EYES20');
    }

    // only one code per order, and they never stack
    for (const typed of ['FIXEDCODE EYES20', 'FIXEDCODE,EYES20', 'EYES20+FIXEDCODE', 'FIXEDCODEEYES20']) {
      const x = await order(ALLCODES, { code: typed });
      ok(isFull(x.mail), 'two codes in one field are not a code at all: "' + typed + '"');
    }
    const extra = await order(ALLCODES, { code: 'EYES20', codes: ['FIXEDCODE'], code2: 'FIXEDCODE', coupon: 'FIXEDCODE' });
    ok(extra.mail.text.includes('Books total: BDT 3,039') && !extra.mail.text.includes('FIXEDCODE'), 'extra code fields in the request are ignored; only the one code applies');
    const both = await order(ALLCODES, { code: 'fixedcode' }, five);
    ok(both.mail.text.includes('Books total: BDT 3,198') && (both.mail.text.match(/\n  Code /g) || []).length === 1, 'an order carries at most one Code line');

    // a code that does not exist changes nothing
    const nc = await order(ALLCODES, { code: 'NOTACODE' });
    ok(nc.r.code === 200 && isFull(nc.mail), 'order with an unknown code still accepted, at full prices');
    ok(nc.warns.length === 0, 'an unknown code is not a configuration problem and logs nothing');

    // the critical one: the browser cannot grant itself a price
    const forged = await order(ALLCODES, { code: 'NOTACODE', discount: 4000, payable: 999, codePercent: 90, percent: 90, kind: 'percent', price: 1, subtotal: 1, codeSaving: 9999, bundleSaving: 9999, offer: { kind: 'percent', percent: 90 } });
    ok(isFull(forged.mail), 'forged price, kind and percent fields in the request are ignored');

    // no variables set: nothing is discounted
    const none = await order({ ...ENV }, { code: 'FIXEDCODE' });
    ok(isFull(none.mail), 'with no ORDER_CODE_ variables set no code works');

    // adding a third code is just adding a variable (the README example), no code change
    const third = await order({ ...ALLCODES, ORDER_CODE_FRIENDS10: 'percent:10' }, { code: 'friends10' }, one);
    ok(third.mail.text.includes('Code FRIENDS10:  - BDT 100') && third.mail.text.includes('Books total: BDT 899') && third.mail.text.includes('Approximate total: BDT 999'), 'a third code, percent:10, works with only a new variable: 899 for one book');
    const third2 = await order({ ...ALLCODES, ORDER_CODE_FRIENDS10: 'fixed' }, { code: 'friends10' }, one);
    ok(third2.mail.text.includes('Books total: BDT 699'), 'a third fixed code gets the same fixed prices as FIXEDCODE');

    // retiring a code is deleting its variable
    const retired = await order({ ...ENV, ORDER_CODE_FIXEDCODE: 'fixed' }, { code: 'eyes20' });
    ok(isFull(retired.mail), 'with ORDER_CODE_EYES20 deleted, EYES20 is rejected');
    const kept = await order({ ...ENV, ORDER_CODE_FIXEDCODE: 'fixed' }, { code: 'fixedcode' });
    ok(kept.mail.text.includes('Books total: BDT 2,499'), 'and the other code is unaffected');

    // variable names and values are read forgivingly
    const lower = await order({ ...ENV, order_code_eyes20: 'Percent : 20' }, { code: 'EYES20' });
    ok(lower.mail.text.includes('Books total: BDT 3,039') && lower.warns.length === 0, 'a lower-case variable name and "Percent : 20" are understood');
    const loud = await order({ ...ENV, ORDER_CODE_FIXEDCODE: '  FIXED ' }, { code: 'FIXEDCODE' });
    ok(loud.mail.text.includes('Books total: BDT 2,499') && loud.warns.length === 0, 'FIXED with spaces around it is understood');
    const lead0 = await order({ ...ENV, ORDER_CODE_EYES20: 'percent:05' }, { code: 'EYES20' }, one);
    ok(lead0.mail.text.includes('Code EYES20:  - BDT 50') && lead0.warns.length === 0, 'percent:05 is five per cent');
    const lowest = await order({ ...ENV, ORDER_CODE_EYES20: 'percent:1' }, { code: 'EYES20' }, one);
    ok(lowest.warns.length === 0 && lowest.mail.text.includes('Code EYES20:  - BDT 10'), 'percent:1 is allowed (1% of 999 is 9.99, rounded to 10)');
    const highest = await order({ ...ENV, ORDER_CODE_EYES20: 'percent:90' }, { code: 'EYES20' }, one);
    ok(!highest.warns.some((w) => /malformed/.test(w)) && highest.mail.text.includes('Books total: BDT 599'), 'percent:90 is allowed (the limit), and the floor then holds the book at 599');

    // the earlier variables are retired: not read, and never mistaken for a code
    const oldList = await order({ ...ENV, ORDER_CODES: 'FIXEDCODE,EYES20' }, { code: 'FIXEDCODE' });
    ok(isFull(oldList.mail) && oldList.warns.length === 0, 'the old ORDER_CODES list is no longer read');
    const oldPct = await order({ ...ALLCODES, ORDER_CODE_PERCENT: '25' }, { code: 'percent' });
    ok(isFull(oldPct.mail) && oldPct.warns.length === 0, 'a leftover ORDER_CODE_PERCENT is not a code called PERCENT, and logs nothing');
    const oldPct2 = await order({ ...ALLCODES, ORDER_CODE_PERCENT: '25' }, { code: 'fixedcode' });
    ok(oldPct2.mail.text.includes('Books total: BDT 2,499') && oldPct2.warns.length === 0, 'and it does not disturb the real codes');
  }

  // --- a malformed variable is an invalid code: no discount, no crash, a warning --
  {
    const place = async (env, typed) => {
      const h = load(env), r = res();
      let threw = null;
      try { await h.handler({ method:'POST', headers:{}, body:{ ...person, items: four, code: typed } }, r); } catch (e) { threw = e; }
      return { r, threw, mail: ownerOf(h.calls), warns: h.warns };
    };
    const malformed = ['percent:abc', 'percent:', 'percent:0', 'percent:95', 'percent:100', 'percent:20.5', 'percent:-5', 'percent:2 0',
                       'percent', 'percent 20', '20', '20%', 'fixed:20', 'pct:20', 'freee', 'free:1', 'free 100', 'zero', 'gratis', '', '   '];
    for (const v of malformed) {
      const env = { ...ENV, ORDER_CODE_FIXEDCODE: 'fixed', ORDER_CODE_EYES20: v };
      const bad = await place(env, 'eyes20');
      ok(!bad.threw && bad.r.code === 200, 'ORDER_CODE_EYES20=' + JSON.stringify(v) + ': no crash, the order is still accepted');
      ok(bad.mail.text.includes('Books total: BDT 3,799') && bad.mail.text.includes('Approximate total: BDT 3,899') && !/\n  Code /.test(bad.mail.text), 'ORDER_CODE_EYES20=' + JSON.stringify(v) + ': no discount at all, never 0% off or a guess');
      const w = bad.warns.join('\n');
      ok(bad.warns.length === 1 && w.includes('ORDER_CODE_EYES20') && /malformed/.test(w), 'ORDER_CODE_EYES20=' + JSON.stringify(v) + ': one warning naming the variable', w);
      ok(w.includes(JSON.stringify(v)) && /percent:N/.test(w) && /1 to 90/.test(w), 'the warning shows the value and says what is expected', w);

      // the same variable through /api/code: simply not valid
      const lib = { exports: {} }; new Function('module', 'exports', 'process', 'console', fs.readFileSync('lib/codes.js', 'utf8'))(lib, lib.exports, { env }, { warn: () => {}, error: () => {}, log: () => {} });
      const apiMod = { exports: {} }; new Function('module', 'exports', 'require', fs.readFileSync('api/code.js', 'utf8'))(apiMod, apiMod.exports, () => lib.exports);
      const ar = res(); await apiMod.exports({ method:'POST', headers:{}, body:{ code: 'EYES20' } }, ar);
      ok(ar.code === 200 && JSON.stringify(ar.body) === '{"valid":false}', 'ORDER_CODE_EYES20=' + JSON.stringify(v) + ': /api/code says not valid', JSON.stringify(ar.body));

      // and it breaks only that one code
      const other = await place(env, 'fixedcode');
      ok(other.mail.text.includes('Books total: BDT 2,499') && other.warns.length === 0, 'ORDER_CODE_EYES20=' + JSON.stringify(v) + ': FIXEDCODE keeps working and logs nothing');
    }

    // a malformed fixed-price variable is the same story
    const badFixed = await place({ ...ENV, ORDER_CODE_FIXEDCODE: 'fixd' }, 'fixedcode');
    ok(!badFixed.threw && badFixed.mail.text.includes('Books total: BDT 3,799') && badFixed.warns.length === 1 && badFixed.warns[0].includes('ORDER_CODE_FIXEDCODE'), 'ORDER_CODE_FIXEDCODE=fixd is invalid too, with a warning naming that variable');

    // the warning fires when somebody tries the code, not on every order
    const unused = await place({ ...ALLCODES, ORDER_CODE_EYES20: 'percent:abc' }, '');
    ok(unused.warns.length === 0 && unused.mail.text.includes('Books total: BDT 3,799'), 'an order with no code does not read or log the broken variable');
  }

  // --- /api/code says which kind of discount applies -----------------------------
  {
    const codeSrc = fs.readFileSync('api/code.js', 'utf8');
    const libSrc = fs.readFileSync('lib/codes.js', 'utf8');
    const run = async (env, body, method) => {
      const lib = { exports: {} }; new Function('module', 'exports', 'process', 'console', libSrc)(lib, lib.exports, { env }, { warn: () => {}, error: () => {}, log: () => {} });
      const mod = { exports: {} };
      new Function('module', 'exports', 'require', codeSrc)(mod, mod.exports, () => lib.exports);
      const r = res(); await mod.exports({ method: method || 'POST', body, headers: {} }, r); return r;
    };
    const s = await run(ALLCODES, { code: ' fixed code ' });
    ok(s.code === 200 && JSON.stringify(s.body) === '{"valid":true,"code":"FIXEDCODE","kind":"fixed"}', '/api/code: FIXEDCODE is a fixed-price code, in its clean name', JSON.stringify(s.body));
    const e = await run(ALLCODES, { code: 'Eyes20' });
    ok(e.code === 200 && JSON.stringify(e.body) === '{"valid":true,"code":"EYES20","kind":"percent","percent":20}', '/api/code: EYES20 is a percent code and says which percent', JSON.stringify(e.body));
    const no = await run(ALLCODES, { code: 'nope' });
    ok(no.code === 200 && JSON.stringify(no.body) === '{"valid":false}', '/api/code: unknown code is just not valid', JSON.stringify(no.body));
    const empty = await run(ALLCODES, {});
    ok(JSON.stringify(empty.body) === '{"valid":false}', '/api/code: no code typed is not valid');
    const none = await run({}, { code: 'FIXEDCODE' });
    ok(none.body.valid === false, '/api/code rejects everything when no ORDER_CODE_ variable is set');
    const text = await run(ALLCODES, '{"code":"eyes20"}');
    ok(text.body.valid === true && text.body.kind === 'percent', '/api/code reads a JSON string body too');
    const get = await run(ALLCODES, {}, 'GET');
    ok(get.code === 405 && get.headers.Allow === 'POST', '/api/code only answers POST');
    const stripped = (libSrc + codeSrc + src).replace(/\/\*[\s\S]*?\*\//g, '');
    ok(!/process\.env\.ORDER_CODES\b/.test(stripped) && !/process\.env\.ORDER_CODE_PERCENT/.test(stripped), 'nothing in the code reads the retired ORDER_CODES or ORDER_CODE_PERCENT');
  }

  console.log('\n' + (fails.length ? fails.length + ' FAILURES' : 'all server checks passed'));
  process.exit(fails.length ? 1 : 0);
})();

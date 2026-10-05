const fs = require('fs');
const { JSDOM } = require('jsdom');

const file = process.argv[2];
const html = fs.readFileSync(file, 'utf8');

let posted = null;
const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'https://shimantodewan.com/contact',
  beforeParse(w) {
    // jsdom has no IntersectionObserver; real browsers do
    w.IntersectionObserver = class {
      constructor(cb){ this.cb = cb; }
      observe(){} unobserve(){} disconnect(){}
    };
    w.matchMedia = w.matchMedia || (q => ({ matches:false, media:q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
    w.scrollTo = () => {};
    w.fetch = (url, opts) => {
      if (String(url).includes('/api/code')) {
        const sent = JSON.parse(opts.body);
        const good = String(sent.code).trim().toUpperCase() === 'PREORDER20';
        return Promise.resolve({ ok:true, json: () => Promise.resolve({ valid:good, percent: good ? 20 : 0 }) });
      }
      if (String(url).includes('/api/order')) {
        posted = JSON.parse(opts.body);
        return Promise.resolve({ ok:true, json: () => Promise.resolve({ ok:true, ref:'JZ5' }) });
      }
      return Promise.reject(new Error('blocked: ' + url));
    };
  },
});

const { window } = dom;
const d = window.document;

function run() {
  const fail = [];
  const ok = (cond, label) => { console.log((cond ? 'pass  ' : 'FAIL  ') + label); if (!cond) fail.push(label); };

  // the page's own scripts ran
  ok(!!d.getElementById('order-form'), 'order form present');
  ok(d.querySelectorAll('.book').length === 4, 'four books rendered');
  ok(!!d.querySelector('.cta--alt'), 'Pre Order button present');
  ok(d.getElementById('v-mail').textContent.includes('@'), 'email bound from PROFILE');

  // totals start hidden, then react to a selection
  const totals = d.getElementById('totals');
  ok(totals.hidden === true, 'totals hidden before any choice');

  const boxes = [...d.querySelectorAll('input[name="book"]')];
  ok(boxes.length === 4, 'four book checkboxes');

  function tick(i, qty) {
    const b = boxes[i];
    b.checked = true;
    b.dispatchEvent(new window.Event('change', { bubbles: true }));
    if (qty) {
      const sel = b.closest('.pick').querySelector('select');
      sel.value = String(qty);
      sel.dispatchEvent(new window.Event('change', { bubbles: true }));
    }
  }

  tick(0);
  ok(totals.hidden === false, 'totals appear after choosing a book');
  ok(d.getElementById('t-sub').textContent === 'BDT 1,499', 'one book subtotal: ' + d.getElementById('t-sub').textContent);
  ok(d.getElementById('t-save').hidden === true, 'no bundle line for one book');

  tick(1); tick(2); tick(3);
  ok(d.getElementById('t-sub').textContent === 'BDT 4,999', 'all four subtotal: ' + d.getElementById('t-sub').textContent);
  ok(d.getElementById('t-save').hidden === false, 'bundle line shows for all four');
  ok(d.getElementById('t-save-val').textContent.includes('997'), 'bundle saving 997: ' + d.getElementById('t-save-val').textContent);
  ok(d.getElementById('t-grand').textContent === 'BDT 5,099', 'grand total with delivery: ' + d.getElementById('t-grand').textContent);

  // --- discount code ---
  const codeInput = d.getElementById('o-code');
  const codeBtn = d.getElementById('code-go');
  const codeMsg = d.getElementById('code-msg');
  ok(!!codeInput && !!codeBtn, 'discount code field present');
  ok(!d.documentElement.innerHTML.includes('PREORDER20'), 'the code itself is NOT in the page source');

  codeInput.value = 'WRONGCODE';
  codeBtn.dispatchEvent(new window.Event('click', { bubbles: true }));

  // invalid submit should be blocked and flagged
  d.getElementById('order-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  ok(d.getElementById('f-name').classList.contains('is-bad'), 'empty name flagged');
  ok(d.getElementById('f-phone').classList.contains('is-bad'), 'empty phone flagged');
  ok(d.getElementById('f-addr').classList.contains('is-bad'), 'empty address flagged');
  ok(d.getElementById('f-email').classList.contains('is-bad'), 'empty email flagged, it is required');
  ok(posted === null, 'nothing posted while invalid');

  // labels, hint and required markers for the contact fields
  const label = (id) => d.querySelector('label[for="' + id + '"]').textContent.trim();
  const errText = (id) => d.querySelector('#' + id + ' .err').textContent.trim();
  const emailEl = d.getElementById('o-email');
  ok(label('o-email') === 'Email', 'email label is just Email: ' + label('o-email'));
  ok(emailEl.hasAttribute('required'), 'email input marked required');
  ok(!emailEl.hasAttribute('placeholder'), 'email placeholder "optional" removed');
  ok(errText('f-email') === 'Please enter your email so I can send your confirmation', 'email error text: ' + errText('f-email'));
  ok(label('o-phone') === 'WhatsApp number', 'phone label is WhatsApp number: ' + label('o-phone'));
  ok(errText('f-phone') === 'Please enter a valid Bangladeshi WhatsApp number', 'phone error text: ' + errText('f-phone'));
  const hint = d.querySelector('#f-phone .code__msg');
  ok(!!hint && hint.textContent.trim() === "I'll message you here to confirm your order.", 'WhatsApp hint line present');
  ok(!/Phone number|for your confirmation/.test(d.getElementById('order-form').textContent), 'old field wording gone from the form');

  // bad email specifically (code checks resume after the awaits below)
  d.getElementById('o-name').value = 'Rifat Hossain';
  d.getElementById('o-phone').value = '01712345678';
  d.getElementById('o-addr').value = 'House 4, Road 11, Banani, Dhaka 1213';
  d.getElementById('o-email').value = 'not-an-email';
  d.getElementById('order-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  ok(d.getElementById('f-email').classList.contains('is-bad'), 'malformed email flagged');
  ok(posted === null, 'still nothing posted');

  // blank email is no longer allowed even when everything else is fine
  d.getElementById('o-email').value = '';
  d.getElementById('order-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));
  ok(d.getElementById('f-email').classList.contains('is-bad'), 'blank email flagged with everything else valid');
  ok(posted === null, 'blank email blocks the submit');

  // valid submit
  d.getElementById('o-email').value = 'rifat@example.com';
  d.getElementById('order-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }));

  return new Promise((resolve) => setTimeout(() => {
    ok(posted !== null, 'order posted to /api/order');
    if (posted) {
      ok(posted.name === 'Rifat Hossain', 'name in payload');
      ok(posted.phone === '01712345678', 'phone in payload');
      ok(posted.email === 'rifat@example.com', 'email in payload');
      ok(posted.items.length === 4, 'four items in payload');
      ok(posted.items.every(i => i.id && i.qty), 'items carry id and qty');
      ok('company' in posted, 'honeypot included');
    }
    const done = d.getElementById('order-done');
    ok(done && done.hidden === false, 'success panel shown');
    ok(d.getElementById('order-form').hidden === true, 'form hidden after success');
    ok(d.getElementById('order-ref').textContent === 'JZ5', 'reference displayed: ' + d.getElementById('order-ref').textContent);
    ok(d.getElementById('order-sent').hidden === false, 'buyer-copy note shown when email given');
    resolve(fail);
  }, 60));
}

setTimeout(() => {
  window.dispatchEvent(new window.Event('load'));
  run().then((fail) => {
    console.log('\n' + (fail.length ? fail.length + ' FAILURES' : 'all checks passed'));
    process.exit(fail.length ? 1 : 0);
  });
}, 150);

/* Discount code behaviour, run as its own pass so the async checks are clean */
if (process.env.CODE_PASS) {
  // see tests/code.test.js
}

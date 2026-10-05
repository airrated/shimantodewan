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
        const good = String(sent.code).trim().toUpperCase() === 'SAYKAMONI';
        return Promise.resolve({ ok:true, json: () => Promise.resolve(good ? { valid:true, code:'SAYKAMONI', kind:'fixed' } : { valid:false }) });
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
  const l1 = d.querySelector('.cta--alt .cta__l1'), l2 = d.querySelector('.cta--alt .cta__l2');
  ok(!!l1 && l1.textContent.trim() === 'Behind the Eyes', 'second capsule line 1 is Behind the Eyes');
  ok(!!l2 && l2.textContent.replace(/\s+/g, ' ').trim() === 'Pre-order ↓', 'second capsule line 2 is Pre-order with its arrow');
  ok(!!l2 && !!l2.querySelector('.arw'), 'the arrow sits on line 2');
  ok(d.querySelector('.cta--alt').getAttribute('href') === '#books', 'second capsule still links to the books');
  ok(!d.querySelector('.cover__actions .cta:not(.cta--alt) .cta__l1'), 'Contact capsule stays a single line');

  // cover name: no mask for the pinned timeline to slide the words into
  ok(/\.cover__name \.ln\{display:block;overflow:visible\}/.test(html), 'cover name lines are not masked (overflow:visible)');
  const tl = (html.match(/\.to\("\.cover__name \.w--[12]"[^\n]*/g) || []);
  ok(tl.length === 2, 'both cover name words are in the pinned timeline');
  ok(tl.every(l => /xPercent/.test(l) && !/yPercent/.test(l)), 'timeline keeps their horizontal drift and no vertical move');
  ok(/\.identity__type \.ln\{display:block;overflow:hidden\}/.test(html), 'identity masked reveals are left as they were');

  // portrait plate: frame matches the image, nothing for a background to show through
  const plate = (html.match(/\.plate__frame\{[^}]*\}/) || [''])[0];
  ok(/aspect-ratio:543 \/ 724/.test(plate) && /background:transparent/.test(plate), 'plate frame is 543 / 724 on a transparent background');
  ok(!/aspect-ratio:(4\/5|3\/4|5\/6)/.test(html), 'no breakpoint overrides the plate ratio any more');
  ok(/\.plate__frame img\{[^}]*object-fit:cover/.test(html), 'plate image stays object-fit:cover');
  ok(/@media \(min-width:900px\) and \(pointer:fine\)\{[^@]*\.plate__frame img\{position:absolute;left:0;top:-10%;height:111%\}/.test(html), 'desktop parallax is covered by a taller, lifted image');
  ok(/@media \(min-width:900px\) and \(pointer:fine\)\{[^@]*\.plate\{width:100%\}/.test(html), 'figure keeps its width when the image leaves the flow');

  // the word that crosses the portrait
  const cross = d.querySelector('.plate__typecross');
  ok(!!cross && cross.textContent.trim() === 'Dewan', 'word across the portrait is Dewan');
  ok(!/first year/i.test(d.querySelector('#plate').textContent), 'first year no longer crosses the portrait');
  ok(/\.plate__typecross\{[^}]*font-style:italic[^}]*mix-blend-mode:difference/.test(html), 'it stays italic with the difference blend');

  // the Choose capsules line up across a row: stretched cells, capsule pushed to the bottom
  ok(/\.books__grid\{[^}]*display:grid;align-items:stretch/.test(html), 'book grid rows stretch to the tallest cell');
  ok(/\.book\{display:flex;flex-direction:column\}/.test(html), 'each book is still a flex column');
  ok(/\.cta--choose\{[^}]*margin-top:auto/.test(html), 'the Choose capsule is pushed to the bottom with margin-top:auto');
  ok(/\.book__more\{margin:\.7rem 0 1rem\}/.test(html), 'a minimum gap above the capsule is kept for the tallest column');

  // price copy: cards, order lead and terms panel all say the same fixed prices
  {
    const cards = [...d.querySelectorAll('.book__price')];
    ok(cards.length === 4 && cards.every((c) => c.querySelector('s').textContent === 'BDT 1,499' && c.querySelector('b').textContent === 'BDT 999'), 'every card strikes through the RRP of BDT 1,499 beside BDT 999');
    const lead = d.querySelector('.order__lead').textContent.replace(/\s+/g, ' ');
    ok(lead.includes('All four are open for pre-order at BDT 999 instead of BDT 1,499, and BDT 3,799 for the set.'), 'order lead states 999 against 1,499 and 3,799 for the set');
    const ph = [...d.querySelectorAll('.order__terms h4')].find((x) => x.textContent.trim() === 'Price');
    const price = ph.closest('section').textContent.replace(/\s+/g, ' ').trim();
    ok(price === 'Price Pre-order pricing, while it lasts. BDT 999 a book instead of BDT 1,499, or BDT 3,799 for all four instead of BDT 3,996.', 'terms panel price copy: ' + price);
    ok(!/1,999|4,999|5,996|5,099|1,499 a book/.test(d.body.textContent), 'none of the old prices remain in the page text');
    ok(!/\d\s?%/.test(d.getElementById('order-form').textContent + d.getElementById('totals').textContent + d.querySelector('.order__terms').textContent + d.querySelector('.order__lead').textContent), 'no percentage in the order form, totals, terms or lead');
    // the structured data on /info carries the same single price
    const ld = [...d.querySelectorAll('script[type="application/ld+json"]')].map((s) => s.textContent).join(' ');
    if (ld.includes('"Offer"')) ok(!/"price":"1499"/.test(ld) && /"price":"999"/.test(ld), 'structured data offers the book at 999, not the old price');
  }

  // the Order received panel names the same payment options as the terms and the email
  {
    const panel = d.getElementById('order-done').textContent.replace(/\s+/g, ' ').trim();
    ok(panel.includes('and send the payment details for bKash, Nagad, Bank Transfer or RedotPay. Nothing is charged until then.'), 'order received panel lists all four payment options');
    ok(!/bKash details/.test(panel), 'no bKash-only wording left in the order received panel');
    ok(panel.includes('I will message you on WhatsApp at the number you gave to confirm your total, including delivery,'), 'order received panel says it will message on WhatsApp');
    ok(!/call or message/i.test(html), 'the old "call or message" wording is gone from the page');
    ok(/Delivery is 5 to 7 working days, inside Dhaka\./.test(panel), 'the rest of the panel is as it was');
    ok(!/bKash details/.test(html), 'no bKash-only wording left anywhere on the page');
  }

  // payment options in the terms panel
  {
    const isInfo = /info/.test(String(file).split(/[\\/]/).slice(-2).join('/'));
    const h = [...d.querySelectorAll('.order__terms h4')].find((x) => x.textContent.trim() === 'Payment');
    const sec = h && h.closest('section');
    const flat = sec ? sec.textContent.replace(/\s+/g, ' ').trim() : '';
    const WANT = "Payment bKash Personal, Nagad Personal, bank transfer or RedotPay. I'll confirm your total first, then send the details for whichever you prefer.";
    ok(!!sec && flat.startsWith(WANT), 'payment paragraph lists all four options: ' + flat.slice(0, 60));
    ok(!/Send payment only after|The number is sent with your order confirmation/.test(flat), 'old payment wording is gone');
    if (isInfo) {
      ok(flat === WANT, '/info payment section is the paragraph and nothing more');
      ok(!html.includes('01301292335') && !html.includes('1301292335'), '/info has no phone number anywhere');
    } else {
      ok(flat === WANT + ' bKash and Nagad: 01301292335', '/contact keeps the number after it: ' + flat.slice(WANT.length));
      ok(!!sec && sec.querySelectorAll('p').length === 2 && sec.querySelector('p + p b').textContent === '01301292335', 'the number is bold in its own line');
    }
  }
  ok(d.getElementById('v-mail').textContent.includes('@'), 'email bound from PROFILE');

  // totals start hidden, then react to a selection
  const totals = d.getElementById('totals');
  ok(totals.hidden === true, 'totals hidden before any choice');

  const boxes = [...d.querySelectorAll('input[name="book"]')];
  ok(boxes.length === 4, 'four book checkboxes');

  // --- Choose capsules and the cart view: views of the checkboxes, nothing more ---
  {
    const IDS = ['original', 'inside', 'influence', 'shadows'];
    const rows = [...d.querySelectorAll('.pick')];
    const caps = [...d.querySelectorAll('.cta--choose')];
    const books = [...d.querySelectorAll('.books__grid .book')];
    const empty = d.getElementById('picks-empty');
    const legend = d.querySelector('#order-form legend');
    const txt = (c) => c.querySelector('.cta__txt').textContent;
    const cap = (id) => d.querySelector('.cta--choose[data-book="' + id + '"]');
    const box = (id) => d.querySelector('input[name="book"][value="' + id + '"]');
    const rmBtn = (id) => d.querySelector('.pick__rm[data-remove="' + id + '"]');
    const shown = () => rows.filter((r) => !r.hidden).map((r) => r.querySelector('input').value);
    const count = () => d.getElementById('t-count').textContent;
    const press = (el) => el.dispatchEvent(new window.MouseEvent('click', { bubbles: true, cancelable: true }));

    // structure
    ok(caps.length === 4 && books.length === 4, 'a Choose capsule under each of the four books');
    ok(books.every((b, i) => { const c = b.querySelector('.cta--choose'), h = b.querySelector('.book__hook'), m = b.querySelector('.book__more');
      return c && c.getAttribute('data-book') === IDS[i] && (h.compareDocumentPosition(m) & 4) && (m.compareDocumentPosition(c) & 4); }),
      'each capsule sits after the hook and the details toggle, for the right book');
    ok(caps.every((c) => c.tagName === 'BUTTON' && c.getAttribute('type') === 'button' && c.classList.contains('cta')), 'capsules are type=button on .cta');
    ok(caps.every((c, i) => c.textContent.includes('Behind the Eyes: ' + ['Original', 'Inside', 'Influence', 'Shadows'][i])), 'each capsule names its book for screen readers');
    ok(legend.textContent.trim() === 'Chosen books', 'legend renamed to Chosen books: ' + legend.textContent.trim());
    ok(box('original').getAttribute('aria-hidden') === 'true' && box('original').getAttribute('tabindex') === '-1', 'checkboxes are out of the tab order and the accessibility tree');
    ok(rows.length === 4 && rows.every((r) => r.querySelector('input[type=checkbox]')), 'the checkboxes stay in the DOM');

    // nothing chosen
    ok(caps.every((c) => txt(c) === 'Choose' && c.getAttribute('aria-pressed') === 'false'), 'every capsule starts as Choose, aria-pressed false');
    ok(shown().length === 0, 'no cart rows while nothing is chosen');
    ok(empty.hidden === false && empty.textContent.trim() === 'Nothing chosen yet. Pick a book above.', 'empty line shown: ' + empty.textContent.trim());
    ok(d.getElementById('totals').hidden === true, 'no totals while nothing is chosen');

    // pressing Choose writes to the checkbox
    press(cap('inside'));
    ok(box('inside').checked === true, 'pressing Choose ticks that book\'s checkbox');
    ok(['original', 'influence', 'shadows'].every((id) => box(id).checked === false), 'and no other checkbox');
    ok(txt(cap('inside')) === 'Chosen' && cap('inside').getAttribute('aria-pressed') === 'true', 'capsule flips to Chosen, aria-pressed true');
    ok(box('inside').closest('.pick').querySelector('select').disabled === false, 'its quantity select is enabled');
    ok(JSON.stringify(shown()) === '["inside"]', 'only that book\'s cart row is shown: ' + JSON.stringify(shown()));
    ok(empty.hidden === true, 'the empty line goes away');
    ok(d.getElementById('totals').hidden === false && count() === '1 book' && d.getElementById('t-sub').textContent === 'BDT 999', 'totals recalculated: ' + count() + ', ' + d.getElementById('t-sub').textContent);
    ok(['original', 'influence', 'shadows'].every((id) => txt(cap(id)) === 'Choose' && cap(id).getAttribute('aria-pressed') === 'false'), 'the other capsules stay Choose');

    // the cart follows book order, not choosing order
    press(cap('shadows')); press(cap('original')); press(cap('influence'));
    ok(JSON.stringify(shown()) === '["original","inside","influence","shadows"]', 'cart rows follow book order, not the order chosen: ' + JSON.stringify(shown()));
    ok(count() === '4 books' && d.getElementById('t-sub').textContent === 'BDT 3,996' && d.getElementById('t-grand').textContent === 'BDT 3,899', 'all four chosen price as the set: ' + d.getElementById('t-sub').textContent);

    // Remove writes to the checkbox too
    press(rmBtn('original'));
    ok(box('original').checked === false, 'Remove unticks the checkbox');
    ok(txt(cap('original')) === 'Choose' && cap('original').getAttribute('aria-pressed') === 'false', 'and the capsule returns to Choose');
    ok(JSON.stringify(shown()) === '["inside","influence","shadows"]', 'the row leaves the cart: ' + JSON.stringify(shown()));
    ok(count() === '3 books' && d.getElementById('t-sub').textContent === 'BDT 2,997', 'totals recalculated after Remove: ' + d.getElementById('t-sub').textContent);
    ok(d.activeElement === rmBtn('inside'), 'focus moves to the next Remove link, not to nowhere');

    // pressing Chosen turns it back to Choose
    press(cap('inside'));
    ok(box('inside').checked === false && txt(cap('inside')) === 'Choose' && cap('inside').getAttribute('aria-pressed') === 'false', 'pressing Chosen toggles it back to Choose');
    ok(JSON.stringify(shown()) === '["influence","shadows"]', 'and its row leaves the cart');

    // the other direction: the checkbox is the source, the capsule follows it
    box('influence').checked = false; box('influence').dispatchEvent(new window.Event('change', { bubbles: true }));
    ok(txt(cap('influence')) === 'Choose' && cap('influence').getAttribute('aria-pressed') === 'false', 'unticking the checkbox returns the capsule to Choose');
    ok(JSON.stringify(shown()) === '["shadows"]', 'and removes its cart row');
    box('original').checked = true; box('original').dispatchEvent(new window.Event('change', { bubbles: true }));
    ok(txt(cap('original')) === 'Chosen' && cap('original').getAttribute('aria-pressed') === 'true', 'ticking the checkbox makes the capsule Chosen');
    ok(JSON.stringify(shown()) === '["original","shadows"]', 'and shows its cart row, in book order');

    // state restored without a change event (back button, form restore) is read from the checkboxes
    box('influence').checked = true;
    window.dispatchEvent(new window.Event('pageshow'));
    ok(txt(cap('influence')) === 'Chosen' && JSON.stringify(shown()) === '["original","influence","shadows"]', 'a restored tick shows up in the capsule and the cart');
    ok(box('influence').closest('.pick').querySelector('select').disabled === false && count() === '3 books', 'and in the select and totals');

    // back to empty; focus lands on the message when the last row goes
    ['original', 'influence', 'shadows'].forEach((id) => press(rmBtn(id)));
    ok(shown().length === 0 && empty.hidden === false, 'removing every row brings the empty line back');
    ok(d.activeElement === empty, 'focus moves to the empty line when the last row is removed');
    ok(d.getElementById('totals').hidden === true && caps.every((c) => txt(c) === 'Choose'), 'totals hide and every capsule is Choose again');
    ok(boxes.every((b) => !b.checked), 'all checkboxes end unticked, so the checks below start clean');
  }

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
  ok(d.getElementById('t-sub').textContent === 'BDT 999', 'one book subtotal: ' + d.getElementById('t-sub').textContent);
  ok(d.getElementById('t-save').hidden === true && d.getElementById('t-disc').hidden === true, 'no bundle or code line for one book');
  ok(d.getElementById('t-grand').textContent === 'BDT 1,099', 'one book with delivery: ' + d.getElementById('t-grand').textContent);

  tick(1); tick(2); tick(3);
  ok(d.getElementById('t-sub').textContent === 'BDT 3,996', 'all four subtotal, every book at 999: ' + d.getElementById('t-sub').textContent);
  ok(d.getElementById('t-save').hidden === false, 'bundle line shows for all four');
  ok(d.getElementById('t-save-val').textContent === '- BDT 197', 'bundle saving 197 against four singles: ' + d.getElementById('t-save-val').textContent);
  ok(d.getElementById('t-disc').hidden === true, 'no code line without a code');
  ok(d.getElementById('t-grand').textContent === 'BDT 3,899', 'grand total with delivery: ' + d.getElementById('t-grand').textContent);

  // --- discount code ---
  const codeInput = d.getElementById('o-code');
  const codeBtn = d.getElementById('code-go');
  const codeMsg = d.getElementById('code-msg');
  ok(!!codeInput && !!codeBtn, 'discount code field present');
  ok(!/SAYKAMONI|SAKURA25|PREORDER20/i.test(d.documentElement.innerHTML), 'no discount code appears in the page source');

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

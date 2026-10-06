/* Discount code: page behaviour and the server's independent check */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const file = process.argv[2] || 'contact/index.html';
const fails = [];
const ok = (c, label, extra) => { console.log((c ? 'pass  ' : 'FAIL  ') + label + (extra ? '  ' + extra : '')); if (!c) fails.push(label); };

let posted = null;
const dom = new JSDOM(fs.readFileSync(file, 'utf8'), {
  runScripts: 'dangerously', pretendToBeVisual: true,
  url: 'https://shimantodewan.com/contact',
  beforeParse(w) {
    w.IntersectionObserver = class { constructor(cb){this.cb=cb;} observe(){} unobserve(){} disconnect(){} };
    w.matchMedia = w.matchMedia || (q => ({ matches:false, media:q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){} }));
    w.scrollTo = () => {};
    w.fetch = (url, opts) => {
      if (String(url).includes('/api/code')) {
        const sent = JSON.parse(opts.body);
        // the same shape api/code.js returns: which kind of discount, and for a percent code which percent
        if (String(sent.code).trim().toUpperCase() === 'BOOM') return Promise.reject(new Error('network down'));
        const OFFERS = { FIXEDCODE: { kind:'fixed' }, EYES20: { kind:'percent', percent:20 }, SAYKAMONI: { kind:'free' } };
        const key = String(sent.code).replace(/\s+/g, '').toUpperCase();
        return Promise.resolve({ ok:true, json: () => Promise.resolve(OFFERS[key] ? { valid:true, code:key, ...OFFERS[key] } : { valid:false }) });
      }
      if (String(url).includes('/api/order')) {
        posted = JSON.parse(opts.body);
        // like api/order.js: only a free order carries free:true
        return Promise.resolve({ ok:true, json: () => Promise.resolve({ ok:true, ref:'JZ5', ...(posted.code === 'SAYKAMONI' ? { free:true } : {}) }) });
      }
      return Promise.reject(new Error('blocked ' + url));
    };
  },
});
const { window } = dom, d = window.document;
const wait = (ms) => new Promise(r => setTimeout(r, ms));

(async () => {
  await wait(150);
  window.dispatchEvent(new window.Event('load'));
  await wait(50);

  ok(!d.documentElement.innerHTML.includes('FIXEDCODE'), 'the code never appears in the page source');

  const boxes = [...d.querySelectorAll('input[name="book"]')];
  const fire = (el) => el.dispatchEvent(new window.Event('change', { bubbles:true }));
  const only = (qty) => boxes.forEach(b => {   // qty: { id: n }, everything else unticked
    const n = qty[b.value] || 0;
    b.checked = n > 0; fire(b);
    if (n) { const s = b.closest('.pick').querySelector('select'); s.value = String(n); fire(s); }
  });
  const money = (id) => d.getElementById(id).textContent;
  boxes.forEach(b => { b.checked = true; fire(b); });
  ok(money('t-sub') === 'BDT 3,996', 'all four before any code, every book counted at 999: ' + money('t-sub'));
  ok(d.getElementById('t-save').hidden === false && money('t-save-val') === '- BDT 197', 'bundle line shows 197 against four singles: ' + money('t-save-val'));
  ok(d.querySelector('#t-save > span').textContent === 'Bundle', 'and it is labelled Bundle: ' + d.querySelector('#t-save > span').textContent);
  ok(d.getElementById('t-disc').hidden === true, 'no code line before any code');
  ok(money('t-grand') === 'BDT 3,899', 'grand total before any code: ' + money('t-grand'));

  const input = d.getElementById('o-code'), btn = d.getElementById('code-go');

  input.value = 'NOPE';
  btn.dispatchEvent(new window.Event('click', { bubbles:true }));
  await wait(40);
  ok(d.getElementById('code-msg').textContent === 'That code is not recognised', 'wrong code rejected');
  ok(d.getElementById('t-disc').hidden === true, 'no discount row for a wrong code');
  ok(money('t-grand') === 'BDT 3,899', 'total unchanged by a wrong code');

  input.value = 'fixedcode';   // lower case on purpose
  btn.dispatchEvent(new window.Event('click', { bubbles:true }));
  await wait(40);
  ok(d.getElementById('code-msg').textContent === 'Code applied', 'valid code accepted, case insensitive: ' + d.getElementById('code-msg').textContent);
  ok(!/%/.test(d.getElementById('code-msg').textContent), 'the message states no percentage');
  ok(d.getElementById('t-disc').hidden === false, 'code row appears');
  ok(d.getElementById('t-disc-label').textContent === 'Code FIXEDCODE', 'code row is labelled Code FIXEDCODE: ' + d.getElementById('t-disc-label').textContent);
  ok(money('t-disc-val') === '- BDT 1,300', 'code takes 1,300 off the set, 3,799 to 2,499: ' + money('t-disc-val'));
  ok(d.getElementById('t-save').hidden === false && money('t-save-val') === '- BDT 197', 'both lines show when both apply, bundle still 197');
  ok(money('t-sub') === 'BDT 3,996', 'the base line stays every book at 999');
  ok(money('t-grand') === 'BDT 2,599', 'grand total with code: ' + money('t-grand'));
  ok(!/%/.test(d.getElementById('totals').textContent), 'no percentage anywhere in the totals');

  // the field is not locked: it stays editable and shows the clean code that applied
  ok(input.readOnly === false && input.value === 'FIXEDCODE', 'after a valid code the field is still editable and shows the clean code: ' + input.value);
  const typeIn = (text) => { input.value = text; input.dispatchEvent(new window.Event('input', { bubbles:true })); };
  const msg = () => d.getElementById('code-msg').textContent;
  typeIn('EYES20');
  ok(msg() === 'Press Apply to use this code instead', 'editing the field says what Apply will do: ' + msg());
  ok(d.getElementById('t-disc-label').textContent === 'Code FIXEDCODE' && money('t-grand') === 'BDT 2,599', 'but nothing changes until Apply: the applied code and its total stay');
  typeIn('fixed code');
  ok(msg() === 'Code applied', 'typing the applied code back, in any case or spacing, restores "Code applied"');
  typeIn('');
  ok(msg() === 'Press Apply to remove the code' && money('t-grand') === 'BDT 2,599', 'clearing the field offers to remove the code, and removes nothing yet');
  typeIn('fixedcode');
  btn.dispatchEvent(new window.Event('click', { bubbles:true }));
  await wait(40);
  ok(msg() === 'Code applied' && money('t-grand') === 'BDT 2,599' && input.value === 'FIXEDCODE', 'applying the same code again changes nothing');

  // one book with the code: only the Code line, no bundle
  only({ shadows: 1 });
  ok(money('t-sub') === 'BDT 999' && d.getElementById('t-save').hidden === true, 'one book with code: base 999 and no bundle line');
  ok(money('t-disc-val') === '- BDT 300' && money('t-grand') === 'BDT 799', 'one book with code: code line 300, total 799 with delivery: ' + money('t-disc-val') + ', ' + money('t-grand'));

  // five books with the code: a set plus one single, so the set-plus-singles maths is exercised
  only({ original: 2, inside: 1, influence: 1, shadows: 1 });
  ok(money('t-sub') === 'BDT 4,995', 'five books: base is five at 999: ' + money('t-sub'));
  ok(money('t-save-val') === '- BDT 197' && money('t-disc-val') === '- BDT 1,600', 'five books with code: bundle 197 and code 1,600: ' + money('t-save-val') + ', ' + money('t-disc-val'));
  ok(money('t-grand') === 'BDT 3,298', 'five books with code: 2,499 + 699 + 100 delivery: ' + money('t-grand'));

  // --- EYES20: a different kind of code, 20% off the books after the bundle --------
  const apply = async (typed) => {
    input.value = typed;
    btn.dispatchEvent(new window.Event('click', { bubbles:true }));
    await wait(40);
  };
  await apply('eyes 20');
  ok(d.getElementById('code-msg').textContent === 'Code applied' && !/%/.test(d.getElementById('code-msg').textContent), 'EYES20 accepted with a space and lower case, no percentage in the message');
  ok(d.getElementById('t-disc-label').textContent === 'Code EYES20', 'its row is labelled Code EYES20: ' + d.getElementById('t-disc-label').textContent);

  only({ shadows: 1 });
  ok(money('t-sub') === 'BDT 999' && d.getElementById('t-save').hidden === true, 'EYES20 on one book: base 999, no bundle line');
  ok(money('t-disc-val') === '- BDT 200' && money('t-grand') === 'BDT 899', 'EYES20 on one book: code line 200, total 899 with delivery: ' + money('t-disc-val') + ', ' + money('t-grand'));

  only({ original: 1, inside: 1, influence: 1, shadows: 1 });
  ok(money('t-save-val') === '- BDT 197' && money('t-disc-val') === '- BDT 760', 'EYES20 on four: bundle 197 then code 760: ' + money('t-save-val') + ', ' + money('t-disc-val'));
  ok(money('t-grand') === 'BDT 3,139', 'EYES20 on four: 3,039 + 100 delivery, never stacked on FIXEDCODE: ' + money('t-grand'));

  only({ original: 2, inside: 1, influence: 1, shadows: 1 });
  ok(money('t-sub') === 'BDT 4,995' && money('t-save-val') === '- BDT 197' && money('t-disc-val') === '- BDT 960', 'EYES20 on five: base 4,995, bundle 197, code 960: ' + money('t-disc-val'));
  ok(money('t-grand') === 'BDT 3,938', 'EYES20 on five: 3,838 + 100 delivery: ' + money('t-grand'));
  ok(!/%/.test(d.getElementById('totals').textContent), 'no percentage anywhere in the totals with EYES20');

  // an unknown code never throws away the one that is applied
  await apply('nope');
  ok(msg() === 'That code is not recognised. EYES20 is still applied.', 'an unknown code is refused and says what is still applied: ' + msg());
  ok(d.getElementById('t-disc-label').textContent === 'Code EYES20' && money('t-grand') === 'BDT 3,938', 'EYES20 and its total are kept: ' + money('t-grand'));

  // and so does a failed check
  await apply('boom');
  ok(msg() === 'Could not check that code. EYES20 is still applied.' && money('t-grand') === 'BDT 3,938', 'a failed check keeps the applied code too: ' + msg());

  // FIXEDCODE replaces EYES20 when applied; codes never combine. Enter in the field applies as well.
  input.value = 'fixedcode';
  input.dispatchEvent(new window.KeyboardEvent('keydown', { key:'Enter', bubbles:true, cancelable:true }));
  await wait(40);
  ok(d.getElementById('t-disc-label').textContent === 'Code FIXEDCODE', 'pressing Enter in the field applies the code, replacing EYES20: ' + d.getElementById('t-disc-label').textContent);
  ok(money('t-disc-val') === '- BDT 1,600' && money('t-grand') === 'BDT 3,298', 'FIXEDCODE after EYES20 prices five at 3,298, not a combination: ' + money('t-grand'));

  // an empty field plus Apply removes the code
  await apply('');
  ok(d.getElementById('t-disc').hidden === true && money('t-grand') === 'BDT 4,898' && msg() === '', 'clearing the field and pressing Apply removes the code: ' + money('t-grand'));

  // with nothing applied an unknown code gets the plain message and no discount
  await apply('nope');
  ok(msg() === 'That code is not recognised' && d.getElementById('t-disc').hidden === true, 'with nothing applied an unknown code is just refused: ' + msg());
  typeIn('x');
  ok(msg() === '', 'typing again clears the stale refusal');
  await apply('fixedcode');
  ok(d.getElementById('t-disc-label').textContent === 'Code FIXEDCODE', 'and a good code can then be applied');

  // --- SAYKAMONI: a free code. The books and the delivery are both waived. ----------
  await apply('say ka moni');
  const freeMsg = d.getElementById('code-msg');
  ok(freeMsg.textContent === "For my adorable wife, it's free.", 'a free code shows its own line: ' + freeMsg.textContent);
  ok(/\bis-free\b/.test(freeMsg.className) && !/\bis-on\b/.test(freeMsg.className), 'in its own style class, not the usual one: ' + freeMsg.className);
  ok(!/Code applied|%/.test(freeMsg.textContent), 'and not the usual message, with no percentage');
  ok(d.getElementById('t-disc-label').textContent === 'Code SAYKAMONI', 'the code row is labelled Code SAYKAMONI');
  const deliv = () => money('t-deliv');
  const delivRowShown = () => { const row = d.getElementById('t-deliv').parentElement; return !row.hidden && !d.getElementById('totals').hidden; };

  only({ shadows: 1 });
  ok(money('t-sub') === 'BDT 999' && d.getElementById('t-save').hidden === true && money('t-disc-val') === '- BDT 999', 'free, one book: base 999, no bundle line, code line 999: ' + money('t-disc-val'));
  ok(deliv() === 'BDT 0' && delivRowShown() && money('t-grand') === 'BDT 0', 'free, one book: delivery shown as BDT 0, not hidden, and the total is BDT 0: ' + deliv() + ', ' + money('t-grand'));

  only({ original: 1, inside: 1, influence: 1, shadows: 1 });
  ok(money('t-sub') === 'BDT 3,996' && money('t-save-val') === '- BDT 197' && money('t-disc-val') === '- BDT 3,799', 'free, four: base 3,996, bundle 197, code 3,799: ' + money('t-save-val') + ', ' + money('t-disc-val'));
  ok(deliv() === 'BDT 0' && delivRowShown() && money('t-grand') === 'BDT 0', 'free, four: delivery BDT 0 and total BDT 0');

  only({ original: 2, inside: 1, influence: 1, shadows: 1 });
  ok(money('t-disc-val') === '- BDT 4,798' && money('t-grand') === 'BDT 0', 'free, five: the lines still add up to a total of BDT 0: ' + money('t-disc-val'));
  only({ original: 5, inside: 5, influence: 5, shadows: 5 });
  ok(money('t-grand') === 'BDT 0' && deliv() === 'BDT 0', 'free, twenty books: still BDT 0, so the 599 a book floor does not clamp it: ' + money('t-grand'));

  // editing the field and typing the free code back restores its own line
  typeIn('EYES20');
  ok(msg() === 'Press Apply to use this code instead' && money('t-grand') === 'BDT 0', 'editing keeps the free code applied until Apply');
  typeIn('saykamoni');
  ok(msg() === "For my adorable wife, it's free." && /\bis-free\b/.test(freeMsg.className), 'typing the free code back restores its own line and style');

  // moving to any other code brings delivery back
  await apply('fixedcode');
  only({ original: 1, inside: 1, influence: 1, shadows: 1 });
  ok(deliv() === 'BDT 100' && money('t-grand') === 'BDT 2,599' && /\bis-on\b/.test(freeMsg.className) && msg() === 'Code applied', 'switching to a fixed code charges delivery again and uses the usual message: ' + deliv() + ', ' + money('t-grand'));
  await apply('eyes20');
  ok(deliv() === 'BDT 100' && money('t-grand') === 'BDT 3,139', 'and so does a percent code');
  await apply('');
  ok(deliv() === 'BDT 100' && money('t-grand') === 'BDT 3,899', 'and no code at all');

  // submitting a free order: the page says something different, and says nothing about an email
  const fillForm = () => {
    d.getElementById('o-name').value = 'Rifat Hossain';
    d.getElementById('o-phone').value = '01712345678';
    d.getElementById('o-email').value = 'rifat@example.com';   // required now
    d.getElementById('o-addr').value = 'House 4, Road 11, Banani, Dhaka 1213';
  };
  const panel = () => ({
    head: d.getElementById('order-done-h').textContent,
    text: d.getElementById('order-done-text').hidden,
    sent: d.getElementById('order-sent').hidden,
    ref: d.getElementById('order-ref').textContent,
    shown: d.getElementById('order-done').hidden === false,
  });
  await apply('saykamoni');
  only({ original: 1, inside: 1, influence: 1, shadows: 1 });
  fillForm();
  d.getElementById('order-form').dispatchEvent(new window.Event('submit', { bubbles:true, cancelable:true }));
  await wait(60);
  const fp = panel();
  ok(posted && posted.code === 'SAYKAMONI', 'the free order carries the applied code: ' + (posted && posted.code));
  ok(fp.shown && fp.head === 'Your order is confirmed my beautiful baby', 'a free order reads "Your order is confirmed my beautiful baby": ' + fp.head);
  ok(d.getElementById('order-done-h').className === 'order__done-h', 'in the same heading element, so the same serif size and accent colour as "Order received."');
  ok(fp.text === true, 'the usual lines about confirming the total and payment are hidden');
  ok(fp.sent === true, 'and so is "A copy is on its way to your email", since no email is sent');
  ok(fp.ref === 'JZ5' && d.getElementById('order-ref').closest('p').hidden === false, 'the order reference line is kept: ' + fp.ref);

  // and every other order reads as it always did
  await apply('fixedcode');
  only({ original: 1, inside: 1, influence: 1, shadows: 1 });
  typeIn('EYES20');   // a different code typed but not applied
  fillForm();
  d.getElementById('order-form').dispatchEvent(new window.Event('submit', { bubbles:true, cancelable:true }));
  await wait(60);
  const np = panel();
  ok(posted && posted.code === 'FIXEDCODE', 'the order carries the code that is applied, not whatever is typed in the field: ' + (posted && posted.code));
  ok(np.head === 'Order received.' && np.text === false && np.sent === false, 'a normal order still reads "Order received.", with its usual lines and the email note: ' + np.head);
  ok(np.ref === 'JZ5' && np.shown, 'and shows its reference');
  console.log('\n' + (fails.length ? fails.length + ' FAILURES' : 'all code checks passed'));
  process.exit(fails.length ? 1 : 0);
})();

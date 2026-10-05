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
        const OFFERS = { SAKURA30: { kind:'fixed' }, EYES20: { kind:'percent', percent:20 } };
        const key = String(sent.code).replace(/\s+/g, '').toUpperCase();
        return Promise.resolve({ ok:true, json: () => Promise.resolve(OFFERS[key] ? { valid:true, code:key, ...OFFERS[key] } : { valid:false }) });
      }
      if (String(url).includes('/api/order')) {
        posted = JSON.parse(opts.body);
        return Promise.resolve({ ok:true, json: () => Promise.resolve({ ok:true, ref:'JZ5' }) });
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

  ok(!d.documentElement.innerHTML.includes('SAKURA30'), 'the code never appears in the page source');

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

  input.readOnly = false;
  input.value = 'sakura30';   // lower case on purpose
  btn.dispatchEvent(new window.Event('click', { bubbles:true }));
  await wait(40);
  ok(d.getElementById('code-msg').textContent === 'Code applied', 'valid code accepted, case insensitive: ' + d.getElementById('code-msg').textContent);
  ok(!/%/.test(d.getElementById('code-msg').textContent), 'the message states no percentage');
  ok(d.getElementById('t-disc').hidden === false, 'code row appears');
  ok(d.getElementById('t-disc-label').textContent === 'Code SAKURA30', 'code row is labelled Code SAKURA30: ' + d.getElementById('t-disc-label').textContent);
  ok(money('t-disc-val') === '- BDT 1,300', 'code takes 1,300 off the set, 3,799 to 2,499: ' + money('t-disc-val'));
  ok(d.getElementById('t-save').hidden === false && money('t-save-val') === '- BDT 197', 'both lines show when both apply, bundle still 197');
  ok(money('t-sub') === 'BDT 3,996', 'the base line stays every book at 999');
  ok(money('t-grand') === 'BDT 2,599', 'grand total with code: ' + money('t-grand'));
  ok(!/%/.test(d.getElementById('totals').textContent), 'no percentage anywhere in the totals');

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
    input.readOnly = false;
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
  ok(money('t-grand') === 'BDT 3,139', 'EYES20 on four: 3,039 + 100 delivery, never stacked on SAKURA30: ' + money('t-grand'));

  only({ original: 2, inside: 1, influence: 1, shadows: 1 });
  ok(money('t-sub') === 'BDT 4,995' && money('t-save-val') === '- BDT 197' && money('t-disc-val') === '- BDT 960', 'EYES20 on five: base 4,995, bundle 197, code 960: ' + money('t-disc-val'));
  ok(money('t-grand') === 'BDT 3,938', 'EYES20 on five: 3,838 + 100 delivery: ' + money('t-grand'));
  ok(!/%/.test(d.getElementById('totals').textContent), 'no percentage anywhere in the totals with EYES20');

  // an unknown code after a good one leaves no discount at all
  await apply('nope');
  ok(d.getElementById('code-msg').textContent === 'That code is not recognised', 'an unknown code is refused: ' + d.getElementById('code-msg').textContent);
  ok(d.getElementById('t-disc').hidden === true && money('t-grand') === 'BDT 4,898', 'and no discount remains: ' + money('t-grand'));

  // SAKURA30 again replaces whatever was there; codes never combine
  await apply('sakura30');
  ok(money('t-disc-val') === '- BDT 1,600' && money('t-grand') === 'BDT 3,298', 'SAKURA30 after EYES20 prices five at 3,298, not a combination: ' + money('t-grand'));

  // back to all four for the submit below
  only({ original: 1, inside: 1, influence: 1, shadows: 1 });

  d.getElementById('o-name').value = 'Rifat Hossain';
  d.getElementById('o-phone').value = '01712345678';
  d.getElementById('o-email').value = 'rifat@example.com';   // required now
  d.getElementById('o-addr').value = 'House 4, Road 11, Banani, Dhaka 1213';
  d.getElementById('order-form').dispatchEvent(new window.Event('submit', { bubbles:true, cancelable:true }));
  await wait(60);
  ok(posted && posted.code === 'SAKURA30', 'code sent with the order: ' + (posted && posted.code));

  console.log('\n' + (fails.length ? fails.length + ' FAILURES' : 'all code checks passed'));
  process.exit(fails.length ? 1 : 0);
})();

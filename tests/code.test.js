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
        const good = String(sent.code).trim().toUpperCase() === 'PREORDER20';
        return Promise.resolve({ ok:true, json: () => Promise.resolve({ valid:good, percent: good ? 20 : 0 }) });
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

  ok(!d.documentElement.innerHTML.includes('PREORDER20'), 'the code never appears in the page source');

  const boxes = [...d.querySelectorAll('input[name="book"]')];
  boxes.forEach(b => { b.checked = true; b.dispatchEvent(new window.Event('change', { bubbles:true })); });
  ok(d.getElementById('t-sub').textContent === 'BDT 4,999', 'all four before any code');
  ok(d.getElementById('t-grand').textContent === 'BDT 5,099', 'grand total before any code');

  const input = d.getElementById('o-code'), btn = d.getElementById('code-go');

  input.value = 'NOPE';
  btn.dispatchEvent(new window.Event('click', { bubbles:true }));
  await wait(40);
  ok(d.getElementById('code-msg').textContent === 'That code is not recognised', 'wrong code rejected');
  ok(d.getElementById('t-disc').hidden === true, 'no discount row for a wrong code');
  ok(d.getElementById('t-grand').textContent === 'BDT 5,099', 'total unchanged by a wrong code');

  input.readOnly = false;
  input.value = 'preorder20';   // lower case on purpose
  btn.dispatchEvent(new window.Event('click', { bubbles:true }));
  await wait(40);
  ok(d.getElementById('code-msg').textContent === '20% off applied', 'valid code accepted, case insensitive');
  ok(d.getElementById('t-disc').hidden === false, 'discount row appears');
  ok(d.getElementById('t-disc-val').textContent === '- BDT 1,000', 'twenty percent of 4,999: ' + d.getElementById('t-disc-val').textContent);
  ok(d.getElementById('t-grand').textContent === 'BDT 4,099', 'grand total after discount: ' + d.getElementById('t-grand').textContent);

  d.getElementById('o-name').value = 'Rifat Hossain';
  d.getElementById('o-phone').value = '01712345678';
  d.getElementById('o-email').value = 'rifat@example.com';   // required now
  d.getElementById('o-addr').value = 'House 4, Road 11, Banani, Dhaka 1213';
  d.getElementById('order-form').dispatchEvent(new window.Event('submit', { bubbles:true, cancelable:true }));
  await wait(60);
  ok(posted && posted.code === 'PREORDER20', 'code sent with the order: ' + (posted && posted.code));

  console.log('\n' + (fails.length ? fails.length + ' FAILURES' : 'all code checks passed'));
  process.exit(fails.length ? 1 : 0);
})();

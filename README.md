# shimantodewan.com

Static site plus one serverless function. No build step.

```
index.html              landing page
contact/index.html      full site, NFC destination (noindex)
info/index.html         full site, public, email contact only
404.html
api/order.js            POST endpoint for book pre-orders
images/ fonts/
vercel.json             security headers and caching
robots.txt sitemap.xml
```

---

## What you must do by hand

### 1. Pre-order emails (required, or the form cannot send)

Vercel, Settings, Environment Variables. Add, then redeploy.

| Name | Value |
|---|---|
| `RESEND_API_KEY` | from resend.com, free tier is 100 emails a day |
| `ORDER_TO` | contact@shimantodewan.com |

Optional `ORDER_TO_CC`: a second address that receives the same order
email. Leave it unset to send to `ORDER_TO` only. The buyer's confirmation
is never copied to it.

Optional `ORDER_FROM`. Defaults to Resend's shared test sender, which works
at once but often lands in spam. Verify shimantodewan.com in Resend, then
set `ORDER_FROM` to `Pre-orders <orders@shimantodewan.com>`.

Without the key the form shows an honest error and points buyers at your
email. The order still appears in the Vercel function log, so nothing is lost.

### 2. Dispatch date (recommended before taking money)

Two places, both plain text:

- `ORDER_CONFIG.dispatch` near the pre-order script in **both**
  `contact/index.html` and `info/index.html`, e.g. `"late November 2026"`
- `ORDER_DISPATCH` as a Vercel environment variable, same wording, so the
  emails match the site

Leave both empty and no dispatch line appears anywhere. Nothing breaks,
but buyers have no answer to "when do I get it?".

### 3. Web Analytics (one click)

Vercel, your project, the Analytics tab, Enable. The script tag is already
in all four pages and loads from your own domain, so no cookie banner and
no third party.

### 4. Order log (recommended, five minutes)

Vercel, Storage, create an Upstash Redis database and connect it to the
project. That sets `KV_REST_API_URL` and `KV_REST_API_TOKEN` for you.
Every order is then appended to a list called `orders`, as well as emailed.
Without it, email is your only record.

The same database keeps order references unique. A reference is two letters
and a digit, like `JZ5`. There are only 4,608 of those, so when a code has
already been used another digit is added (`JZ57`), and again if needed.
Without the database nothing remembers earlier codes, so repeats become
likely after a few dozen orders.

### 5. Bot protection (optional)

Cloudflare, Turnstile, add a widget for shimantodewan.com. Then:

- paste the **site key** into `ORDER_CONFIG.turnstileSiteKey` in both pages
- add the **secret key** as `TURNSTILE_SECRET` in Vercel

Until both exist the check is skipped entirely and nothing is loaded from
Cloudflare. Once the secret is set the server rejects unverified orders.

### 6. Discount code (optional)

Add to Vercel:

| Name | Value |
|---|---|
| `ORDER_CODES` | comma separated, e.g. `SAKURA30,FRIENDS` |

A code does not take a percentage off. It switches the order to the fixed
code prices listed under Prices below, so every code gives the same prices.

The codes exist only here. They are never written into the pages, so a
buyer cannot find one by reading the source. The browser asks
`/api/code` whether a typed code is real, and `/api/order` checks it
again before pricing, so a forged answer in the browser changes nothing.

Codes are matched without regard to case or spaces. With `ORDER_CODES`
unset every code is politely rejected and the form works as normal.

To change or retire a code, edit the variable and redeploy. Nothing in
the repository needs to change.

### 7. Book covers

Four images in `images/behind-the-eyes/`, named `original.jpg`,
`inside.jpg`, `influence.jpg`, `shadows.jpg`. Until then each slot shows
the book title rather than a broken image.

---

## Prices

All fixed amounts in BDT, no percentages.

| | No code | With a code |
|---|---|---|
| One book | 999 | 699 |
| All four | 3,799, against 3,996 for four singles | 2,499 |
| RRP, struck through on the cards | 1,499 | |
| Floor | never less than 599 a book | |
| Delivery | about 100, Pathao, inside Dhaka, never discounted | |

Each complete set of four is priced as a set and any extras as singles, at
the code prices when a valid code is applied. The totals show the saving
against every book at 999: a "Bundle" line when only the bundle applies, a
"Code" line when only the code applies, and both when both do.

The floor is a guard, not something that fires at these prices (2,499 for
four is 625 a book). If a price change ever pushes the books under 599 each,
the server charges the floor instead and writes a `PRICE FLOOR applied`
warning, with the order reference, to the function log.

The browser shows this arithmetic, but `api/order.js` recalculates it and
that result is what goes in the emails, so an edited page cannot change a
price.

Changing a price means editing `SINGLE`, `SINGLE_CODE`, `SET`, `SET_CODE`,
`WAS` and `FLOOR` in `api/order.js`, the matching constants in both pages'
pre-order scripts, and the price copy in both pages.

## Tests

```bash
npm install jsdom
node tests/page.test.js contact/index.html
node tests/page.test.js info/index.html
node tests/code.test.js contact/index.html
node tests/code.test.js info/index.html
node tests/api.test.js
```

Everything should pass before any commit. The suite covers the order
form, set and code pricing, the price floor, that the pages and the server
agree on every total, discount codes, validation, price tampering, the
honeypot, Turnstile and the order log.

## Everything else personal

The `PROFILE` object near the top of the script in `contact/index.html`
and `info/index.html`.

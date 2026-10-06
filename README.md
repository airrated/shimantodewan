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

### 6. Discount codes (optional)

Every discount code is its own variable in Vercel (Settings, Environment
Variables). The name says which code it is and the value says what it does:

```
ORDER_CODE_<NAME>   =   what the code does
```

`<NAME>` is the code buyers type, in capitals, using letters and digits
(for example `SAYKAMONI`). The value is exactly one of these three:

| Value | What the code does |
|---|---|
| `fixed` | Switches the order to the fixed code prices: 699 a single, 2,499 for all four |
| `percent:N` | Takes N per cent off the books after any bundle, at normal prices. `N` is a whole number from 1 to 90, for example `percent:20` |
| `free` | A complete waiver: the books and the delivery charge are both free, so the total is BDT 0 |

**Set these two today:**

| Name | Value |
|---|---|
| `ORDER_CODE_SAYKAMONI` | `free` |
| `ORDER_CODE_EYES20` | `percent:20` |

Then **redeploy**. Vercel only applies a changed variable to a new
deployment (Deployments, the latest one, Redeploy).

The rules:

- One code per order. The form takes a single code, and codes never stack.
- Buyers can type the code in any case and with spaces: `eyes 20` is `EYES20`.
- The code field is never locked. To switch codes a buyer edits the field and
  presses Apply again, which replaces the first. A code that is not recognised
  leaves the applied one in place, and clearing the field then pressing Apply
  removes the code. The order always carries the code that is applied, not
  whatever happens to be typed in the field.
- The 599 a book floor applies to every outcome, and delivery is never
  discounted. The one exception is a `free` code, which is a deliberate waiver.
- The codes exist only here. They are never written into the pages, so a
  buyer cannot find one by reading the source. The browser asks `/api/code`
  whether a typed code is real and what kind it is, and `/api/order` looks it
  up again before pricing, so a forged answer in the browser changes nothing.
- A code that does not exist gives no discount, and the form works as normal.

#### Adding a third code

Say you want `FRIENDS10`, ten per cent off:

1. Vercel, your project, Settings, Environment Variables, Add New.
2. Name `ORDER_CODE_FRIENDS10`, value `percent:10`. Save.
3. Redeploy.
4. Try it on the site: type `friends10`, press Apply. You should see "Code
   applied" and a "Code FRIENDS10" line in the totals.

For a fixed-price code, the value is `fixed`: 699 a single and 2,499 for all
four, the same for every `fixed` code.

#### A free code

A code whose value is `free` waives everything, so please treat it as a
private code. For a `free` order:

- The books and the delivery charge are both BDT 0, and the 599 a book floor
  does not apply. Delivery shows as 0 in the totals, not hidden.
- No confirmation email goes to the buyer. The owner email still goes to
  `ORDER_TO` and `ORDER_TO_CC`, with `FREE ORDER` in the subject, a banner
  saying nothing is to be paid, and the status line `NO CONFIRMATION SENT,
  FREE ORDER`, so a skipped email is never mistaken for a failed one.
- The order is still written to the Upstash log, with `free: true` and the
  reference.
- The page shows its own messages instead of the usual ones: a line under the
  code field, and "Your order is confirmed my beautiful baby" with the
  reference after the order.

There is no limit on how many books a free order can hold (up to five of each
title), and no limit on how often the code is used. Anyone who has the code
can use it. To stop a free code, delete its variable and redeploy.

#### Retiring a code

Say `EYES20` is over:

1. Delete the variable `ORDER_CODE_EYES20`.
2. Redeploy.

From then on typing `EYES20` shows "That code is not recognised" and gives no
discount. Orders already placed keep the price they were given.

To change how much a percent code takes off, edit its value (`percent:20`
to `percent:25`) and redeploy. Nothing in the repository needs to change.

#### If a value is wrong

Say `ORDER_CODE_EYES20` is set to `percent:abc`. That one code is treated as
if it did not exist: buyers see "not recognised", nobody gets any discount from
it (it is never read as 0% off, and nothing crashes), and every other code
keeps working. The function log gets a warning that names the variable and
the value, for example:

```
Discount code variable ORDER_CODE_EYES20 is malformed (value: "percent:abc").
Expected 'fixed' or 'percent:N' with N a whole number from 1 to 90. ...
```

Find it in Vercel, your project, Logs, by searching for `malformed`. The same
happens for `percent:0`, `percent:95`, `percent:20.5`, `20`, or an empty
value. Case and spaces around the colon do not matter (`Percent : 20` is fine).

#### Old variables

`ORDER_CODES` and `ORDER_CODE_PERCENT` from earlier versions are no longer
read. Delete them from Vercel. (`ORDER_CODE_PERCENT` is ignored on purpose,
so it is never mistaken for a code called `PERCENT`.)
### 7. Book covers

Four images in `images/behind-the-eyes/`, named `original.jpg`,
`inside.jpg`, `influence.jpg`, `shadows.jpg`. Until then each slot shows
the book title rather than a broken image.

---

## Prices

Prices are fixed amounts in BDT. A `fixed` code switches to the code prices; a `percent` code takes a share off the books after the bundle.

| | No code | `fixed` code | `percent:20` code (EYES20) |
|---|---|---|---|
| One book | 999 | 699 | 799 |
| All four | 3,799, against 3,996 for four singles | 2,499 | 3,039 |
| Mixed five (a set and one single) | 4,798 | 3,198 | 3,838 |
| RRP, struck through on the cards | 1,499 | | |
| Floor | never less than 599 a book | |
| Delivery | about 100, Pathao, inside Dhaka, never discounted | |

Each complete set of four is priced as a set and any extras as singles. A
percent code rounds its discount to the nearest taka (20% of 4,798 is 959.6,
so 960). The totals show the saving against every book at 999: a "Bundle"
line when only the bundle applies, a "Code EYES20" (or whatever the code is) line
when only the code applies, and both when both do. Never a percentage. A `free`
code brings the books and the delivery to 0, and the floor does not apply to it.

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

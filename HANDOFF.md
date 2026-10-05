# Handoff brief

Paste this into Claude Code with the project folder open.

---

This is a static personal site plus one Vercel serverless function.
No build step, no framework. Please read `README.md` first.

```
index.html              landing page, charcoal, logo and name only
contact/index.html      full site, the NFC card points here, noindex
info/index.html         same site, public and indexed, email contact only
404.html
api/order.js            POST endpoint for book pre-orders
tests/                  run these after any change, see below
vercel.json             CSP and caching headers
```

`contact/index.html` and `info/index.html` are near-identical and must be
edited together. `info` deliberately differs in three ways: no phone or
WhatsApp anywhere, no relationship section, and a more formal register.

## House rules, please keep to them

- Zero em dash and en dash characters anywhere in the project. Use `-`.
  Check with: `grep -c $'\u2014\|\u2013' *.html */*.html`
- Palette is ivory `#F3ECE4`, ink `#141110`, accent `#D4634F`, and a
  darkened accent `#96382A` used only for small text on ivory, where the
  bright accent fails contrast.
- Typography is the design. Bodoni Moda for display, Inter for UI, IBM Plex
  Mono for metadata, all self hosted from `/fonts`. Do not add a font.
- No cards, gradients, glass, blobs or particles.
- Mobile uses native scrolling. Lenis and pinned sections are desktop only,
  behind `(min-width: 900px) and (pointer: fine)`. Do not reintroduce
  smooth scroll or pinning on touch.

## Running the tests

```bash
npm install jsdom
node tests/page.test.js contact/index.html
node tests/page.test.js info/index.html
node tests/code.test.js contact/index.html
node tests/code.test.js info/index.html
node tests/api.test.js
```

All five passes should be green before any commit.

## What I would like done

1. Set the dispatch date in three places: `ORDER_CONFIG.dispatch` in both
   pages, and `ORDER_DISPATCH` in Vercel.
2. Add the four book cover images to `images/behind-the-eyes/`.
3. Set the environment variables listed in `README.md`, including
   one `ORDER_CODE_<NAME>` variable per discount code you want live (README step 6).
4. Deploy and confirm `/`, `/info`, `/contact` and a 404 path all work.

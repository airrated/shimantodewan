/* =============================================================================
   POST /api/order
   Receives a pre-order, validates it server side, and emails it to Shimanto.

   Vercel runs this as a Node serverless function. Set two environment
   variables in the Vercel dashboard:

     RESEND_API_KEY   from resend.com, free tier covers 100 emails a day
     ORDER_TO         where orders land, defaults to contact@shimantodewan.com
     ORDER_TO_CC      optional second address that gets the same owner email

   Prices live here, not in the browser, so a tampered form cannot change them.
   Every price is a fixed amount in BDT. Discount codes are defined in the
   environment, one variable per code (see lib/codes.js and the README).
   ========================================================================== */

const codes = require("../lib/codes");

const WAS = 1499;                         // RRP, struck through on the cards
const SINGLE = 999, SINGLE_CODE = 699;    // one book, without and with a valid code
const SET = 3799, SET_CODE = 2499;        // all four together, without and with a code
const FLOOR = 599;                        // never charge less than this per book
const DELIVERY = 100;                     // never discounted
const DELIVERY_DAYS = "5 to 7 working days";

// Set this once you know when printing finishes, e.g. "late November 2026".
// Leave it empty and no dispatch line appears anywhere.
const DISPATCH = process.env.ORDER_DISPATCH || "";

const CATALOGUE = {
  original:  "Behind the Eyes: Original",
  inside:    "Behind the Eyes: Inside",
  influence: "Behind the Eyes: Influence",
  shadows:   "Behind the Eyes: Shadows",
};

const money = (n) => "BDT " + n.toLocaleString("en-US");

// Each complete set of four is priced as a set and the rest as singles. A
// valid code (`offer`, from lib/codes) is one of two kinds: "fixed" swaps in
// the code prices, "percent" takes that much off the books after the bundle,
// at normal prices. Only one code applies to an order, so they never stack.
// The browser shows the same arithmetic, but this is the copy that counts.
function priceOrder(items, offer) {
  const qty = {};
  items.forEach((i) => { qty[i.id] = (qty[i.id] || 0) + i.qty; });
  const ids = Object.keys(CATALOGUE);
  const sets = ids.every((id) => qty[id]) ? Math.min(...ids.map((id) => qty[id])) : 0;
  const units = items.reduce((a, i) => a + i.qty, 0);
  const singles = units - sets * 4;
  const fixed = !!offer && offer.kind === "fixed";
  let computed = sets * (fixed ? SET_CODE : SET) + singles * (fixed ? SINGLE_CODE : SINGLE);
  if (offer && offer.kind === "percent") computed -= Math.round(computed * offer.percent / 100);

  // Hard floor, whatever the prices or the code say: never less than FLOOR a
  // book, for every outcome. At today's prices it cannot bind; it guards
  // against a later price change or a large percentage.
  const floor = FLOOR * units;
  const clamped = computed < floor;
  const payable = clamped ? floor : computed;

  // Savings are measured against every book at the single price, so the
  // lines always add up to what is charged, floor or not
  const baseline = units * SINGLE;
  const saved = Math.max(0, baseline - payable);
  const bundleSaving = Math.min(saved, Math.max(0, sets * (4 * SINGLE - SET)));
  const codeSaving = saved - bundleSaving;
  return { units, sets, singles, baseline, bundleSaving, codeSaving, computed, floor, clamped, payable };
}
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => (
  { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]
));

// Two letters and a digit, e.g. JZ5. Short, readable, hard to mistype on the
// phone, and no I, O, 0 or 1 to mix up.
const ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LETTERS = ALPHABET.replace(/[0-9]/g, "");
const DIGITS = ALPHABET.replace(/[^0-9]/g, "");
const pick = (s) => s[Math.floor(Math.random() * s.length)];
const reference = () => pick(LETTERS) + pick(LETTERS) + pick(DIGITS);

// There are only 4,608 codes of that shape, so repeats are likely after a few
// dozen orders. When a code is already taken another digit is added, and again
// if that is taken too, so no two orders ever share one. Taken codes are kept
// in Redis, the same database as the order log, and claimed with SET NX so two
// orders arriving together cannot both get it. With no database there is
// nothing to check against and the plain code is used as it is. The check is
// best effort: it must never hold up or fail an order.
async function claimReference() {
  let ref = reference();
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return ref;
  for (let tries = 0; tries < 12; tries++) {
    try {
      const r = await fetch(url.replace(/\/$/, ""), {
        method: "POST",
        headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" },
        body: JSON.stringify(["SET", "ref:" + ref, "1", "NX"]),
      });
      const d = await r.json();
      if (!r.ok || d.error) return ref;      // cannot tell, so carry on with it
      if (d.result === "OK") return ref;     // ours
    } catch (err) {
      console.error("Could not check the reference for repeats:", err);
      return ref;
    }
    ref += pick(DIGITS);                     // taken: lengthen and try again
  }
  return ref;
}

function shell(inner) {
  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F3ECE4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3ECE4;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#F3ECE4;">
${inner}
    </table>
  </td></tr>
</table>
</body></html>`;
}

function itemRows(o) {
  return o.items.map((i) => `
    <tr>
      <td style="padding:10px 0;border-bottom:1px solid #DED3C6;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#141110;">
        ${esc(i.title)}
      </td>
      <td style="padding:10px 0;border-bottom:1px solid #DED3C6;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#141110;text-align:right;white-space:nowrap;">
        &times;${i.qty} &nbsp; ${money(i.qty * SINGLE)}
      </td>
    </tr>`).join("");
}

function totalsRows(o) {
  const code = o.codeSaving ? `
    <tr>
      <td style="padding:10px 0;font-family:'Courier New',monospace;font-size:12px;color:#96382A;">Code ${esc(o.code)}</td>
      <td style="padding:10px 0;font-family:'Courier New',monospace;font-size:12px;color:#96382A;text-align:right;">- ${money(o.codeSaving)}</td>
    </tr>` : "";
  const bundle = o.bundleSaving ? `
    <tr>
      <td style="padding:10px 0;font-family:'Courier New',monospace;font-size:12px;color:#96382A;">Bundle</td>
      <td style="padding:10px 0;font-family:'Courier New',monospace;font-size:12px;color:#96382A;text-align:right;">- ${money(o.bundleSaving)}</td>
    </tr>` : "";
  return bundle + code + `
    <tr>
      <td style="padding:10px 0;font-family:'Courier New',monospace;font-size:12px;color:#6E655C;">Delivery, Pathao, approx.</td>
      <td style="padding:10px 0;font-family:'Courier New',monospace;font-size:12px;color:#6E655C;text-align:right;">${money(DELIVERY)}</td>
    </tr>
    <tr>
      <td style="padding:12px 0;border-top:1px solid #141110;font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#141110;">Approximate total</td>
      <td style="padding:12px 0;border-top:1px solid #141110;font-family:Georgia,'Times New Roman',serif;font-size:18px;color:#96382A;text-align:right;white-space:nowrap;">${money(o.payable + DELIVERY)}</td>
    </tr>`;
}

// Item, bundle, discount and total lines for both plain-text emails, so the
// owner and buyer copies come from one place, as the HTML ones do
function orderLines(o) {
  return [
    ...o.items.map((i) => "  " + i.title + " x" + i.qty + "   " + money(i.qty * SINGLE)),
    ...(o.bundleSaving ? ["  Bundle:  - " + money(o.bundleSaving)] : []),
    ...(o.codeSaving ? ["  Code " + o.code + ":  - " + money(o.codeSaving)] : []),
    "  Books total: " + money(o.payable),
    "  Delivery, approx: " + money(DELIVERY),
    "  Approximate total: " + money(o.payable + DELIVERY),
  ];
}

// Sent to the buyer, whose email is required
function buyerHtml(o) {
  return shell(`
      <tr><td style="padding-bottom:6px;font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#96382A;">
        Pre-order ${esc(o.ref)}
      </td></tr>
      <tr><td style="padding-bottom:22px;border-bottom:1px solid #141110;font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.05;color:#141110;">
        Thank you,<br><span style="color:#96382A;">${esc(o.name.split(" ")[0])}</span>
      </td></tr>

      <tr><td style="padding:20px 0 0;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.6;color:#141110;">
        Your pre-order is with me. Nothing has been charged yet.
      </td></tr>

      <tr><td style="padding:22px 0 8px;font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#6E655C;">
        Your order
      </td></tr>
      <tr><td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemRows(o)}${totalsRows(o)}</table>
      </td></tr>

      <tr><td style="padding:24px 0 8px;font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#6E655C;">
        What happens next
      </td></tr>
      <tr><td style="padding-bottom:22px;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.65;color:#141110;">
        I will message you on WhatsApp at <b>${esc(o.phone)}</b> to confirm the final total, including the exact
        delivery charge for your area, and send the payment details for bKash, Nagad, Bank Transfer or RedotPay then.
        <b>Please do not send payment before that.</b>
      </td></tr>

      <tr><td style="padding:22px 0 8px;border-top:1px solid #DED3C6;font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#6E655C;">
        CHANGED YOUR MIND
      </td></tr>
      <tr><td style="font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.65;color:#141110;">
        Reply to this email with the word <b style="color:#96382A;">CANCEL</b> in capitals, any time
        before your order goes out. No payment, no questions.
      </td></tr>

      <tr><td style="padding:22px 0 8px;font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#6E655C;">
        Delivering to
      </td></tr>
      <tr><td style="padding-bottom:16px;border-bottom:1px solid #DED3C6;font-family:Georgia,'Times New Roman',serif;font-size:16px;line-height:1.5;color:#141110;">
        ${esc(o.address).replace(/\n/g, "<br>")}
      </td></tr>

      <tr><td style="padding-top:20px;font-family:'Courier New',monospace;font-size:11px;line-height:1.9;letter-spacing:1px;color:#6E655C;">
        ${DISPATCH ? "DISPATCH " + esc(DISPATCH.toUpperCase()) + "<br>" : ""}DELIVERY ${DELIVERY_DAYS.toUpperCase()}, INSIDE DHAKA, BY PATHAO<br>
        REFERENCE ${esc(o.ref)}<br>
        CANCEL ANY TIME BEFORE DISPATCH FOR A FULL REFUND<br>
        QUESTIONS, REPLY TO THIS EMAIL
      </td></tr>
      <tr><td style="padding-top:26px;border-top:1px solid #141110;font-family:Georgia,'Times New Roman',serif;font-size:15px;color:#141110;">
        Shimanto Dewan<br>
        <span style="font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#6E655C;">Behind the Eyes</span>
      </td></tr>`);
}

function buyerText(o) {
  return [
    "Thank you, " + o.name.split(" ")[0] + ".",
    "",
    "Your pre-order is with me. Nothing has been charged yet.",
    "Reference: " + o.ref,
    "",
    "Your order:",
    ...orderLines(o),
    "",
    "What happens next:",
    "I will message you on WhatsApp at " + o.phone + " to confirm the final total, including the",
    "exact delivery charge for your area, and send the payment details for",
    "bKash, Nagad, Bank Transfer or RedotPay then.",
    "Please do not send payment before that.",
    "",
    "Changed your mind? Reply to this email with the word CANCEL in capitals, any time",
    "before your order goes out. No payment, no questions.",
    "",
    "Delivering to:",
    o.address,
    "",
    (DISPATCH ? "Dispatch " + DISPATCH + "." : "") ,
    "Delivery " + DELIVERY_DAYS + " from confirmation, inside Dhaka, by Pathao.",
    "You can cancel any time before dispatch for a full refund.",
    "",
    "Shimanto Dewan",
    "Behind the Eyes",
  ].join("\n");
}

function emailHtml(o) {
  const field = (label, value) => `
    <tr>
      <td style="padding:12px 0 4px;font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#6E655C;">
        ${esc(label)}
      </td>
    </tr>
    <tr>
      <td style="padding:0 0 10px;border-bottom:1px solid #DED3C6;font-family:Georgia,'Times New Roman',serif;font-size:17px;color:#141110;">
        ${esc(value).replace(/\n/g, "<br>")}
      </td>
    </tr>`;

  return `<!DOCTYPE html>
<html><body style="margin:0;padding:0;background:#F3ECE4;">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#F3ECE4;padding:32px 16px;">
  <tr><td align="center">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#F3ECE4;">

      <tr><td style="padding-bottom:6px;font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#96382A;">
        Pre-order ${esc(o.ref)} &nbsp;/&nbsp; Behind the Eyes
      </td></tr>
      <tr><td style="padding-bottom:22px;border-bottom:1px solid #141110;font-family:Georgia,'Times New Roman',serif;font-size:34px;line-height:1.05;color:#141110;">
        New order from<br><span style="color:#96382A;">${esc(o.name)}</span>
      </td></tr>

      <tr><td style="padding-top:18px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
          ${field("Name", o.name)}
          ${field("WhatsApp", o.phone)}
          ${field("Email", o.email)}
          ${field("Delivery address", o.address)}
        </table>
      </td></tr>

      <tr><td style="padding:26px 0 8px;font-family:'Courier New',monospace;font-size:10px;letter-spacing:2px;text-transform:uppercase;color:#6E655C;">
        Books
      </td></tr>
      <tr><td>
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0">${itemRows(o)}${totalsRows(o)}</table>
      </td></tr>

      <tr><td style="padding-top:26px;font-family:'Courier New',monospace;font-size:11px;line-height:1.9;letter-spacing:1px;color:#6E655C;">
        PRE-ORDER PRICE ${money(SINGLE)} &nbsp;&middot;&nbsp; RRP ${money(WAS)}<br>
        DELIVERY ${DELIVERY_DAYS.toUpperCase()} &nbsp;&middot;&nbsp; INSIDE DHAKA ONLY<br>
        RECEIVED ${esc(o.at)}<br>
        ${o.buyerSent
          ? "CONFIRMATION SENT TO BUYER"
          : '<span style="color:#96382A;">CONFIRMATION FAILED, RESEND MANUALLY</span>'}
      </td></tr>

    </table>
  </td></tr>
</table>
</body></html>`;
}

function emailText(o) {
  return [
    "PRE-ORDER - Behind the Eyes",
    "",
    "Reference: " + o.ref,
    "",
    "Name:     " + o.name,
    "WhatsApp: " + o.phone,
    "Email:    " + o.email,
    "Address:  " + o.address,
    "",
    "Books:",
    ...orderLines(o),
    "",
    "Delivery " + DELIVERY_DAYS + ", inside Dhaka only.",
    "Received " + o.at,
    o.buyerSent ? "Confirmation sent to buyer." : "CONFIRMATION FAILED, RESEND MANUALLY.",
  ].join("\n");
}

// Best effort: an order already emailed must not fail because the log did
async function record(order) {
  const url = process.env.KV_REST_API_URL, token = process.env.KV_REST_API_TOKEN;
  if (!url || !token) return;
  try {
    await fetch(url.replace(/\/$/, "") + "/lpush/orders", {
      method: "POST",
      headers: { Authorization: "Bearer " + token, "Content-Type": "text/plain" },
      body: JSON.stringify(order),
    });
  } catch (err) {
    console.error("Could not append order to the log:", err);
  }
}

// Only enforced when a secret is configured, so the form keeps working
// before Turnstile is set up
async function humanOk(token, ip) {
  const secret = process.env.TURNSTILE_SECRET;
  if (!secret) return true;
  if (!token) return false;
  try {
    const r = await fetch("https://challenges.cloudflare.com/turnstile/v0/siteverify", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ secret, response: token, remoteip: ip }),
    });
    const d = await r.json();
    return !!d.success;
  } catch (err) {
    console.error("Turnstile verify threw:", err);
    return false;                      // fail closed once it is switched on
  }
}

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (_) { b = {}; } }
  b = b || {};

  // Honeypot: real people never fill this in
  if (b.company) return res.status(200).json({ ok: true });

  const name = String(b.name || "").trim();
  const phone = String(b.phone || "").trim();
  const address = String(b.address || "").trim();
  const email = String(b.email || "").trim();
  const digits = phone.replace(/[^0-9]/g, "");

  const errors = [];
  if (name.length < 2 || name.length > 80) errors.push("name");
  if (!/^(?:88)?01[3-9][0-9]{8}$/.test(digits)) errors.push("phone");
  if (address.length < 10 || address.length > 500) errors.push("address");
  // Required: it is where the buyer's confirmation goes
  if (!email || email.length > 120 || !/^[^\s@]+@[^\s@]+\.[a-zA-Z]{2,}$/.test(email)) errors.push("email");

  const rawItems = Array.isArray(b.items) ? b.items
    .map((i) => ({
      id: String(i && i.id || ""),
      qty: Math.max(1, Math.min(5, parseInt(i && i.qty, 10) || 0)),
    }))
    .filter((i) => CATALOGUE[i.id]) : [];
  const items = rawItems.map((i) => ({ title: CATALOGUE[i.id], qty: i.qty }));

  if (!items.length) errors.push("items");
  if (errors.length) return res.status(400).json({ ok: false, errors });

  const human = await humanOk(
    b["cf-turnstile-response"],
    (req.headers["x-forwarded-for"] || "").split(",")[0].trim()
  );
  if (!human) return res.status(400).json({ ok: false, error: "verification" });

  // Checked again here: whatever /api/code told the browser is irrelevant
  const offer = codes.lookup(b.code);
  const p = priceOrder(rawItems, offer);
  const order = {
    name, phone, address, email, items,
    units: p.units, sets: p.sets, baseline: p.baseline,
    bundleSaving: p.bundleSaving, codeSaving: p.codeSaving, payable: p.payable,
    code: offer ? offer.code : "",
    ref: await claimReference(),
    at: new Date().toLocaleString("en-GB", { timeZone: "Asia/Dhaka" }) + " (Dhaka)",
  };

  // A price changed by the floor must be visible, never silent
  if (p.clamped) {
    console.warn("PRICE FLOOR applied to order " + order.ref + ": computed books subtotal "
      + money(p.computed) + " is under the floor of " + money(p.floor)
      + " (" + money(FLOOR) + " x " + p.units + " books), so the floor was charged instead.");
  }

  const key = process.env.RESEND_API_KEY;
  const to = process.env.ORDER_TO || "contact@shimantodewan.com";
  const cc = (process.env.ORDER_TO_CC || "").trim();
  const ownerTo = [to, cc].filter((a, i, all) => a && all.indexOf(a) === i);
  const from = process.env.ORDER_FROM || "Pre-orders <onboarding@resend.dev>";

  if (!key) {
    console.error("RESEND_API_KEY is not set; order received but not emailed:", emailText(order));
    return res.status(500).json({ ok: false, error: "not_configured" });
  }

  // The buyer's copy goes first so the owner email can say whether it
  // arrived. It is best effort: whatever happens here is reported to the
  // owner, and never fails the order.
  order.buyerSent = false;
  try {
    const c = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: [email], reply_to: to,
        subject: "Your pre-order " + order.ref + " - Behind the Eyes",
        html: buyerHtml(order),
        text: buyerText(order),
      }),
    });
    if (c.ok) order.buyerSent = true;
    else console.error("Buyer confirmation failed:", c.status, await c.text());
  } catch (err) {
    console.error("Buyer confirmation threw:", err);
  }

  // The buyer may already hold a confirmation by now, so if the owner copy
  // cannot be sent the order is written down before the failure is reported.
  async function ownerFailed() {
    console.error("Owner email failed; order kept here:", emailText(order));
    await record({ ...order, ownerEmail: "failed" });
    return res.status(502).json({ ok: false, error: "send_failed" });
  }

  try {
    const r = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: "Bearer " + key, "Content-Type": "application/json" },
      body: JSON.stringify({
        from, to: ownerTo,
        reply_to: email || undefined,          // so a reply reaches the buyer
        subject: "Pre-order " + order.ref + " - " + name + " - "
                 + items.reduce((a, i) => a + i.qty, 0) + " book(s)",
        html: emailHtml(order),
        text: emailText(order),
      }),
    });
    if (!r.ok) {
      console.error("Resend rejected the order email:", r.status, await r.text());
      return ownerFailed();
    }
  } catch (err) {
    console.error("Order email threw:", err);
    return ownerFailed();
  }

  await record(order);
  return res.status(200).json({ ok: true, ref: order.ref });
};

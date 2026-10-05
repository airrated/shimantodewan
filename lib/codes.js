/* =============================================================================
   Discount codes.

   The codes themselves live in the ORDER_CODES environment variable, never in
   the repository and never in the page, so a buyer cannot read them out of
   the source. Both /api/code and /api/order check against this one list.

     ORDER_CODES          comma separated, e.g. PREORDER20,FRIENDS
     ORDER_CODE_PERCENT   whole number, defaults to 20

   With ORDER_CODES unset every code is rejected and the form still works.
   ========================================================================== */

function percent() {
  const p = parseInt(process.env.ORDER_CODE_PERCENT || "20", 10);
  return Number.isFinite(p) && p > 0 && p <= 90 ? p : 20;
}

// Case and spacing should never be the reason a code fails
function normalise(code) {
  return String(code || "").trim().toUpperCase().replace(/\s+/g, "");
}

function valid(code) {
  const c = normalise(code);
  if (!c) return false;
  const list = String(process.env.ORDER_CODES || "")
    .split(",").map(normalise).filter(Boolean);
  return list.includes(c);
}

module.exports = { percent, normalise, valid };

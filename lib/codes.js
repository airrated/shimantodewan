/* =============================================================================
   Discount codes.

   The codes themselves live in the ORDER_CODES environment variable, never in
   the repository and never in the page, so a buyer cannot read them out of
   the source. Both /api/code and /api/order check against this one list.

     ORDER_CODES    comma separated, e.g. SAKURA30,FRIENDS

   A code does not take a percentage off. It switches the order to the fixed
   code prices set in api/order.js (and mirrored in the pages).

   With ORDER_CODES unset every code is rejected and the form still works.
   ========================================================================== */

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

module.exports = { normalise, valid };

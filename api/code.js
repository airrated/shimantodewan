/* =============================================================================
   POST /api/code   { code }  ->  { valid: false }
                              or  { valid: true, code, kind: "fixed" }
                              or  { valid: true, code, kind: "percent", percent }

   Lets the page show the right total before the buyer commits, without the
   code ever appearing in the page source. `kind` says what sort of discount
   the code is, because they work differently: "fixed" switches to the fixed
   code prices, "percent" takes that much off the books after any bundle.
   /api/order looks the code up again, so a forged response here changes
   nothing.
   ========================================================================== */

const codes = require("../lib/codes");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ valid: false });
  }
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (_) { b = {}; } }
  const offer = codes.lookup((b || {}).code);
  return res.status(200).json(offer ? { valid: true, ...offer } : { valid: false });
};

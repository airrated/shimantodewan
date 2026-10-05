/* =============================================================================
   POST /api/code   { code }  ->  { valid, percent }

   Lets the page show the discount before the buyer commits, without the code
   ever appearing in the page source. /api/order checks the code again, so a
   forged response here changes nothing.
   ========================================================================== */

const codes = require("../lib/codes");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ valid: false, percent: 0 });
  }
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (_) { b = {}; } }
  const ok = codes.valid((b || {}).code);
  return res.status(200).json({ valid: ok, percent: ok ? codes.percent() : 0 });
};

/* =============================================================================
   POST /api/code   { code }  ->  { valid }

   Lets the page show the code prices before the buyer commits, without the
   code ever appearing in the page source. /api/order checks the code again, so
   a forged response here changes nothing. It says only whether the code is
   real; the prices themselves are fixed amounts, not a percentage.
   ========================================================================== */

const codes = require("../lib/codes");

module.exports = async (req, res) => {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ valid: false });
  }
  let b = req.body;
  if (typeof b === "string") { try { b = JSON.parse(b); } catch (_) { b = {}; } }
  return res.status(200).json({ valid: codes.valid((b || {}).code) });
};

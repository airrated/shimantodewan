/* =============================================================================
   Discount codes: one environment variable per code.

     ORDER_CODE_<NAME>   the code is <NAME>, the value says what it does

   Two kinds of value:

     fixed        the fixed code prices set in api/order.js
                  (a single, or all four, at the code price)
     percent:N    N per cent off the books after any bundle, at normal prices;
                  N is a whole number from 1 to 90

   For example:  ORDER_CODE_SAKURA30 = fixed
                 ORDER_CODE_EYES20   = percent:20

   Add a code by adding a variable, retire it by deleting the variable. The
   codes live here in the environment, never in the repository or the page.
   Typed codes are matched without regard to case or spaces. Only one code can
   apply to an order, so they never stack.

   A variable whose value cannot be understood (percent:abc, percent:0, an
   empty value) is treated as if that code did not exist: no discount, no
   crash, and a warning in the function log naming the variable.
   ========================================================================== */

const PREFIX = "ORDER_CODE_";

// Earlier settings that must not be mistaken for a code called PERCENT
const RETIRED = ["ORDER_CODE_PERCENT"];

// Case and spacing should never be the reason a code fails
function normalise(code) {
  return String(code || "").trim().toUpperCase().replace(/\s+/g, "");
}

// A variable's value, understood or not. Returns null when it cannot be.
function parse(value) {
  const v = String(value == null ? "" : value).trim().toLowerCase();
  if (v === "fixed") return { kind: "fixed" };
  const m = /^percent\s*:\s*(\d{1,2})$/.exec(v);
  if (m) {
    const percent = parseInt(m[1], 10);
    if (percent >= 1 && percent <= 90) return { kind: "percent", percent };
  }
  return null;
}

// What a typed code does: { code, kind } or { code, kind: "percent", percent },
// or null when there is no such code (or its variable is malformed)
function lookup(typed) {
  const wanted = normalise(typed);
  if (!wanted) return null;
  for (const key of Object.keys(process.env)) {
    if (!key.toUpperCase().startsWith(PREFIX) || RETIRED.includes(key.toUpperCase())) continue;
    if (normalise(key.slice(PREFIX.length)) !== wanted) continue;
    const def = parse(process.env[key]);
    if (!def) {
      console.warn("Discount code variable " + key + " is malformed (value: "
        + JSON.stringify(String(process.env[key])) + "). Expected 'fixed' or 'percent:N' with N a whole "
        + "number from 1 to 90. The code " + wanted + " is being treated as invalid until it is fixed.");
      return null;
    }
    return { code: wanted, ...def };
  }
  return null;
}

module.exports = { normalise, parse, lookup };

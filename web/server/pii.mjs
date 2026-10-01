// Light detection of Vietnamese personal identifiers (used to warn the user before content is sent).
// Returns only the categories found – never the matched values, which are not logged or stored.
// Keep in sync with client/src/pii.js.
const RULES = [
  // Citizen ID (CCCD): 12 digits.
  ["cccd", /(?<!\d|\d[.,])\d{12}(?!\d|[.,]\d)/],
  // Passport: one letter + 7–8 digits (e.g. C1234567).
  ["passport", /\b[A-Z]\d{7,8}\b/],
  // Bank account next to its label.
  ["bank", /(?:\bSTK\b|số tài khoản|so tai khoan|tài khoản số|\baccount (?:no\.?|number)\b)\s*[:.]?\s*\d(?:[\s.-]?\d){5,19}/iu],
  // Mobile / landline: +84 or 0, then 9 digits (separators allowed).
  ["phone", /(?<![\d])(?:\+84\s?|0)[235789](?:[\s.-]?\d){8}(?!\d)/],
]

/** Categories of personal identifiers found in `text` (e.g. ["cccd", "phone"]). */
export function detectPii(text) {
  const s = String(text || "")
  if (!s) return []
  return RULES.filter(([, re]) => re.test(s)).map(([k]) => k)
}

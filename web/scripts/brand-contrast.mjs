// Checks the WCAG contrast of the LegalAI colour roles (client/src/site/tokens.js). Exit 1 on failure.
import { CONTRAST_PAIRS, ROLES, RED, NEUTRAL, STATUS, contrast } from "../client/src/site/tokens.js"
let bad = 0
const row = (label, fg, bg, min) => {
  const r = contrast(fg, bg)
  const ok = r >= min
  if (!ok) bad++
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(34)} ${fg} on ${bg}  ${r.toFixed(2)}:1 (min ${min})`)
}
for (const [theme, fg, bg, min] of CONTRAST_PAIRS) row(`${theme} ${fg}/${bg}`, ROLES[theme][fg], ROLES[theme][bg], min)
for (const [k, v] of Object.entries(STATUS.light)) row(`light status ${k}/bg`, v, "#FFFFFF", 4.5)
for (const [k, v] of Object.entries(STATUS.dark)) row(`dark status ${k}/bg`, v, "#0F0F0F", 4.5)
if (process.argv.includes("--scale")) {
  for (const [k, v] of Object.entries(RED)) console.log(`red-${k} ${v}  on white ${contrast(v, "#FFFFFF").toFixed(2)}  on #0F0F0F ${contrast(v, "#0F0F0F").toFixed(2)}`)
  for (const [k, v] of Object.entries(NEUTRAL)) console.log(`neutral-${k} ${v}  on white ${contrast(v, "#FFFFFF").toFixed(2)}  on #0F0F0F ${contrast(v, "#0F0F0F").toFixed(2)}`)
}
console.log(bad ? `${bad} pair(s) below AA` : "all pairs meet WCAG AA")
process.exit(bad ? 1 : 0)

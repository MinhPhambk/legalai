// Inline marks for the grounding check: each checked item (quote, figure, amount, document number, link) is found in
// the rendered answer and wrapped – unmatched items get a red wavy underline, matched quotes a small ✓ – so the user
// sees WHERE the answer is not backed by the sources. Pure DOM work on `.md[data-source="answer"]` inside `root`.

const MARK = "gc-mark"
const norm = (s) => String(s || "").normalize("NFC").replace(/[“”„]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, " ")

/** Remove marks added earlier (the answer HTML is re-rendered by React, but keep this idempotent). */
export function clearChecks(root) {
  if (!root) return
  root.querySelectorAll(`span.${MARK}`).forEach((s) => s.replaceWith(...s.childNodes))
  root.querySelectorAll(`a.${MARK}-link`).forEach((a) => {
    a.classList.remove(`${MARK}-link`, "gc-bad", "gc-ok")
    delete a.dataset.gc
    a.removeAttribute("data-gc-tip")
  })
  root.normalize?.()
}

/** The text to look for in the answer: a quote's first words (quotes may be long / contain inline markup). */
function needle(c) {
  let t = norm(c.t).trim()
  if (c.k === "quote") {
    t = t.replace(/^["'«]+|["'»]+$/g, "")
    t = t.split(/\s*(?:…|\.\.\.+)\s*/)[0]
    if (t.length > 48) t = t.slice(0, 48).replace(/\s+\S*$/, "")
  }
  return t.length >= 2 ? t : ""
}

function textNodes(container) {
  const out = []
  const w = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest(`.cite, code, pre, .${MARK}`) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  })
  for (let n = w.nextNode(); n; n = w.nextNode()) out.push(n)
  return out
}

/**
 * Mark the checks in the answer. `tip(c)` returns the tooltip text for a check. Returns the number of items marked.
 * Matched non-quote items are left unmarked (they are listed in the panel); matched quotes get a ✓.
 */
export function markChecks(root, checks, tip) {
  if (!root || !Array.isArray(checks) || !checks.length) return 0
  clearChecks(root)
  const containers = [...root.querySelectorAll('.md[data-source="answer"]')]
  if (!containers.length) return 0
  let marked = 0
  checks.forEach((c, i) => {
    if (c.ok && c.k !== "quote") return
    // a link outside the automatically checkable sources is not an error (the badge does not count it either)
    if (c.why === "unverifiable") return
    if (c.k === "link") {
      for (const box of containers) {
        const a = [...box.querySelectorAll("a[href]")].find((x) => x.href === c.t || x.getAttribute("href") === c.t || x.textContent.trim() === c.t)
        if (a) {
          a.classList.add(`${MARK}-link`, c.ok ? "gc-ok" : "gc-bad")
          a.dataset.gc = String(i)
          a.setAttribute("data-gc-tip", tip(c))
          marked++
          return
        }
      }
      return
    }
    const want = needle(c)
    if (!want) return
    const lower = want.toLocaleLowerCase("vi")
    for (const box of containers) {
      for (const node of textNodes(box)) {
        const hay = norm(node.nodeValue).toLocaleLowerCase("vi")
        const at = hay.indexOf(lower)
        if (at < 0) continue
        // map the position in the whitespace-collapsed text back to the raw text node
        const raw = node.nodeValue
        let r = 0, n = 0
        while (r < raw.length && n < at) { if (!(/\s/.test(raw[r]) && /\s/.test(raw[r + 1] || ""))) n++; r++ }
        let end = r, m = 0
        while (end < raw.length && m < want.length) { if (!(/\s/.test(raw[end]) && /\s/.test(raw[end + 1] || ""))) m++; end++ }
        const range = document.createRange()
        range.setStart(node, r)
        range.setEnd(node, end)
        const span = document.createElement("span")
        span.className = `${MARK} ${c.ok ? "gc-ok" : "gc-bad"}`
        span.dataset.gc = String(i)
        span.setAttribute("data-gc-tip", tip(c))
        span.tabIndex = 0
        try { range.surroundContents(span) } catch { continue }
        marked++
        return
      }
    }
  })
  return marked
}

/** Scroll to the mark of check `i` and flash it. */
export function revealCheck(root, i) {
  const el = root?.querySelector(`[data-gc="${i}"]`)
  if (!el) return false
  el.scrollIntoView({ behavior: "smooth", block: "center" })
  el.classList.remove("gc-flash")
  void el.offsetWidth
  el.classList.add("gc-flash")
  return true
}

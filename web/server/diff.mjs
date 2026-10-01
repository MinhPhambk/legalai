// Word-level diff of two markdown texts (pure JS, no dependencies).
// Two passes keep it fast on long contracts: Myers O(ND) over lines, then Myers over word tokens
// inside each changed hunk. Output: [{ op: "eq" | "ins" | "del", text }] with adjacent ops merged.

/** Myers shortest edit script between int arrays a and b; null when more than maxD edits are needed. */
function myers(a, b, maxD) {
  const n = a.length
  const m = b.length
  const max = n + m
  const off = max + 1
  const V = new Int32Array(2 * max + 3)
  const trace = []
  let found = -1
  outer: for (let d = 0; d <= Math.min(max, maxD); d++) {
    trace.push(V.slice(off - d - 1, off + d + 2)) // values from step d-1 for k in [-d-1, d+1]
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && V[off + k - 1] < V[off + k + 1]) ? V[off + k + 1] : V[off + k - 1] + 1
      let y = x - k
      while (x < n && y < m && a[x] === b[y]) x++, y++
      V[off + k] = x
      if (x >= n && y >= m) {
        found = d
        break outer
      }
    }
  }
  if (found < 0) return null
  // Backtrack: ops in reverse, as ["eq"|"del"|"ins", index].
  const ops = []
  let x = n
  let y = m
  for (let d = found; d >= 0; d--) {
    const snap = trace[d]
    const get = (k) => snap[k + d + 1]
    const k = x - y
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1
    const prevX = get(prevK)
    const prevY = prevX - prevK
    while (x > prevX && y > prevY) ops.push(["eq", --x, --y])
    if (d > 0) {
      if (x === prevX) ops.push(["ins", x, --y])
      else ops.push(["del", --x, y])
    }
    x = prevX
    y = prevY
  }
  return ops.reverse()
}

const intern = (lists) => {
  const ids = new Map()
  return lists.map((l) => Int32Array.from(l, (s) => {
    let id = ids.get(s)
    if (id === undefined) ids.set(s, (id = ids.size))
    return id
  }))
}

const splitLines = (s) => (s ? s.match(/[^\n]*\n|[^\n]+$/g) || [] : [])
const splitWords = (s) => s.match(/\s+|[\p{L}\p{N}_]+|[^\s\p{L}\p{N}_]/gu) || []

function push(out, op, text) {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.op === op) last.text += text
  else out.push({ op, text })
}

/** Word diff of one changed hunk (old text → new text). */
function wordDiff(oldText, newText, out) {
  const a = splitWords(oldText)
  const b = splitWords(newText)
  const ops = a.length + b.length <= 20000 ? (() => {
    const [ia, ib] = intern([a, b])
    return myers(ia, ib, 2500)
  })() : null
  if (!ops) {
    push(out, "del", oldText)
    push(out, "ins", newText)
    return
  }
  // Collect raw segments, then fold whitespace-only equal runs between changes into the change
  // (otherwise a rewritten sentence reads as word/space/word confetti).
  const seg = []
  for (const [op, i, j] of ops) {
    const t = op === "ins" ? b[j] : a[i]
    const last = seg[seg.length - 1]
    if (last && last.op === op) last.text += t
    else seg.push({ op, text: t })
  }
  for (let i = 1; i < seg.length - 1; i++) {
    const s = seg[i]
    if (s.op === "eq" && /^\s+$/.test(s.text) && seg[i - 1].op !== "eq" && seg[i + 1].op !== "eq") s.op = "both"
  }
  // Within each run of changes emit all deletions first, then all insertions.
  let del = ""
  let ins = ""
  const flush = () => {
    push(out, "del", del)
    push(out, "ins", ins)
    del = ins = ""
  }
  for (const s of seg) {
    if (s.op === "eq") {
      flush()
      push(out, "eq", s.text)
    } else if (s.op === "del") del += s.text
    else if (s.op === "ins") ins += s.text
    else {
      del += s.text
      ins += s.text
    }
  }
  flush()
}

/** Diff two texts → { ops, stats: { insertedWords, deletedWords, changes } }. */
export function diffText(oldText, newText) {
  oldText = String(oldText || "").replace(/\r\n?/g, "\n")
  newText = String(newText || "").replace(/\r\n?/g, "\n")
  const A = splitLines(oldText)
  const B = splitLines(newText)
  const [ia, ib] = intern([A, B])
  const lineOps = myers(ia, ib, 3000)
  const out = []
  if (!lineOps) wordDiff(oldText, newText, out)
  else {
    let dels = ""
    let inss = ""
    const flush = () => {
      if (dels && inss) wordDiff(dels, inss, out)
      else {
        push(out, "del", dels)
        push(out, "ins", inss)
      }
      dels = inss = ""
    }
    for (const [op, i, j] of lineOps) {
      if (op === "eq") {
        flush()
        push(out, "eq", A[i])
      } else if (op === "del") dels += A[i]
      else inss += B[j]
    }
    flush()
  }
  const words = (s) => (s.match(/[\p{L}\p{N}_]+/gu) || []).length
  const stats = { insertedWords: 0, deletedWords: 0, changes: 0 }
  let inChange = false
  for (const o of out) {
    if (o.op === "ins") stats.insertedWords += words(o.text)
    if (o.op === "del") stats.deletedWords += words(o.text)
    if (o.op !== "eq" && !inChange) stats.changes++
    inChange = o.op !== "eq"
  }
  return { ops: out, stats }
}

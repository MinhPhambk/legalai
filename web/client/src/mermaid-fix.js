// Best-effort repair of model-written mermaid flowcharts that fail to parse. The usual mistakes:
//   A[Bắt đầu\n(Vi phạm, chậm thực hiện)]   – "(" / ")" / "{" inside an unquoted label starts another node shape
//   B{Có thỏa thuận?\nTheo hợp đồng?}       – literal "\n" instead of <br/>
// Fix: quote every unquoted node label (A["…"], B{"…"} – mermaid's escape for special characters), turn "\n" into
// <br/> and " inside a label into #quot;. Only flowchart / graph diagrams; anything else is returned unchanged.
// Used only after the original code failed to parse (components/Visuals.jsx).

const SKIP = /^\s*(?:%%|flowchart\b|graph\b|subgraph\b|end\b|classDef\b|class\b|style\b|linkStyle\b|click\b|direction\b)/
// Node shapes, longest opener first: [[ ]] [( )] ([ ]) (( )) {{ }} [/ /] [\ \] [ ] { } ( )
const SHAPES = [
  ["[[", "]]"], ["[(", ")]"], ["([", "])"], ["((", "))"], ["{{", "}}"], ["[/", "/]"], ["[\\", "\\]"], ["[", "]"], ["{", "}"], ["(", ")"],
]
// A node definition: id + opener (the id follows start of line, a separator or an arrow end).
const NODE_START = /(^|[\s;&>|])([A-Za-z_][\w-]*)\s*(\[\[|\[\(|\(\[|\(\(|\{\{|\[\/|\[\\|\[|\{|\()/g
// What may follow a node's closing bracket: end, an edge, "&", ";", ":::class".
const AFTER_CLOSE = /^\s*(?:$|-|=|\.|&|;|:::|~)/

const quoteLabel = (s) => `"${s.trim().replace(/\\n/g, "<br/>").replace(/"/g, "#quot;")}"`

function fixLine(line) {
  if (SKIP.test(line)) return line
  let out = ""
  let pos = 0
  NODE_START.lastIndex = 0
  for (let m; (m = NODE_START.exec(line)); ) {
    const open = m[3]
    const start = m.index + m[1].length + m[2].length + (m[0].length - m[1].length - m[2].length - open.length) + open.length
    if (start < pos) continue
    const close = SHAPES.find(([o]) => o === open)[1]
    // first closing token that is followed by an edge / end of line (labels may contain the other bracket kinds)
    let end = -1
    for (let i = line.indexOf(close, start); i >= 0; i = line.indexOf(close, i + 1)) {
      if (AFTER_CLOSE.test(line.slice(i + close.length))) { end = i; break }
    }
    if (end < 0) continue
    const label = line.slice(start, end)
    const quoted = /^\s*".*"\s*$/s.test(label) || label.trim().startsWith("`")
    out += line.slice(pos, start) + (quoted ? label.replace(/\\n/g, "<br/>") : quoteLabel(label)) + close
    pos = end + close.length
    NODE_START.lastIndex = pos
  }
  return out + line.slice(pos)
}

/** Repaired code, or null when nothing could be changed (not a flowchart, or already clean). */
export function repairMermaid(code) {
  const src = String(code || "")
  if (!/^\s*(?:%%[^\n]*\n\s*)*(?:flowchart|graph)\b/i.test(src)) return null
  const fixed = src.split("\n").map(fixLine).join("\n")
  return fixed === src ? null : fixed
}

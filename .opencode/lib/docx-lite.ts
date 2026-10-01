// Minimal .docx reader (no dependencies): unzip word/document.xml with node:zlib and return the body as an
// ordered list of paragraphs and tables (cells with gridSpan expanded, vertical-merge continuations marked),
// so official annex tables (e.g. the tariff schedules attached to Vietnamese decrees on vbpl.vn) can be
// indexed verbatim. Imported by tool files only – this file exports no tools.
import zlib from "node:zlib"

export type Cell = { text: string; span: number; vmerge: boolean }
export type Block = { kind: "p"; text: string } | { kind: "table"; rows: Cell[][] }

/** Entries of a zip archive whose name matches `want`, decompressed to UTF-8 text. */
export function unzipText(buf: Buffer, want: RegExp): Record<string, string> {
  const sig = Buffer.from([0x50, 0x4b, 0x05, 0x06])
  const eocd = buf.lastIndexOf(sig)
  if (eocd < 0) throw new Error("tệp không phải định dạng zip/docx")
  const n = buf.readUInt16LE(eocd + 10)
  let p = buf.readUInt32LE(eocd + 16)
  const out: Record<string, string> = {}
  for (let i = 0; i < n; i++) {
    if (buf.readUInt32LE(p) !== 0x02014b50) break
    const method = buf.readUInt16LE(p + 10), csize = buf.readUInt32LE(p + 20)
    const nl = buf.readUInt16LE(p + 28), el = buf.readUInt16LE(p + 30), cl = buf.readUInt16LE(p + 32), lho = buf.readUInt32LE(p + 42)
    const name = buf.toString("utf8", p + 46, p + 46 + nl)
    p += 46 + nl + el + cl
    if (!want.test(name)) continue
    const start = lho + 30 + buf.readUInt16LE(lho + 26) + buf.readUInt16LE(lho + 28)
    const data = buf.subarray(start, start + csize)
    out[name] = (method === 8 ? zlib.inflateRawSync(data) : data).toString("utf8")
  }
  return out
}

const decode = (s: string) => s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d))).replace(/&amp;/g, "&")
const paraText = (xml: string) =>
  [...xml.matchAll(/<w:t(?: [^>]*)?>([^<]*)<\/w:t>|<w:tab\/>|<w:br\/>/g)].map((m) => (m[1] !== undefined ? decode(m[1]) : " ")).join("")

function tableRows(tbl: string): Cell[][] {
  const rows: Cell[][] = []
  for (const tr of tbl.matchAll(/<w:tr[ >][\s\S]*?<\/w:tr>/g)) {
    const cells: Cell[] = []
    for (const tc of tr[0].matchAll(/<w:tc(?: [^>]*)?>[\s\S]*?<\/w:tc>/g)) {
      const x = tc[0]
      const span = Number(x.match(/<w:gridSpan w:val="(\d+)"/)?.[1] ?? 1)
      const vmerge = /<w:vMerge\/>|<w:vMerge w:val="continue"\/>/.test(x)
      const text = [...x.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((pp) => paraText(pp[0])).join("\n").replace(/[ \t ]+/g, " ").trim()
      cells.push({ text, span, vmerge })
    }
    rows.push(cells)
  }
  return rows
}

/** Body of a .docx as ordered blocks. Nested tables are flattened into their parent cell text. */
export function docxBlocks(buf: Buffer): Block[] {
  const xml = unzipText(buf, /^word\/document\.xml$/)["word/document.xml"]
  if (!xml) throw new Error("tệp docx không có word/document.xml")
  const body = xml.slice(xml.indexOf("<w:body"), xml.lastIndexOf("</w:body>"))
  const blocks: Block[] = []
  // top-level tables: find <w:tbl> … matching </w:tbl> (tables may nest)
  let i = 0
  const re = /<w:tbl>|<w:tbl |<w:p[ >]/g
  while (i < body.length) {
    re.lastIndex = i
    const m = re.exec(body)
    if (!m) break
    if (m[0].startsWith("<w:tbl")) {
      let depth = 0, j = m.index
      const tre = /<w:tbl[ >]|<\/w:tbl>/g
      tre.lastIndex = j
      let end = body.length
      for (let t = tre.exec(body); t; t = tre.exec(body)) {
        if (t[0] === "</w:tbl>") { if (--depth === 0) { end = t.index + 8; break } } else depth++
      }
      blocks.push({ kind: "table", rows: tableRows(body.slice(m.index, end)) })
      i = end
    } else {
      const tagEnd = body.indexOf(">", m.index)
      if (body[tagEnd - 1] === "/") { i = tagEnd + 1; continue } // empty paragraph <w:p …/>
      const end = body.indexOf("</w:p>", m.index)
      const e = end < 0 ? body.length : end + 6
      const text = paraText(body.slice(m.index, e)).replace(/[ \t ]+/g, " ").trim()
      if (text) blocks.push({ kind: "p", text })
      i = e
    }
  }
  return blocks
}

/** Row cells with gridSpan expanded to grid columns (the text is repeated in each spanned column). */
export const expandRow = (row: Cell[]) => row.flatMap((c) => Array.from({ length: Math.max(1, c.span) }, () => c))

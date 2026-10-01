// Export a markdown report as .docx (the `docx` library, loaded on demand) or as PDF via the browser's
// print dialog with a dedicated print stylesheet (keeps Vietnamese text selectable, no font embedding).
import { marked } from "marked"
import { downloadBlob, legalStatus, slugify, sourceAccessed } from "./lib.js"
import { fmtDate, t } from "./i18n.jsx"

const decode = (s) => {
  const t = document.createElement("textarea")
  t.innerHTML = s
  return t.value
}

/** Inline markdown tokens → docx TextRun / ExternalHyperlink list. */
function inlineRuns(D, tokens = [], style = {}) {
  const out = []
  for (const tk of tokens) {
    switch (tk.type) {
      case "strong":
        out.push(...inlineRuns(D, tk.tokens, { ...style, bold: true }))
        break
      case "em":
        out.push(...inlineRuns(D, tk.tokens, { ...style, italics: true }))
        break
      case "del":
        out.push(...inlineRuns(D, tk.tokens, { ...style, strike: true }))
        break
      case "codespan":
        out.push(new D.TextRun({ text: decode(tk.text), font: "Consolas", ...style }))
        break
      case "br":
        out.push(new D.TextRun({ text: "", break: 1 }))
        break
      case "link":
        out.push(
          new D.ExternalHyperlink({
            link: tk.href,
            children: [new D.TextRun({ text: decode(tk.text || tk.href), style: "Hyperlink", ...style })],
          }),
        )
        break
      case "text":
      case "escape":
        if (tk.tokens?.length) out.push(...inlineRuns(D, tk.tokens, style))
        else out.push(new D.TextRun({ text: decode(tk.text), ...style }))
        break
      default:
        if (tk.text) out.push(new D.TextRun({ text: decode(tk.text), ...style }))
    }
  }
  return out
}

function blocks(D, tokens, ctx = { level: 0 }) {
  const out = []
  const HEAD = [D.HeadingLevel.HEADING_1, D.HeadingLevel.HEADING_2, D.HeadingLevel.HEADING_3, D.HeadingLevel.HEADING_4]
  for (const tk of tokens) {
    switch (tk.type) {
      case "heading":
        out.push(new D.Paragraph({ heading: HEAD[Math.min(tk.depth, 4) - 1], children: inlineRuns(D, tk.tokens), spacing: { before: 240, after: 120 } }))
        break
      case "paragraph":
        out.push(new D.Paragraph({ children: inlineRuns(D, tk.tokens, ctx.quote ? { italics: true } : {}), spacing: { after: 120 }, indent: ctx.quote ? { left: 480 } : undefined }))
        break
      case "blockquote":
        out.push(...blocks(D, tk.tokens, { ...ctx, quote: true }))
        break
      case "list":
        tk.items.forEach((item, i) => {
          const [first, ...rest] = item.tokens
          const runs = first && (first.type === "text" || first.type === "paragraph") ? inlineRuns(D, first.tokens || [first]) : []
          out.push(
            new D.Paragraph({
              children: tk.ordered ? [new D.TextRun({ text: `${(tk.start || 1) + i}. ` }), ...runs] : runs,
              bullet: tk.ordered ? undefined : { level: Math.min(ctx.level, 3) },
              indent: tk.ordered ? { left: 360 + ctx.level * 360, hanging: 360 } : undefined,
              spacing: { after: 60 },
            }),
          )
          const restBlocks = first && first.type !== "text" && first.type !== "paragraph" ? item.tokens : rest
          out.push(...blocks(D, restBlocks, { ...ctx, level: ctx.level + 1 }))
        })
        break
      case "table": {
        const cell = (c, header) =>
          new D.TableCell({
            children: [new D.Paragraph({ children: inlineRuns(D, c.tokens, header ? { bold: true } : {}) })],
            shading: header ? { fill: "EEEEEE", type: D.ShadingType.CLEAR, color: "auto" } : undefined,
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
          })
        out.push(
          new D.Table({
            width: { size: 100, type: D.WidthType.PERCENTAGE },
            rows: [new D.TableRow({ tableHeader: true, children: tk.header.map((c) => cell(c, true)) }), ...tk.rows.map((r) => new D.TableRow({ children: r.map((c) => cell(c, false)) }))],
          }),
          new D.Paragraph({ text: "" }),
        )
        break
      }
      case "code":
        for (const l of tk.text.split("\n")) out.push(new D.Paragraph({ children: [new D.TextRun({ text: l, font: "Consolas", size: 20 })] }))
        break
      case "hr":
        out.push(new D.Paragraph({ border: { bottom: { color: "999999", space: 1, style: D.BorderStyle.SINGLE, size: 6 } }, text: "" }))
        break
      case "space":
        break
      default:
        if (tk.text) out.push(new D.Paragraph({ text: decode(tk.text) }))
    }
  }
  return out
}

export async function exportDocx(title, markdown, sources = []) {
  const D = await import("docx")
  const tokens = marked.lexer(markdown)
  const children = [
    new D.Paragraph({ children: [new D.TextRun({ text: `LegalAI · ${t("report.exportedOn", { date: fmtDate(Date.now()) })}`, color: "777777", size: 18 })], spacing: { after: 200 } }),
    ...blocks(D, tokens),
  ]
  if (sources.length) {
    children.push(new D.Paragraph({ heading: D.HeadingLevel.HEADING_2, text: t("sources.title"), spacing: { before: 300, after: 120 } }))
    for (const s of sources)
      children.push(
        new D.Paragraph({
          children: [
            new D.TextRun({ text: `[${s.n}] `, bold: true }),
            new D.TextRun({ text: [s.title || s.label || s.url, s.number, legalStatus(s)].filter(Boolean).join(" · ") + " – " }),
            new D.ExternalHyperlink({ link: s.url, children: [new D.TextRun({ text: s.url, style: "Hyperlink" })] }),
            ...(s.accessed ? [new D.TextRun({ text: ` (${t("sources.accessedOn", { date: sourceAccessed(s) })})`, color: "777777" })] : []),
          ],
          spacing: { after: 60 },
        }),
      )
  }
  children.push(new D.Paragraph({ children: [new D.TextRun({ text: t("report.footer"), italics: true, color: "777777", size: 18 })], spacing: { before: 300 } }))
  const doc = new D.Document({
    creator: "LegalAI",
    title,
    styles: {
      default: { document: { run: { font: "Times New Roman", size: 26 } } },
      paragraphStyles: [{ id: "Hyperlink", name: "Hyperlink", run: { color: "000000", underline: {} } }],
    },
    sections: [{ properties: { page: { margin: { top: 1134, bottom: 1134, left: 1418, right: 1134 } } }, children }],
  })
  const blob = await D.Packer.toBlob(doc)
  downloadBlob(blob, `${slugify(title)}.docx`)
}

/** Print only the report (user picks "Save as PDF" in the print dialog). */
export function printReport(title, html, sourcesHtml = "") {
  document.getElementById("print-root")?.remove()
  const root = document.createElement("div")
  root.id = "print-root"
  const head = document.createElement("header")
  head.className = "print-head"
  head.textContent = `LegalAI · ${fmtDate(Date.now())}`
  const body = document.createElement("article")
  body.className = "md print-md"
  body.innerHTML = html + sourcesHtml // already sanitized by DOMPurify
  const foot = document.createElement("footer")
  foot.className = "print-foot"
  foot.textContent = t("report.footer")
  root.append(head, body, foot)
  document.body.appendChild(root)
  document.body.classList.add("printing-report")
  const prevTitle = document.title
  document.title = title // default PDF file name
  const done = () => {
    document.body.classList.remove("printing-report")
    root.remove()
    document.title = prevTitle
    window.removeEventListener("afterprint", done)
  }
  window.addEventListener("afterprint", done)
  setTimeout(() => window.print(), 50)
}

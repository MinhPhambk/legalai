// "OCR" badge: the text was recognised from a scanned PDF (Chrome built-in OCR, server side) – it may contain
// wrong diacritics / letters, so quotes must be checked against the original. Used on upload chips, attachment
// pills, document cards, tool steps and result cards.
import { useT } from "../i18n.jsx"

/** Pages part: "2/5 pages" (n of total) or "2 pages". */
export function ocrPagesText(t, n, total) {
  if (!n) return ""
  return total && total > n ? t("ocr.pagesOf", { n, total }) : t("ocr.pages", { count: n })
}

/**
 * n = pages recognised (or pass `pages`, the page numbers), total = pages in the PDF (optional).
 * kind "file" (upload / attachment, default) | "source" (a tool read a scanned source document).
 */
export function OcrBadge({ n, total, pages, kind = "file", className = "" }) {
  const t = useT()
  const count = n ?? (Array.isArray(pages) ? pages.length : 0)
  const pagesText = ocrPagesText(t, count, total)
  const tip = t(kind === "source" ? "ocr.sourceTip" : "ocr.tip")
  const title = pagesText ? `${tip} (${pagesText})` : tip
  return (
    <span className={`ocr-badge ${className}`} title={title}>
      <span className="ocr-tag" aria-hidden="true">
        {t("ocr.badge")}
      </span>
      {pagesText && (
        <span className="ocr-pages" aria-hidden="true">
          {pagesText}
        </span>
      )}
      <span className="sr-only">{title}</span>
    </span>
  )
}

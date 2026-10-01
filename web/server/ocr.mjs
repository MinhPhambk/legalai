// Uploads whose text was recognised by OCR from a scanned PDF (server/extract.mjs → ../.opencode/lib/pdf-ocr.ts).
// uploads.ocr = JSON { engine, pages: [n…], totalPages }. Such text is NOT verbatim source text: the attachment
// header / cards say so, the imported document carries meta.ocr, and the session evidence gets an entry with
// meta.ocr = true (same shape as pdf-ocr.ts ocrMeta(), which grounding_check reads).
import fs from "node:fs"
import path from "node:path"
import { EVIDENCE_DIR } from "./experts.mjs"

// Same wording as OCR_WARNING in ../.opencode/lib/pdf-ocr.ts (kept here so the server does not load the module for it).
export const OCR_WARNING = "⚠ Nội dung lấy bằng nhận dạng chữ (OCR) từ bản scan – có thể sai dấu/chữ; trích dẫn nguyên văn phải đối chiếu bản gốc; độ tin cậy tối đa TRUNG BÌNH."

/** uploads row → { engine, pages, totalPages } or null. */
export function uploadOcr(u) {
  if (!u?.ocr) return null
  try {
    const o = JSON.parse(u.ocr)
    const pages = Array.isArray(o?.pages) ? o.pages.filter((n) => Number.isInteger(n) && n > 0) : []
    if (!pages.length) return null
    return { engine: typeof o.engine === "string" ? o.engine.slice(0, 40) : "", pages, totalPages: Number.isInteger(o.totalPages) && o.totalPages > 0 ? o.totalPages : pages.length }
  } catch {
    return null
  }
}

const evidenceFile = (sid) => path.join(EVIDENCE_DIR, `${String(sid).replace(/[^\w.-]/g, "_")}.jsonl`)

/**
 * Evidence entry of an OCR'd upload in the session (artifact://<id> when imported, else upload://<uploadId>), source
 * "artifact" like every imported upload, meta.ocr = true. Written once per (session, url). Never throws.
 */
export function recordUploadOcrEvidence(sid, u, text, ocr, artifactId) {
  if (!sid || !text || !ocr) return false
  const url = artifactId ? `artifact://${artifactId}` : `upload://${u.id}`
  try {
    const file = evidenceFile(sid)
    let prev = ""
    try {
      prev = fs.readFileSync(file, "utf8")
    } catch {}
    const tag = `"url":${JSON.stringify(url)}`
    if (prev.split("\n").some((l) => l.includes(tag) && l.includes('"ocr":true'))) return false
    const entry = {
      url,
      title: u.name,
      text: String(text).slice(0, 400_000),
      source: "artifact",
      meta: { ocr: true, engine: ocr.engine, ocr_pages: ocr.pages, total_pages: ocr.totalPages, warning: OCR_WARNING, origin: "upload", upload_id: u.id, ...(artifactId ? { id: artifactId } : {}), sessionID: sid },
      at: Date.now(),
    }
    fs.mkdirSync(EVIDENCE_DIR, { recursive: true })
    fs.appendFileSync(file, JSON.stringify(entry) + "\n")
    return true
  } catch (e) {
    console.warn("[ocr] evidence not recorded:", String(e.message).slice(0, 160))
    return false
  }
}

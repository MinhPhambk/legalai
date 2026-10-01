// Central configuration. Everything the web app writes lives under nd45-platform/.sandbox/web.
import path from "node:path"
import fs from "node:fs"
import { fileURLToPath } from "node:url"

const here = path.dirname(fileURLToPath(import.meta.url))
export const WEB_DIR = path.resolve(here, "..")
export const ROOT = path.resolve(WEB_DIR, "..") // nd45-platform
export const DATA_DIR = path.join(ROOT, ".sandbox", "web")
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads")
export const DB_PATH = process.env.WEB_DB_PATH || path.join(DATA_DIR, "app.db")
export const CLIENT_DIST = path.join(WEB_DIR, "client", "dist")

fs.mkdirSync(UPLOAD_DIR, { recursive: true })

const bool = (v, dflt) => (v == null || v === "" ? dflt : !/^(0|false|no|off)$/i.test(String(v).trim()))

export const config = {
  host: "127.0.0.1", // never bind anything else; exposure is done by an external tunnel
  port: Number(process.env.PORT || 3000),
  allowRegistration: bool(process.env.ALLOW_REGISTRATION, true),
  // Use an already-running opencode server instead of spawning one (dev only).
  opencodeUrl: process.env.OPENCODE_URL || "",
  opencodePassword: process.env.OPENCODE_SERVER_PASSWORD || "",
  opencodePort: Number(process.env.OPENCODE_PORT || 0), // 0 = pick a free port
  agent: process.env.OPENCODE_AGENT || "legal-web", // file-less agent: web chats share one working dir
  // Override cloud detection of the active model: "true" | "false" | "" (auto)
  modelCloud: process.env.WEB_MODEL_CLOUD || "",
  sessionDays: 30,
  maxUploadBytes: 10 * 1024 * 1024,
  maxExtractChars: 60_000,
  maxPromptAttachmentChars: 150_000,
  maxAttachmentsPerMessage: 5,
  maxMessageChars: 20_000,
  maxTitleChars: 120,
  uploadExtensions: [".docx", ".pdf", ".txt", ".md"],
  // Interactive clarifying questions (agent "question" tool + question cards in the UI). WEB_QUESTION_TOOL=0 turns
  // it off (serve then starts without the tool and any question is rejected at once).
  questionTool: bool(process.env.WEB_QUESTION_TOOL, true),
  // Assisted browsing on official sites (the user passes a CAPTCHA in a live view of the official page, the tool
  // continues): serve starts with ND45_ASSIST=1 so company_lookup / company_verify ask by default. WEB_ASSIST=0 → off.
  assist: bool(process.env.WEB_ASSIST, true),
}

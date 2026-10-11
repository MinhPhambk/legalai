// Thin JSON client for the backend. Session cookie is httpOnly; nothing secret lives here.
// Every request carries the UI language (X-UI-Locale + Accept-Language) so API errors come back localized.
import { getLocale, t } from "./i18n.jsx"
import { DELETE_ALL_TOKEN } from "./codes.js"

const localeHeaders = () => ({ "X-UI-Locale": getLocale(), "Accept-Language": getLocale() })

export class ApiError extends Error {
  constructor(message, status, code) {
    super(message)
    this.status = status
    this.code = code
  }
}

// Other parts of the UI listen to these to show the offline / maintenance banners.
const emit = (name, detail) => window.dispatchEvent(new CustomEvent(name, { detail }))

async function request(method, url, body, { quiet401 = false } = {}) {
  let res
  try {
    res = await fetch(url, {
      method,
      credentials: "same-origin",
      headers: body !== undefined ? { ...localeHeaders(), "Content-Type": "application/json" } : localeHeaders(),
      body: body !== undefined ? JSON.stringify(body) : undefined,
    })
  } catch {
    emit("net:down")
    throw new ApiError(t("errors.offline"), 0, "offline")
  }
  emit("net:up")
  let data = null
  try {
    data = await res.json()
  } catch {}
  if (!res.ok) {
    if (res.status === 401 && !quiet401 && !url.startsWith("/api/auth/")) emit("auth:expired")
    if (data?.code === "agent_down") emit("agent:down")
    throw new ApiError(data?.error || t("errors.generic"), res.status, data?.code || data?.state)
  }
  return data
}

const enc = encodeURIComponent

export const api = {
  health: () => request("GET", "/api/health"),
  meta: () => request("GET", "/api/meta"),
  me: () => request("GET", "/api/me"),
  login: (email, password) => request("POST", "/api/auth/login", { email, password }),
  register: (email, password) => request("POST", "/api/auth/register", { email, password }),
  logout: () => request("POST", "/api/auth/logout"),

  /** One page of the chat list (newest first; the first page also returns all pinned chats). */
  chats: (cursor, limit = 15) => request("GET", `/api/chats?limit=${limit}${cursor ? `&cursor=${enc(cursor)}` : ""}`),
  chat: (id) => request("GET", `/api/chats/${enc(id)}`),
  /** Creates the chat and sends its first prompt in one request. */
  createChat: (text, attachmentIds) => request("POST", "/api/chats", { text, attachmentIds }),
  updateChat: (id, patch) => request("PATCH", `/api/chats/${enc(id)}`, patch),
  deleteChat: (id) => request("DELETE", `/api/chats/${enc(id)}`),
  deleteAllChats: () => request("POST", "/api/chats/delete-all", { confirm: DELETE_ALL_TOKEN }),
  /** History page: the latest 20 turns, or `turns` turns before `beforeTurn` (older pages). */
  messages: (id, beforeTurn, turns) =>
    request("GET", `/api/chats/${enc(id)}/messages${beforeTurn != null ? `?beforeTurn=${beforeTurn}${turns ? `&turns=${turns}` : ""}` : ""}`),
  send: (id, text, attachmentIds) => request("POST", `/api/chats/${enc(id)}/messages`, { text, attachmentIds }),
  editMessage: (id, turn, text) => request("POST", `/api/chats/${enc(id)}/messages`, { editTurn: turn, text }),
  regenerate: (id, turn) => request("POST", `/api/chats/${enc(id)}/messages`, { regenerate: true, editTurn: turn }),
  switchBranch: (id, branchId) => request("POST", `/api/chats/${enc(id)}/switch`, { branchId }),
  abort: (id) => request("POST", `/api/chats/${enc(id)}/abort`),
  replyQuestion: (id, qid, answers) => request("POST", `/api/chats/${enc(id)}/questions/${enc(qid)}/reply`, { answers }),
  rejectQuestion: (id, qid) => request("POST", `/api/chats/${enc(id)}/questions/${enc(qid)}/reject`, {}),
  /** Assisted browsing on an official site (server/assist.mjs): recent requests of the chat, cancel one. */
  assists: (id) => request("GET", `/api/chats/${enc(id)}/assist`),
  cancelAssist: (id, aid) => request("POST", `/api/chats/${enc(id)}/assist/${enc(aid)}/cancel`, {}),
  reloadAssist: (id, aid) => request("POST", `/api/chats/${enc(id)}/assist/${enc(aid)}/reload`, {}),
  search: (q, cursor) => request("GET", `/api/search?q=${enc(q)}${cursor ? `&cursor=${enc(cursor)}` : ""}`),

  getShare: (id) => request("GET", `/api/chats/${enc(id)}/share`),
  createShare: (id) => request("POST", `/api/chats/${enc(id)}/share`),
  shares: (cursor) => request("GET", `/api/shares${cursor ? `?cursor=${enc(cursor)}` : ""}`),
  revokeShare: (token) => request("DELETE", `/api/shares/${enc(token)}`),
  publicShare: (token) => request("GET", `/api/public/shares/${enc(token)}`, undefined, { quiet401: true }),

  account: () => request("GET", "/api/account"),
  updateAccount: (patch) => request("PATCH", "/api/account", patch),
  saveSettings: (s) => request("PUT", "/api/account/settings", s),
  /** "Tự tra lại khi độ tin cậy thấp" (403 while the admin does not allow repairs). */
  setAutoRepair: (enabled) => request("PUT", "/api/account/auto-repair", { enabled }),
  /** "Tra lại ngay": one repair run for the latest THẤP answer of the chat. */
  repair: (id, turn) => request("POST", `/api/chats/${enc(id)}/repair`, { turn }),
  /** Persist the UI language for the signed-in user (also used for the agent's answer language). */
  saveLocale: (locale) => request("PUT", "/api/account/settings", { locale }),
  changePassword: (current, next) => request("POST", "/api/account/password", { current, next }),
  logoutOthers: () => request("POST", "/api/account/logout-others"),
  deleteAccount: (email, password) => request("POST", "/api/account/delete", { email, password }),
  exportUrl: (format) => `/api/export?format=${format}`,

  escalate: (id, body) => request("POST", `/api/chats/${enc(id)}/escalate`, body),
  myEscalations: () => request("GET", "/api/escalations"),
  notifications: () => request("GET", "/api/notifications"),
  expert: {
    list: (params = {}) => request("GET", `/api/expert/escalations?${new URLSearchParams(params)}`),
    get: (id) => request("GET", `/api/expert/escalations/${enc(id)}`),
    claim: (id) => request("POST", `/api/expert/escalations/${enc(id)}/claim`),
    update: (id, patch) => request("PATCH", `/api/expert/escalations/${enc(id)}`, patch),
    reply: (id, text) => request("POST", `/api/expert/escalations/${enc(id)}/replies`, { text }),
    seen: () => request("POST", "/api/expert/seen"),
  },
  /** URL builders for generated documents (owner chat or public share). */
  artifactUrls: (scope, artifactId) => {
    const base = scope.token ? `/api/public/shares/${enc(scope.token)}/artifacts/${enc(artifactId)}` : `/api/artifacts/${enc(scope.chatId)}/${enc(artifactId)}`
    return { preview: `${base}/preview`, download: (fmt) => `${base}/download/${fmt}`, versions: `${base}/versions`, diff: (against) => `${base}/diff${against ? `?against=${enc(against)}` : ""}` }
  },
  // Visuals (diagrams / images / snapshots made by the agent) – server/visuals.mjs, same owner / share scoping as artifacts.
  visualUrls: (scope, id) => {
    const base = scope?.token ? `/api/public/shares/${enc(scope.token)}/visuals/${enc(id)}` : `/api/visuals/${enc(scope?.chatId || "")}/${enc(id)}`
    return {
      meta: `${base}/meta`,
      image: (theme) => `${base}/image${theme === "dark" ? "?theme=dark" : ""}`,
      frame: (theme) => `${base}/frame?theme=${theme === "dark" ? "dark" : "light"}`,
      download: (fmt, theme) => `${base}/download/${fmt}${fmt === "png" && theme === "dark" ? "?theme=dark" : ""}`,
    }
  },
  visualMeta: (scope, id) => request("GET", api.visualUrls(scope, id).meta, undefined, { quiet401: !!scope?.token }),
  artifactVersions: (scope, artifactId) => request("GET", api.artifactUrls(scope, artifactId).versions, undefined, { quiet401: !!scope.token }),
  artifactDiff: (scope, artifactId, against) => request("GET", api.artifactUrls(scope, artifactId).diff(against), undefined, { quiet401: !!scope.token }),

  admin: {
    users: (q, page = 1, size = 20) => request("GET", `/api/admin/users?q=${enc(q || "")}&page=${page}&size=${size}`),
    createUser: (body) => request("POST", "/api/admin/users", body),
    resetPassword: (id) => request("POST", `/api/admin/users/${enc(id)}/reset-password`),
    updateUser: (id, patch) => request("PATCH", `/api/admin/users/${enc(id)}`, patch),
    deleteUser: (id) => request("DELETE", `/api/admin/users/${enc(id)}`),
    settings: () => request("GET", "/api/admin/settings"),
    saveSettings: (s) => request("PATCH", "/api/admin/settings", s),
    stats: () => request("GET", "/api/admin/stats"),
    models: () => request("GET", "/api/admin/models"),
    chats: (f = {}) => request("GET", `/api/admin/chats?${new URLSearchParams(Object.entries(f).filter(([, v]) => v !== "" && v != null)).toString()}`),
    chatMessages: (id, branch, beforeTurn) =>
      request("GET", `/api/admin/chats/${enc(id)}/messages?${new URLSearchParams({ ...(branch ? { branch } : {}), ...(beforeTurn != null ? { beforeTurn: String(beforeTurn) } : {}) }).toString()}`),
    accessLog: (page = 1, size = 20) => request("GET", `/api/admin/access-log?page=${page}&size=${size}`),
    testModel: (id) => request("POST", "/api/admin/models/test", { id }),
    setModel: (id) => request("PUT", "/api/admin/models/active", { id }),
    library: {
      tools: () => request("GET", "/api/admin/library/tools"),
      setTool: (name, enabled) => request("PUT", `/api/admin/library/tools/${enc(name)}`, { enabled }),
      skills: () => request("GET", "/api/admin/library/skills"),
      skill: (name) => request("GET", `/api/admin/library/skills/${enc(name)}`),
      setSkill: (name, enabled) => request("PUT", `/api/admin/library/skills/${enc(name)}`, { enabled }),
    },
    lab: {
      list: () => request("GET", "/api/admin/lab"),
      get: (id) => request("GET", `/api/admin/lab/${enc(id)}`),
      create: (body) => request("POST", "/api/admin/lab", body),
      update: (id, body) => request("PATCH", `/api/admin/lab/${enc(id)}`, body),
      remove: (id) => request("DELETE", `/api/admin/lab/${enc(id)}`),
    },
  },

  deleteUpload: (id) => request("DELETE", `/api/uploads/${enc(id)}`),
  /** Server-side processing phase of an upload in flight: extract | ocr-wait | ocr | done | unknown (+ pages). */
  uploadProgress: (key) => request("GET", `/api/uploads/progress/${enc(key)}`),
  /**
   * Multipart upload with progress (fetch has no upload progress, so XHR). The returned promise has `key`
   * (X-Upload-Key – poll uploadProgress(key) once the bytes are sent: a scanned PDF is OCR'd, ~2.5 s/page).
   */
  upload(file, onProgress) {
    const xhr = new XMLHttpRequest()
    const key = Array.from(crypto.getRandomValues(new Uint8Array(12)), (b) => b.toString(16).padStart(2, "0")).join("")
    const promise = new Promise((resolve, reject) => {
      xhr.open("POST", "/api/uploads")
      for (const [k, v] of Object.entries(localeHeaders())) xhr.setRequestHeader(k, v)
      xhr.setRequestHeader("X-Upload-Key", key)
      xhr.responseType = "json"
      xhr.upload.onprogress = (e) => e.lengthComputable && onProgress?.(e.loaded / e.total)
      xhr.onload = () => {
        const data = xhr.response
        if (xhr.status >= 200 && xhr.status < 300) resolve(data.upload)
        else {
          if (xhr.status === 401) emit("auth:expired")
          reject(new ApiError(data?.error || t("errors.generic"), xhr.status, data?.code))
        }
      }
      xhr.onerror = () => reject(new ApiError(t("errors.uploadFailed"), 0))
      xhr.onabort = () => reject(new ApiError(t("errors.uploadCancelled"), 0, "aborted"))
      const fd = new FormData()
      fd.append("file", file, file.name)
      xhr.send(fd)
    })
    promise.abort = () => xhr.abort()
    promise.key = key
    return promise
  },
}

// Entry point: start (or connect to) opencode, then serve the web app on 127.0.0.1.
import http from "node:http"
import { config } from "./config.mjs"
import { purgeExpiredSessions } from "./auth.mjs"
import { createApp } from "./app.mjs"
import { connectOpencode, startOpencode } from "./opencode.mjs"
import { activeModelInfo } from "./models.mjs"

async function main() {
  const t0 = Date.now()
  const { client: oc, stop } = config.opencodeUrl
    ? await connectOpencode(config.opencodeUrl, config.opencodePassword)
    : await startOpencode({ port: config.opencodePort })

  // Admin-only (GET /api/admin/stats): the model new prompts use (admin switcher, default opencode.json).
  const getModelInfo = async () => activeModelInfo()

  const app = createApp({ oc, getModelInfo })
  const server = http.createServer({ requestTimeout: 0, headersTimeout: 30_000 }, app)
  // WebSocket upgrades: only the assist live view (server/assist.mjs) – anything else is dropped
  server.on("upgrade", (req, socket, head) => {
    if (!app.locals.upgrade?.(req, socket, head)) socket.destroy()
  })
  server.keepAliveTimeout = 65_000
  server.listen(config.port, config.host, () => {
    console.log(`[web] http://${config.host}:${config.port} ready (${((Date.now() - t0) / 1000).toFixed(1)} s, registration ${config.allowRegistration ? "on" : "off"})`)
  })
  server.on("error", (e) => {
    console.error("[web] cannot listen:", e.message)
    stop()
    process.exit(1)
  })
  purgeExpiredSessions()
  setInterval(purgeExpiredSessions, 6 * 3600_000).unref()

  let exiting = false
  const shutdown = () => {
    if (exiting) return
    exiting = true
    console.log("[web] shutting down")
    stop()
    server.close()
    setTimeout(() => process.exit(0), 500).unref()
  }
  process.on("SIGINT", shutdown)
  process.on("SIGTERM", shutdown)
  process.on("SIGHUP", shutdown)
  process.on("exit", () => stop())
}

main().catch((e) => {
  console.error("[web] fatal:", e)
  process.exit(1)
})

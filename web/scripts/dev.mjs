// npm run dev: backend (which starts opencode) + Vite dev server with /api proxied to it.
// Open http://127.0.0.1:5173 .
import { spawn } from "node:child_process"
import path from "node:path"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const run = (cmd, args) => spawn(cmd, args, { cwd: web, stdio: "inherit", shell: false })
const backend = run(process.execPath, ["--disable-warning=ExperimentalWarning", "server/index.mjs"])
const vite = run(process.execPath, [path.join(web, "node_modules", "vite", "bin", "vite.js"), "client"])
const stop = () => {
  backend.kill("SIGTERM")
  vite.kill("SIGTERM")
}
process.on("SIGINT", stop)
process.on("SIGTERM", stop)
backend.on("exit", () => vite.kill())
vite.on("exit", () => backend.kill())

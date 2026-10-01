// Preloaded (`node --import`) into every Archify renderer / checker child process started by ../lib/archify.ts:
// the vendored renderer must be a pure JSON → SVG compiler, so every network and process API is replaced by a
// function that throws BEFORE the renderer code is loaded. (The only network path in Archify 2.16 is the optional
// brand-mark URL capture, and diagram_create strips `brand` anyway – this is defence in depth.)
import net from "node:net"
import tls from "node:tls"
import dns from "node:dns"
import http from "node:http"
import https from "node:https"
import http2 from "node:http2"
import dgram from "node:dgram"
import cp from "node:child_process"
import wt from "node:worker_threads"
import { syncBuiltinESMExports } from "node:module"

const deny = (what) => () => {
  throw new Error(`[archify sandbox] ${what} is disabled`)
}
const denyAll = (obj, names, what) => {
  for (const n of names) if (typeof obj[n] === "function") obj[n] = deny(`${what}.${n}`)
}
denyAll(net, ["connect", "createConnection", "createServer"], "net")
net.Socket.prototype.connect = deny("net.Socket.connect")
denyAll(tls, ["connect", "createServer"], "tls")
denyAll(dns, ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "lookupService"], "dns")
denyAll(dns.promises, ["lookup", "resolve", "resolve4", "resolve6", "resolveAny", "lookupService"], "dns.promises")
denyAll(http, ["request", "get", "createServer"], "http")
denyAll(https, ["request", "get", "createServer"], "https")
denyAll(http2, ["connect", "createServer", "createSecureServer"], "http2")
denyAll(dgram, ["createSocket"], "dgram")
denyAll(cp, ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"], "child_process")
wt.Worker = class { constructor() { throw new Error("[archify sandbox] worker_threads is disabled") } }
globalThis.fetch = deny("fetch")
globalThis.WebSocket = undefined
globalThis.EventSource = undefined
syncBuiltinESMExports()

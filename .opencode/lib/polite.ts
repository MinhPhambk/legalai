// One per-host politeness limiter for every tool that loads pages / feeds through the sandbox Chrome
// (web_*, vbpl_*, trav_*, fedreg_*, eurlex_*, eping_*, fta_*, court_*, fx_*): at most `concurrency`
// requests in flight per host and request starts at least `gapMs` apart. The state is shared by all tools
// of the process (module singleton), so e.g. web_read delegating to court_* can never exceed the court
// site's limit combined. A host keeps the STRICTEST limits any caller asked for.
// Imported by tool files only – this file exports no tools.
type State = { active: number; next: number; waiters: (() => void)[]; concurrency: number; gapMs: number }
const hosts = new Map<string, State>()
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))
export const hostKey = (hostOrUrl: string) => {
  try { return new URL(hostOrUrl).hostname.replace(/^www\./, "") } catch { return hostOrUrl.replace(/^www\./, "") }
}
/** Run `fn` as one request to `host` (hostname or URL) within the host's limits. */
export async function polite<T>(host: string, fn: () => Promise<T>, opts: { concurrency?: number; gapMs?: number } = {}): Promise<T> {
  const key = hostKey(host)
  const s = hosts.get(key) ?? { active: 0, next: 0, waiters: [], concurrency: opts.concurrency ?? 2, gapMs: opts.gapMs ?? 1000 }
  s.concurrency = Math.min(s.concurrency, opts.concurrency ?? s.concurrency)
  s.gapMs = Math.max(s.gapMs, opts.gapMs ?? s.gapMs)
  hosts.set(key, s)
  while (s.active >= s.concurrency) await new Promise<void>((r) => s.waiters.push(r))
  s.active++
  const at = Math.max(Date.now(), s.next)
  s.next = at + s.gapMs
  await sleep(at - Date.now())
  try {
    return await fn()
  } finally {
    s.active--
    s.waiters.shift()?.()
  }
}
/** Wait for a request slot without holding it (for navigations whose follow-up fetches run in the page). */
export const throttle = (host: string, opts?: { concurrency?: number; gapMs?: number }) => polite(host, async () => {}, opts)
/** Test hook: current limits of a host. */
export const limitsOf = (host: string) => { const s = hosts.get(hostKey(host)); return s ? { concurrency: s.concurrency, gapMs: s.gapMs, active: s.active } : null }
/** page.evaluate(fn, …args) of an in-page fetch() to `host`, within that host's limits. */
export const politeEval = (host: string, page: any, fn: any, ...args: any[]) => polite(host, () => page.evaluate(fn, ...args))
/** page.goto within the target host's limits (the slot is held for the navigation). */
export const politeGoto = (page: any, url: string, opts?: any) => polite(url, () => page.goto(url, opts))

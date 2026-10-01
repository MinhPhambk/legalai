// Long-poll transport for the chat event stream (for viewers behind proxies that buffer whole
// chunked responses, e.g. the Cloudflare quick tunnel – SSE never reaches them live).
//
// One EventLog per (chat, viewer scope): it is a hub connection like an SSE one (same follow() /
// translateEvent / per-viewer ctx), but instead of writing to a socket it appends every event to a
// ring buffer with a monotonically increasing seq. GET /api/chats/:id/poll?after=<seq> drains it.
// Event types are opaque here: whatever the SSE route would send passes through unchanged.

const MAX_EVENTS = 2000
const MAX_AGE = 10 * 60_000 // buffered events and idle logs are kept this long
const LIVE_FOR = 60_000 // counted as an open stream while polled within this window
const BATCH_MS = 60

// Seq numbers are global and start at the process start time (ms), so a seq from a previous server
// process is always older than anything buffered now – the client gets `reset` instead of silently
// missing events.
let lastSeq = Date.now()

export class EventLog {
  constructor() {
    this.events = [] // { seq, at, ev }
    this.floor = lastSeq // seq just before the first event this log could ever hold
    this.waiters = new Set()
    this.polledAt = Date.now()
    this.polling = 0
  }
  get seq() {
    return this.events.length ? this.events[this.events.length - 1].seq : this.floor
  }
  push(ev) {
    this.events.push({ seq: ++lastSeq, at: Date.now(), ev })
    this.prune()
    for (const w of this.waiters) w()
  }
  prune(now = Date.now()) {
    let drop = 0
    while (drop < this.events.length && (this.events.length - drop > MAX_EVENTS || now - this.events[drop].at > MAX_AGE)) drop++
    if (drop) {
      this.floor = this.events[drop - 1].seq
      this.events.splice(0, drop)
    }
  }
  /** { events, next } after `after`, or null when `after` is older than the buffer (or not from this log). */
  since(after) {
    const next = this.seq
    if (after < this.floor || after > next) return null
    const i = this.events.findIndex((e) => e.seq > after)
    return { events: i < 0 ? [] : this.events.slice(i).map((e) => e.ev), next: Math.max(after, next) }
  }
  /**
   * Resolves with since(after) as soon as there are new events (batched for BATCH_MS once the first
   * arrives), or after `waitMs`. `onClose(finish)` lets the caller end the wait early (client gone).
   */
  wait(after, waitMs, onClose) {
    return new Promise((resolve) => {
      let batch = null
      let done = false
      const finish = () => {
        if (done) return
        done = true
        clearTimeout(timer)
        clearTimeout(batch)
        this.waiters.delete(wake)
        resolve(this.since(after))
      }
      const wake = () => {
        if (!batch) batch = setTimeout(finish, BATCH_MS)
      }
      const timer = setTimeout(finish, waitMs)
      this.waiters.add(wake)
      onClose(finish)
    })
  }
  get live() {
    return this.polling > 0 || Date.now() - this.polledAt < LIVE_FOR
  }
  get stale() {
    return this.polling === 0 && Date.now() - this.polledAt > MAX_AGE
  }
}

export const POLL = { MAX_EVENTS, MAX_AGE, MAX_WAIT_S: 25 }

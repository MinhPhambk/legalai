import { Component, useEffect, useRef, useState } from "react"
import { api } from "../api.js"
import { navigate, useTitle } from "../route.js"
import { t, useT } from "../i18n.jsx"
import { IconAlert, IconLogo, IconRefresh, IconWifiOff, Spinner } from "../components/Icons.jsx"

export function NotFound() {
  const t = useT()
  useTitle(t("states.notFound.docTitle"))
  return (
    <div className="state-page full">
      <span className="logo-mark xl float-in">
        <IconLogo size={30} />
      </span>
      <span className="state-code">404</span>
      <h1>{t("states.notFound.title")}</h1>
      <p>{t("states.notFound.body")}</p>
      <div className="state-actions">
        <button className="btn ghost" onClick={() => window.history.back()}>
          {t("common.back")}
        </button>
        <button className="btn primary" onClick={() => navigate("/")}>
          {t("common.home")}
        </button>
      </div>
    </div>
  )
}

export function ErrorPage({ error, onRetry }) {
  // Rendered by the error boundary: uses the module-level t (no hooks needed).
  return (
    <div className="state-page full" role="alert">
      <span className="state-icon">
        <IconAlert size={28} />
      </span>
      <h1>{t("states.crash.title")}</h1>
      <p>{t("states.crash.body")}</p>
      {error?.message && <code className="state-detail">{String(error.message).slice(0, 200)}</code>}
      <div className="state-actions">
        <button className="btn ghost" onClick={() => (window.location.href = "/")}>
          {t("common.home")}
        </button>
        <button className="btn primary" onClick={onRetry}>
          <IconRefresh size={15} /> {t("common.retry")}
        </button>
      </div>
    </div>
  )
}

export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null }
  }
  static getDerivedStateFromError(error) {
    return { error }
  }
  componentDidCatch(error, info) {
    console.error("[ui] crashed", error, info?.componentStack)
  }
  render() {
    if (this.state.error)
      return (
        <ErrorPage
          error={this.state.error}
          onRetry={() => {
            this.setState({ error: null })
            this.props.onReset?.()
          }}
        />
      )
    return this.props.children
  }
}

/** Offline / reconnecting / agent maintenance banner. `stream` comes from the chat's SSE state. */
export function ConnectionBanner({ stream, signedIn }) {
  const t = useT()
  const [online, setOnline] = useState(navigator.onLine)
  const [server, setServer] = useState("ok") // ok | down
  const [agent, setAgent] = useState(true)
  const [checking, setChecking] = useState(false)
  const timer = useRef(0)
  const check = async () => {
    setChecking(true)
    try {
      const h = await api.health()
      setServer("ok")
      setAgent(!!h.agent)
    } catch {
      setServer("down")
    } finally {
      setChecking(false)
    }
  }
  useEffect(() => {
    const on = () => {
      setOnline(true)
      check()
    }
    const off = () => setOnline(false)
    const netDown = () => setServer("down")
    const netUp = () => setServer("ok")
    const agentDown = () => setAgent(false)
    window.addEventListener("online", on)
    window.addEventListener("offline", off)
    window.addEventListener("net:down", netDown)
    window.addEventListener("net:up", netUp)
    window.addEventListener("agent:down", agentDown)
    if (signedIn) check()
    return () => {
      window.removeEventListener("online", on)
      window.removeEventListener("offline", off)
      window.removeEventListener("net:down", netDown)
      window.removeEventListener("net:up", netUp)
      window.removeEventListener("agent:down", agentDown)
    }
  }, [signedIn]) // eslint-disable-line react-hooks/exhaustive-deps
  const problem = !online ? "offline" : server === "down" ? "server" : !agent ? "agent" : stream === "reconnecting" || stream === "down" ? "stream" : null
  // Poll while something is wrong so the banner clears by itself.
  useEffect(() => {
    clearInterval(timer.current)
    if (problem && problem !== "offline") timer.current = setInterval(check, problem === "agent" ? 10000 : 5000)
    return () => clearInterval(timer.current)
  }, [problem]) // eslint-disable-line react-hooks/exhaustive-deps
  const text = problem ? t(`states.conn.${problem}`) : ""
  return (
    <div className={`conn-banner ${problem ? `show ${problem}` : ""}`} role="status" aria-live="polite" aria-hidden={!problem}>
      {problem && (
        <>
          {problem === "offline" ? <IconWifiOff size={15} /> : problem === "agent" ? <IconAlert size={15} /> : <Spinner size={13} />}
          <span>{text}</span>
          {problem !== "offline" && problem !== "stream" && (
            <button className="link-btn" onClick={check} disabled={checking}>
              {checking ? t("states.conn.checking") : t("common.retry")}
            </button>
          )}
        </>
      )}
    </div>
  )
}

export function Splash() {
  const t = useT()
  return (
    <div className="splash" aria-label={t("common.loading")}>
      <span className="logo-mark xl pulse">
        <IconLogo size={30} />
      </span>
    </div>
  )
}

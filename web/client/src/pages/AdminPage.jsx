// Admin console: left sub-navigation (desktop) / scrollable tabs (≤ 768 px), one route per section
// (/admin = overview, /admin/<section>), each section loads its own data only when it is opened. Filters /
// paging stay in the query string (deep links; each section's last query is restored when you come back).
import "../app-styles.js"
import "../styles-admin.css"
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { api } from "../api.js"
import { navigate, relTime, useTitle } from "../lib.js"
import { useT } from "../i18n.jsx"
import { Segmented, Switch, useToast } from "../components/ui.jsx"
import { AdminAccessLog, AdminChatHistory } from "./AdminChats.jsx"
import AdminLibrary from "./AdminLibrary.jsx"
import AdminUsers from "./AdminUsers.jsx"
import AdminGrounding from "../components/AdminGrounding.jsx"
import { ESC_IN_PROGRESS, ESC_NEW, ESC_STATUSES, ESC_STATUS_KEY } from "../codes.js"
import {
  IconBook, IconEye, IconGavel, IconLeft, IconRefresh, IconReport, IconRight, IconSettings, IconShield, IconSparkle, IconUsers, Spinner,
} from "../components/Icons.jsx"

export const ADMIN_SECTIONS = [
  { k: "overview", key: "overview", Icon: IconShield },
  { k: "users", key: "users", Icon: IconUsers },
  { k: "chats", key: "chats", Icon: IconReport },
  { k: "access-log", key: "accessLog", Icon: IconEye },
  { k: "experts", key: "experts", Icon: IconGavel },
  { k: "models", key: "models", Icon: IconSparkle },
  { k: "library", key: "library", Icon: IconBook },
  { k: "settings", key: "settings", Icon: IconSettings },
]
export const adminPath = (k) => (k === "overview" ? "/admin" : `/admin/${k}`)
const lastQuery = {} // section -> its last query string (restored when navigating back to it)

function Stat({ label, value, sub, onClick }) {
  const body = (
    <>
      <span className="stat-label">{label}</span>
      <span className="stat-value">{value ?? "–"}</span>
      {sub && <span className="stat-sub">{sub}</span>}
    </>
  )
  return onClick ? (
    <button type="button" className="stat stat-link" onClick={onClick}>
      {body}
    </button>
  ) : (
    <div className="stat">{body}</div>
  )
}

function SectionHead({ id, title, desc, children }) {
  return (
    <>
      <div className="admin-section-head">
        <h2 id={id}>{title}</h2>
        {children}
      </div>
      {desc && <p className="set-row-desc adm-note">{desc}</p>}
    </>
  )
}

// ---- 1. overview ---------------------------------------------------------------------------------
function Overview({ go }) {
  const t = useT()
  const toast = useToast()
  const [stats, setStats] = useState(null)
  const [esc, setEsc] = useState(null)
  const [recent, setRecent] = useState(null)
  const load = useCallback(() => {
    api.admin.stats().then(setStats, (e) => toast.error(e.message))
    api.expert.list({ status: "open", size: 20 }).then(setEsc, () => setEsc({ counts: {}, total: 0 }))
    api.admin.chats({ size: 20 }).then(
      (r) => setRecent((r.chats || []).slice(0, 6)),
      () => setRecent([]),
    )
  }, [toast])
  useEffect(() => {
    load()
    const timer = setInterval(() => api.admin.stats().then(setStats, () => {}), 15000)
    return () => clearInterval(timer)
  }, [load])
  const oc = stats?.system
  const openEsc = esc ? (esc.counts?.[ESC_NEW] || 0) + (esc.counts?.[ESC_IN_PROGRESS] || 0) : null
  return (
    <section className="admin-section" aria-labelledby="adm-h-overview">
      <SectionHead id="adm-h-overview" title={t("admin.console.nav.overview")} desc={t("admin.console.desc.overview")}>
        <button className="icon-btn sm" onClick={load} aria-label={t("admin.refreshStats")} title={t("common.refresh")}>
          <IconRefresh size={15} />
        </button>
      </SectionHead>
      <div className="stats">
        {stats ? (
          <>
            <Stat label={t("admin.stats.users")} value={stats.users} sub={stats.disabledUsers ? t("admin.stats.locked", { count: stats.disabledUsers }) : t("admin.stats.active")} onClick={() => go("users")} />
            <Stat label={t("admin.stats.chats")} value={stats.chats} sub={t("admin.stats.today", { count: stats.chatsToday })} onClick={() => go("chats")} />
            <Stat label={t("admin.stats.questionsToday")} value={stats.messagesToday} sub={t("admin.stats.last7d", { count: stats.messages7d })} />
            <Stat label={t("admin.stats.running")} value={stats.activeRuns} sub={t("admin.console.waiting", { count: stats.waitingOnQuestion || 0 })} />
            <Stat label={t("admin.console.expertOpen")} value={openEsc} sub={esc ? t("admin.console.expertNew", { count: esc.counts?.[ESC_NEW] || 0 }) : ""} onClick={() => go("experts")} />
            <Stat label={t("admin.stats.shares")} value={stats.shares} />
          </>
        ) : (
          [1, 2, 3, 4, 5, 6].map((i) => <div key={i} className="stat skeleton" style={{ height: 92 }} />)
        )}
      </div>
      <div className="agent-status">
        <span className={`dot-status ${oc ? (oc.ok ? "ok" : "bad") : ""}`} aria-hidden="true" />
        <div>
          <div className="agent-status-title">{oc ? (oc.ok ? t("admin.agent.ok") : t("admin.agent.down")) : t("admin.agent.checking")}</div>
          <div className="agent-status-sub">
            {stats?.model ? t("admin.agent.model", { name: stats.model.name, provider: stats.model.provider }) : ""}
            {stats?.agent ? ` · ${t("admin.agent.name", { name: stats.agent })}` : ""}
            {oc ? ` · ${t("admin.agent.latency", { ms: oc.ms })} · ${oc.events ? t("admin.agent.eventsUp") : t("admin.agent.eventsDown")}` : ""}
          </div>
        </div>
        <button type="button" className="btn ghost xs adm-status-link" onClick={() => go("models")}>
          {t("admin.console.nav.models")} <IconRight size={13} />
        </button>
      </div>
      <div className="adm-card">
        <div className="adm-card-head">
          <h3>{t("admin.console.recent")}</h3>
          <button type="button" className="link-btn" onClick={() => go("chats")}>
            {t("admin.console.seeAll")}
          </button>
        </div>
        {recent === null ? (
          <div className="skeleton line" />
        ) : recent.length === 0 ? (
          <p className="muted adm-empty">{t("adminChats.empty")}</p>
        ) : (
          <ul className="adm-recent">
            {recent.map((c) => (
              <li key={c.id}>
                <a
                  href={`/admin/chats/${c.id}`}
                  onClick={(e) => {
                    e.preventDefault()
                    navigate(`/admin/chats/${c.id}`)
                  }}
                >
                  {c.title || t("chat.newChat")}
                </a>
                <span className="muted">
                  {c.ownerEmail} · {relTime(c.updatedAt)}
                </span>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

// ---- 5. experts ----------------------------------------------------------------------------------
function Experts({ go }) {
  const t = useT()
  const toast = useToast()
  const [esc, setEsc] = useState(null)
  const [experts, setExperts] = useState(null)
  const loadExperts = useCallback(
    () =>
      api.admin.users("", 1, 100).then(
        (r) => setExperts(r.users.filter((u) => u.isExpert)),
        () => setExperts([]),
      ),
    [],
  )
  useEffect(() => {
    api.expert.list({ size: 20 }).then(setEsc, () => setEsc({ counts: {}, total: 0 }))
    loadExperts()
  }, [loadExperts])
  const revoke = async (u) => {
    try {
      await api.admin.updateUser(u.id, { isExpert: false })
      toast.success(t("admin.expertRole.revoked"))
      loadExperts()
    } catch (e) {
      toast.error(e.message)
    }
  }
  return (
    <section className="admin-section" aria-labelledby="adm-h-experts">
      <SectionHead id="adm-h-experts" title={t("admin.console.nav.experts")} desc={t("admin.console.desc.experts")}>
        <button type="button" className="btn primary sm" onClick={() => navigate("/expert")}>
          {t("admin.console.openQueue")} <IconRight size={14} />
        </button>
      </SectionHead>
      <div className="stats">
        {esc
          ? ESC_STATUSES.map((s) => <Stat key={s} label={t(`expert.status.${ESC_STATUS_KEY[s]}`)} value={esc.counts?.[s] || 0} />)
          : [1, 2, 3, 4].map((i) => <div key={i} className="stat skeleton" style={{ height: 92 }} />)}
      </div>
      <div className="adm-card">
        <div className="adm-card-head">
          <h3>{t("admin.console.expertList")}</h3>
          <button type="button" className="link-btn" onClick={() => go("users")}>
            {t("admin.console.manageRoles")}
          </button>
        </div>
        {experts === null ? (
          <div className="skeleton line" />
        ) : experts.length === 0 ? (
          <p className="muted adm-empty">{t("admin.console.noExperts")}</p>
        ) : (
          <ul className="adm-recent">
            {experts.map((u) => (
              <li key={u.id}>
                <span className="u-email">{u.email}</span>
                <span className="muted">{u.lastLoginAt ? t("admin.signedIn", { when: relTime(u.lastLoginAt) }) : t("admin.neverUsed")}</span>
                <button type="button" className="btn ghost xs" onClick={() => revoke(u)}>
                  {t("admin.expertRole.revoke")}
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}

// ---- 6. models -----------------------------------------------------------------------------------
/** Admin-only model switcher: models from opencode.json, health check (latency + tool calling), global choice. */
function ModelSwitcher({ onChanged }) {
  const t = useT()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [tests, setTests] = useState({})
  const [busy, setBusy] = useState("")
  useEffect(() => {
    api.admin.models().then(setData, (e) => toast.error(e.message))
  }, [toast])
  const test = async (id) => {
    setTests((s) => ({ ...s, [id]: { running: true } }))
    try {
      const r = await api.admin.testModel(id)
      setTests((s) => ({ ...s, [id]: r }))
    } catch (e) {
      setTests((s) => ({ ...s, [id]: { ok: false, error: e.message } }))
    }
  }
  const choose = async (id) => {
    setBusy(id || "default")
    try {
      const r = await api.admin.setModel(id)
      setData(r)
      toast.success(t("admin.models.saved", { name: r.models.find((m) => m.id === r.active)?.name || r.active }))
      onChanged?.()
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy("")
    }
  }
  if (!data) return <div className="stat skeleton" style={{ height: 120 }} />
  return (
    <div className="adm-models">
      <p className="set-row-desc">{t("admin.models.desc")}</p>
      <ul className="adm-model-list">
        {data.models.map((m) => {
          const r = tests[m.id]
          const active = m.id === data.active
          return (
            <li key={m.id} className={`adm-model ${active ? "active" : ""}`}>
              <div className="adm-model-main">
                <div className="adm-model-name">
                  <span className={`adm-model-dot ${active ? "on" : ""}`} aria-hidden="true" />
                  <strong>{m.name}</strong>
                  {active && <span className="status-badge ok">{t("admin.models.active")}</span>}
                  {m.id === data.default && <span className="status-badge">{t("admin.models.configDefault")}</span>}
                </div>
                <div className="adm-model-sub">
                  <code>{m.id}</code> · {m.provider}
                </div>
                {r && (
                  <div className={`adm-model-test ${r.running ? "" : r.ok && r.toolCall ? "ok" : "bad"}`} role="status">
                    {r.running
                      ? t("admin.models.testing")
                      : r.ok
                        ? t(r.toolCall ? "admin.models.testOk" : "admin.models.testNoTool", { ms: r.ms, error: r.error || "" })
                        : t("admin.models.testFail", { ms: r.ms ?? 0, error: r.error || "" })}
                  </div>
                )}
              </div>
              <div className="adm-model-actions">
                <button type="button" className="btn ghost sm" onClick={() => test(m.id)} disabled={r?.running}>
                  {r?.running ? <Spinner size={14} /> : null} {t("admin.models.test")}
                </button>
                <button type="button" className="btn primary sm" onClick={() => choose(m.id)} disabled={active || !!busy}>
                  {busy === m.id ? <Spinner size={14} /> : null} {t("admin.models.setDefault")}
                </button>
              </div>
            </li>
          )
        })}
      </ul>
      {data.chosen && data.chosen !== data.default && (
        <button type="button" className="link-btn adm-model-reset" onClick={() => choose("")} disabled={!!busy}>
          {t("admin.models.reset")}
        </button>
      )}
    </div>
  )
}


function Models() {
  const t = useT()
  return (
    <section className="admin-section" aria-labelledby="adm-h-models">
      <SectionHead id="adm-h-models" title={t("admin.models.title")} />
      <ModelSwitcher />
    </section>
  )
}

// ---- 8. system settings --------------------------------------------------------------------------
function Settings() {
  const t = useT()
  const toast = useToast()
  const [s, setS] = useState(null)
  useEffect(() => {
    api.admin.settings().then(setS, (e) => toast.error(e.message))
  }, [toast])
  const save = async (patch, msg) => {
    const prev = s
    setS({ ...s, ...patch })
    try {
      setS(await api.admin.saveSettings(patch))
      toast.success(msg)
    } catch (e) {
      setS(prev)
      toast.error(e.message)
    }
  }
  const n = s?.followupCount ?? 3
  return (
    <section className="admin-section" aria-labelledby="adm-h-settings">
      <SectionHead id="adm-h-settings" title={t("admin.console.nav.settings")} desc={t("admin.console.desc.settings")} />
      <div className="adm-card">
        <h3>{t("admin.console.group.access")}</h3>
        <Switch id="adm-reg" label={t("admin.allowReg")} description={t("admin.allowRegDesc")} checked={!!s?.allowRegistration} disabled={!s} onChange={(v) => save({ allowRegistration: v }, v ? t("admin.regOpened") : t("admin.regClosed"))} />
      </div>
      <div className="adm-card">
        <h3>{t("admin.console.group.answers")}</h3>
        <div className="set-row admin-followups">
          <div className="set-row-text">
            <div className="set-row-title" id="adm-fu-label">
              {t("admin.followups.title")}
            </div>
            <div className="set-row-desc">{t("admin.followups.desc")}</div>
          </div>
          <div className="set-row-ctl">
            {s && (
              <Segmented
                label={t("admin.followups.title")}
                value={n}
                onChange={(v) => save({ followupCount: v }, v ? t("admin.followups.saved", { count: v }) : t("admin.followups.off"))}
                options={[0, 1, 2, 3, 4, 5].map((x) => ({ value: x, label: x ? String(x) : t("admin.followups.offShort") }))}
              />
            )}
          </div>
        </div>
        <Switch
          id="adm-reasoning"
          label={t("admin.reasoningUsers")}
          description={t("admin.reasoningUsersDesc")}
          checked={!!s?.showReasoningToUsers}
          disabled={!s}
          onChange={(v) => save({ showReasoningToUsers: v }, v ? t("admin.reasoningOn") : t("admin.reasoningOff"))}
        />
      </div>
      <div className="adm-card">
        <h3>{t("admin.console.group.verify")}</h3>
        <AdminGrounding />
      </div>
    </section>
  )
}

// ---- shell ---------------------------------------------------------------------------------------
function Section({ k, go }) {
  switch (k) {
    case "users":
      return <AdminUsers />
    case "chats":
      return <AdminChatHistory />
    case "access-log":
      return <AdminAccessLog />
    case "experts":
      return <Experts go={go} />
    case "models":
      return <Models />
    case "library":
      return <AdminLibrary />
    case "settings":
      return <Settings />
    default:
      return <Overview go={go} />
  }
}

export default function AdminPage({ me, section = "overview" }) {
  const t = useT()
  const current = ADMIN_SECTIONS.find((s) => s.k === section) || ADMIN_SECTIONS[0]
  useTitle(`${t(`admin.console.nav.${current.key}`)} – ${t("admin.docTitle")}`)
  const navRef = useRef(null)
  const rootRef = useRef(null)
  const topRef = useRef(null)
  // The sub-navigation sticks right under the (sticky) header: expose its height as --adm-top-h.
  useLayoutEffect(() => {
    const top = topRef.current
    if (!top) return
    const set = () => rootRef.current?.style.setProperty("--adm-top-h", `${top.offsetHeight}px`)
    set()
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(set) : null
    ro?.observe(top)
    return () => ro?.disconnect()
  }, [])
  const go = useCallback(
    (k) => {
      if (k === current.k) return
      lastQuery[current.k] = window.location.search
      navigate(adminPath(k) + (lastQuery[k] || ""))
    },
    [current.k],
  )
  // Keep the active tab visible in the scrollable mobile strip.
  useEffect(() => {
    navRef.current?.querySelector('[aria-current="page"]')?.scrollIntoView?.({ block: "nearest", inline: "center" })
  }, [current.k])
  const onKey = (e) => {
    if (!["ArrowDown", "ArrowUp", "ArrowLeft", "ArrowRight", "Home", "End"].includes(e.key)) return
    const items = [...navRef.current.querySelectorAll(".adm-nav-item")]
    const i = items.indexOf(document.activeElement)
    if (i < 0) return
    e.preventDefault()
    const n = e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : (i + (e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1) + items.length) % items.length
    items[n].focus()
  }
  return (
    <div className="admin" ref={rootRef}>
      <header className="admin-top" ref={topRef}>
        <button className="btn ghost sm" onClick={() => navigate("/")}>
          <IconLeft size={15} /> <span>{t("admin.backToChat")}</span>
        </button>
        <h1>
          <IconShield size={20} /> {t("admin.title")}
        </h1>
        <span className="admin-me">{me.email}</span>
      </header>
      <div className="adm-shell">
        <nav className="adm-nav" aria-label={t("admin.console.navLabel")} ref={navRef} onKeyDown={onKey}>
          <ul>
            {ADMIN_SECTIONS.map(({ k, key, Icon }) => (
              <li key={k}>
                <a
                  href={adminPath(k)}
                  className={`adm-nav-item ${k === current.k ? "on" : ""}`}
                  aria-current={k === current.k ? "page" : undefined}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || e.button) return
                    e.preventDefault()
                    go(k)
                  }}
                >
                  <Icon size={16} />
                  <span>{t(`admin.console.nav.${key}`)}</span>
                </a>
              </li>
            ))}
          </ul>
        </nav>
        <main className="admin-main adm-content" key={current.k}>
          <Section k={current.k} go={go} />
        </main>
      </div>
    </div>
  )
}


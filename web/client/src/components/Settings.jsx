import { useEffect, useState } from "react"
import { api } from "../api.js"
import { navigate, useThemePref } from "../lib.js"
import { useApp } from "../settings.jsx"
import { Dialog, Segmented, Switch, useConfirm, useToast } from "./ui.jsx"
import { PasswordInput, StrengthMeter } from "../pages/Auth.jsx"
import { LOCALES, Trans, fmtDateTime, useLocale, useT } from "../i18n.jsx"
import {
  IconClose, IconDatabase, IconDownload, IconExternal, IconInfo, IconLink, IconMonitor, IconMoon, IconSettings, IconSun, IconTrash, IconUser, Spinner,
} from "./Icons.jsx"

const TABS = [
  { k: "general", icon: <IconSettings size={16} /> },
  { k: "account", icon: <IconUser size={16} /> },
  { k: "data", icon: <IconDatabase size={16} /> },
  { k: "about", icon: <IconInfo size={16} /> },
]

function Row({ title, desc, children }) {
  return (
    <div className="set-row">
      <div className="set-row-text">
        <div className="set-row-title">{title}</div>
        {desc && <div className="set-row-desc">{desc}</div>}
      </div>
      <div className="set-row-ctl">{children}</div>
    </div>
  )
}

function General() {
  const { settings, updateSettings, changeLocale, user, meta, autoRepair } = useApp()
  const toast = useToast()
  // Model reasoning is stripped server-side unless allowed: admins by their own toggle, others by the admin setting.
  const canReason = user?.isAdmin ? settings.adminReasoning !== false : !!meta?.reasoning
  const [theme, setTheme] = useThemePref()
  const [locale] = useLocale()
  const t = useT()
  return (
    <div className="set-pane">
      <Row title={t("settings.general.language")} desc={t("settings.general.languageDesc")}>
        <Segmented
          label={t("settings.general.language")}
          value={locale}
          onChange={changeLocale}
          options={LOCALES.map((l) => ({ value: l, label: t(`settings.general.languageName.${l}`) }))}
        />
      </Row>
      <Row title={t("theme.label")} desc={t("settings.general.themeDesc")}>
        <Segmented
          label={t("theme.label")}
          value={theme}
          onChange={setTheme}
          options={[
            { value: "light", label: t("theme.light"), icon: <IconSun size={15} /> },
            { value: "dark", label: t("theme.dark"), icon: <IconMoon size={15} /> },
            { value: "system", label: t("theme.system"), icon: <IconMonitor size={15} /> },
          ]}
        />
      </Row>
      <Row title={t("settings.general.fontSize")} desc={t("settings.general.fontSizeDesc")}>
        <Segmented
          label={t("settings.general.fontSize")}
          value={settings.fontSize}
          onChange={(v) => updateSettings({ fontSize: v })}
          options={[
            { value: "sm", label: t("settings.general.fontSm") },
            { value: "md", label: t("settings.general.fontMd") },
            { value: "lg", label: t("settings.general.fontLg") },
          ]}
        />
      </Row>
      {user?.isAdmin && (
        <Switch
          id="set-admin-reasoning"
          label={t("settings.general.adminReasoning")}
          description={t("settings.general.adminReasoningDesc")}
          checked={settings.adminReasoning !== false}
          onChange={(v) => updateSettings({ adminReasoning: v })}
        />
      )}
      {canReason && (
        <Switch
          id="set-reasoning"
          label={t("settings.general.reasoning")}
          description={t("settings.general.reasoningDesc")}
          checked={settings.showReasoning}
          onChange={(v) => updateSettings({ showReasoning: v })}
        />
      )}
      <Switch
        id="set-followups"
        label={t("settings.general.followups")}
        description={t("settings.general.followupsDesc")}
        checked={settings.showFollowups !== false}
        onChange={(v) => updateSettings({ showFollowups: v })}
      />
      {autoRepair.allowed && (
        <Switch
          id="set-auto-repair"
          label={t("settings.general.autoRepair")}
          description={t("settings.general.autoRepairDesc")}
          checked={autoRepair.enabled}
          onChange={(v) => autoRepair.set(v).catch((e) => toast.error(e.message))}
        />
      )}
      <Switch
        id="set-enter"
        label={t("settings.general.enterToSend")}
        description={settings.enterToSend ? t("settings.general.enterOn") : t("settings.general.enterOff")}
        checked={settings.enterToSend}
        onChange={(v) => updateSettings({ enterToSend: v })}
      />
    </div>
  )
}

function Account({ onLoggedOut }) {
  const toast = useToast()
  const t = useT()
  const confirm = useConfirm()
  const { setUser } = useApp()
  const [acc, setAcc] = useState(null)
  const [name, setName] = useState("")
  const [pw, setPw] = useState({ current: "", next: "", confirm: "" })
  const [pwErr, setPwErr] = useState("")
  const [busy, setBusy] = useState("")
  const [del, setDel] = useState(false)
  const [delForm, setDelForm] = useState({ email: "", password: "" })
  const [delErr, setDelErr] = useState("")
  const load = () =>
    api.account().then((r) => {
      setAcc(r)
      setName(r.user.displayName)
    })
  useEffect(() => {
    load().catch((e) => toast.error(e.message))
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  if (!acc)
    return (
      <div className="set-pane">
        {[60, 90, 75].map((w, i) => (
          <div key={i} className="skeleton line" style={{ width: `${w}%`, height: 18, marginBottom: 18 }} />
        ))}
      </div>
    )
  const saveName = async () => {
    setBusy("name")
    try {
      const r = await api.updateAccount({ displayName: name })
      setUser((u) => ({ ...u, displayName: r.user.displayName }))
      toast.success(t("settings.account.nameSaved"))
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy("")
    }
  }
  const changePw = async (e) => {
    e.preventDefault()
    setPwErr("")
    if (pw.next.length < 8) return setPwErr(t("settings.account.newPasswordShort"))
    if (pw.next !== pw.confirm) return setPwErr(t("auth.errors.passwordMismatch"))
    setBusy("pw")
    try {
      await api.changePassword(pw.current, pw.next)
      setPw({ current: "", next: "", confirm: "" })
      toast.success(t("settings.account.passwordChanged"))
      load()
    } catch (err) {
      setPwErr(err.message)
    } finally {
      setBusy("")
    }
  }
  const logoutOthers = async () => {
    const ok = await confirm({ title: t("settings.account.logoutOthersTitle"), body: t("settings.account.logoutOthersBody"), confirmLabel: t("sidebar.logout") })
    if (!ok) return
    try {
      const r = await api.logoutOthers()
      toast.success(t("settings.account.loggedOutOthers", { count: r.count }))
      load()
    } catch (e) {
      toast.error(e.message)
    }
  }
  const deleteAccount = async (e) => {
    e.preventDefault()
    setDelErr("")
    setBusy("del")
    try {
      await api.deleteAccount(delForm.email, delForm.password)
      toast.success(t("settings.account.deleted"))
      onLoggedOut()
    } catch (err) {
      setDelErr(err.message)
      setBusy("")
    }
  }
  return (
    <div className="set-pane">
      <Row title={t("auth.email")} desc={t("settings.account.emailDesc")}>
        <span className="set-value">{acc.user.email}</span>
      </Row>
      <div className="set-block">
        <label className="set-row-title" htmlFor="set-name">
          {t("settings.account.displayName")}
        </label>
        <div className="set-inline">
          <input id="set-name" className="input" value={name} maxLength={60} placeholder={t("settings.account.displayNamePlaceholder")} onChange={(e) => setName(e.target.value)} />
          <button className="btn ghost sm" onClick={saveName} disabled={busy === "name" || name === acc.user.displayName}>
            {busy === "name" ? <Spinner size={13} /> : null} {t("common.save")}
          </button>
        </div>
      </div>
      <form className="set-block" onSubmit={changePw}>
        <div className="set-row-title">{t("settings.account.changePassword")}</div>
        <div className="set-grid">
          <PasswordInput id="pw-cur" label={t("settings.account.currentPassword")} value={pw.current} onChange={(v) => setPw((p) => ({ ...p, current: v }))} autoComplete="current-password" />
          <div>
            <PasswordInput id="pw-new" label={t("settings.account.newPassword")} value={pw.next} onChange={(v) => setPw((p) => ({ ...p, next: v }))} autoComplete="new-password" />
            <StrengthMeter password={pw.next} />
          </div>
          <PasswordInput id="pw-new2" label={t("settings.account.confirmNewPassword")} value={pw.confirm} onChange={(v) => setPw((p) => ({ ...p, confirm: v }))} autoComplete="new-password" />
        </div>
        {pwErr && (
          <div className="form-error show" role="alert">
            {pwErr}
          </div>
        )}
        <div className="set-actions">
          <button className="btn primary sm" type="submit" disabled={busy === "pw" || !pw.current || !pw.next}>
            {busy === "pw" ? <Spinner size={13} /> : null} {t("settings.account.changePassword")}
          </button>
        </div>
      </form>
      <Row title={t("settings.account.otherSessions")} desc={acc.otherSessions ? t("settings.account.otherSessionsN", { count: acc.otherSessions }) : t("settings.account.noOtherSessions")}>
        <button className="btn ghost sm" onClick={logoutOthers} disabled={!acc.otherSessions}>
          {t("settings.account.logoutAll")}
        </button>
      </Row>
      <div className="set-danger">
        <Row title={t("settings.account.deleteAccount")} desc={t("settings.account.deleteAccountDesc")}>
          <button className="btn danger-outline sm" onClick={() => setDel((d) => !d)} aria-expanded={del}>
            <IconTrash size={14} /> {t("settings.account.deleteAccount")}
          </button>
        </Row>
        <div className={`collapse ${del ? "open" : ""}`}>
          <div className="collapse-inner">
            <form className="set-block del-form" onSubmit={deleteAccount}>
              <p>
                <Trans k="settings.account.deleteConfirm" vars={{ email: acc.user.email }} components={{ b: <strong /> }} />
              </p>
              <div className="set-grid">
                <div className="field">
                  <label htmlFor="del-email">{t("auth.email")}</label>
                  <input id="del-email" className="input" value={delForm.email} autoComplete="off" onChange={(e) => setDelForm((f) => ({ ...f, email: e.target.value }))} />
                </div>
                <PasswordInput id="del-pw" label={t("auth.password")} value={delForm.password} onChange={(v) => setDelForm((f) => ({ ...f, password: v }))} autoComplete="current-password" />
              </div>
              {delErr && (
                <div className="form-error show" role="alert">
                  {delErr}
                </div>
              )}
              <div className="set-actions">
                <button className="btn danger sm" type="submit" disabled={busy === "del" || delForm.email.trim().toLowerCase() !== acc.user.email || !delForm.password}>
                  {busy === "del" ? <Spinner size={13} /> : null} {t("settings.account.deleteForever")}
                </button>
              </div>
            </form>
          </div>
        </div>
      </div>
    </div>
  )
}

function Data({ onChatsChanged }) {
  const toast = useToast()
  const t = useT()
  const confirm = useConfirm()
  const [shares, setShares] = useState(null)
  const [next, setNext] = useState(null)
  const load = () =>
    api.shares().then(
      (r) => {
        setShares(r.shares)
        setNext(r.next)
      },
      (e) => toast.error(e.message),
    )
  const more = () =>
    api.shares(next).then(
      (r) => {
        setShares((xs) => [...xs, ...r.shares])
        setNext(r.next)
      },
      (e) => toast.error(e.message),
    )
  useEffect(() => {
    load()
  }, []) // eslint-disable-line react-hooks/exhaustive-deps
  const revoke = async (s) => {
    const ok = await confirm({ title: t("share.revokeTitle"), body: t("settings.data.revokeBody", { title: s.chatTitle || s.title }), confirmLabel: t("share.revoke"), danger: true })
    if (!ok) return
    try {
      await api.revokeShare(s.token)
      setShares((xs) => xs.filter((x) => x.token !== s.token))
      toast.success(t("share.toastRevoked"))
    } catch (e) {
      toast.error(e.message)
    }
  }
  const deleteAll = async () => {
    const ok = await confirm({
      title: t("settings.data.deleteAllTitle"),
      body: t("settings.data.deleteAllBody"),
      confirmLabel: t("settings.data.deleteAll"),
      danger: true,
      typed: t("settings.data.deleteAllPhrase"),
    })
    if (!ok) return
    try {
      const r = await api.deleteAllChats()
      toast.success(t("settings.data.deletedN", { count: r.deleted }))
      setShares([])
      onChatsChanged()
      navigate("/")
    } catch (e) {
      toast.error(e.message)
    }
  }
  return (
    <div className="set-pane">
      <p className="set-row-desc set-admin-note" role="note">
        {t("settings.data.adminAccess")}
      </p>
      <div className="set-block">
        <div className="set-row-title">{t("settings.data.sharedLinks")}</div>
        {shares === null ? (
          <div className="skeleton line" style={{ height: 40 }} />
        ) : shares.length === 0 ? (
          <p className="set-row-desc">{t("settings.data.noShares")}</p>
        ) : (
          <ul className="share-list">
            {shares.map((s) => (
              <li key={s.token}>
                <IconLink size={15} />
                <span className="share-list-text">
                  <span className="share-list-title">{s.chatTitle || s.title}</span>
                  <span className="share-list-date">{fmtDateTime(s.createdAt)}</span>
                </span>
                <a className="icon-btn sm" href={`/s/${s.token}`} target="_blank" rel="noopener noreferrer" aria-label={t("settings.data.openLink")}>
                  <IconExternal size={15} />
                </a>
                <button className="btn ghost sm" onClick={() => revoke(s)}>
                  {t("share.revoke")}
                </button>
              </li>
            ))}
          </ul>
        )}
        {next && (
          <button className="btn ghost sm" onClick={more}>
            {t("settings.data.moreLinks")}
          </button>
        )}
      </div>
      <Row title={t("settings.data.export")} desc={t("settings.data.exportDesc")}>
        <div className="set-inline">
          <a className="btn ghost sm" href={api.exportUrl("md")} download>
            <IconDownload size={14} /> Markdown
          </a>
          <a className="btn ghost sm" href={api.exportUrl("json")} download>
            <IconDownload size={14} /> JSON
          </a>
        </div>
      </Row>
      <div className="set-danger">
        <Row title={t("settings.data.deleteAllRow")} desc={t("settings.data.deleteAllDesc")}>
          <button className="btn danger-outline sm" onClick={deleteAll}>
            <IconTrash size={14} /> {t("settings.data.deleteAll")}
          </button>
        </Row>
      </div>
    </div>
  )
}

function About() {
  const t = useT()
  return (
    <div className="set-pane about">
      <p className="about-lead">
        <Trans k="settings.about.lead" components={{ b: <strong /> }} />
      </p>
      <h3>{t("settings.about.sources")}</h3>
      <ul className="about-sources">
        <li>
          <strong>vbpl.vn</strong> – {t("settings.about.srcVbpl")}
        </li>
        <li>
          <strong>trav.gov.vn</strong> – {t("settings.about.srcTrav")}
        </li>
        <li>
          <strong>federalregister.gov / govinfo.gov</strong> – {t("settings.about.srcUs")}
        </li>
        <li>{t("settings.about.srcOther")}</li>
      </ul>
      <h3>{t("settings.about.model")}</h3>
      <div className="about-model">
        <span className="about-model-name">{t("settings.about.modelName")}</span>
      </div>
      <h3>{t("settings.about.notes")}</h3>
      <p className="about-disclaimer">{t("settings.about.disclaimer")}</p>
    </div>
  )
}

export default function SettingsDialog({ tab, onTab, onClose, onLoggedOut, onChatsChanged }) {
  const t = useT()
  const open = !!tab
  const current = TABS.find((t) => t.k === tab) || TABS[0]
  return (
    <Dialog open={open} onClose={onClose} className="settings-dialog" labelledBy="settings-title">
      <div className="settings">
        <nav className="settings-nav" aria-label={t("settings.sections")}>
          <h2 id="settings-title" className="settings-title">
            {t("settings.title")}
          </h2>
          <div role="tablist" aria-orientation="vertical">
            {TABS.map((tab_) => (
              <button
                key={tab_.k}
                role="tab"
                id={`tab-${tab_.k}`}
                aria-selected={current.k === tab_.k}
                aria-controls={`pane-${tab_.k}`}
                className={`settings-tab ${current.k === tab_.k ? "on" : ""}`}
                onClick={() => onTab(tab_.k)}
                onKeyDown={(e) => {
                  if (e.key !== "ArrowDown" && e.key !== "ArrowUp") return
                  e.preventDefault()
                  const i = TABS.findIndex((x) => x.k === current.k)
                  const n = TABS[(i + (e.key === "ArrowDown" ? 1 : -1) + TABS.length) % TABS.length]
                  onTab(n.k)
                  document.getElementById(`tab-${n.k}`)?.focus()
                }}
              >
                {tab_.icon}
                <span>{t(`settings.tabs.${tab_.k}`)}</span>
              </button>
            ))}
          </div>
        </nav>
        <section className="settings-main" role="tabpanel" id={`pane-${current.k}`} aria-labelledby={`tab-${current.k}`} key={current.k}>
          <header className="settings-head">
            <h3>{t(`settings.tabs.${current.k}`)}</h3>
            <button className="icon-btn sm" onClick={onClose} aria-label={t("settings.close")}>
              <IconClose size={17} />
            </button>
          </header>
          {current.k === "general" && <General />}
          {current.k === "account" && <Account onLoggedOut={onLoggedOut} />}
          {current.k === "data" && <Data onChatsChanged={onChatsChanged} />}
          {current.k === "about" && <About />}
        </section>
      </div>
    </Dialog>
  )
}

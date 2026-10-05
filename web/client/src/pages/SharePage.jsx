import "../app-styles.js"
import { useEffect, useMemo, useState } from "react"
import { api } from "../api.js"
import { buildTurns } from "../components/ChatView.jsx"
import { AssistantTurn, MessagesSkeleton, UserMessage } from "../components/Messages.jsx"
import ReportPanel from "../components/ReportPanel.jsx"
import { DocumentPanel } from "../components/Extras.jsx"
import { IconLink, IconMoon, IconSun } from "../components/Icons.jsx"
import { useThemePref, useTitle } from "../lib.js"
import { fmtDate, useT } from "../i18n.jsx"
import LanguageToggle from "../components/LanguageToggle.jsx"
import { useApp } from "../settings.jsx"
import { TechlabLogo } from "../components/Logo.jsx"

function useNoIndex() {
  useEffect(() => {
    const m = document.createElement("meta")
    m.name = "robots"
    m.content = "noindex, nofollow, noarchive"
    document.head.appendChild(m)
    return () => m.remove()
  }, [])
}

/** Public read-only snapshot at /s/<token>. */
export default function SharePage({ token, signedIn }) {
  const t = useT()
  const { changeLocale } = useApp()
  useNoIndex()
  const [state, setState] = useState({ loading: true })
  const [report, setReport] = useState(null)
  const [doc, setDoc] = useState(null)
  const [pref, setPref] = useThemePref()
  useEffect(() => {
    api.publicShare(token).then(
      (r) => setState({ share: r.share }),
      (e) => setState({ error: e.message, kind: e.code === "revoked" || e.status === 410 ? "revoked" : "notfound" }),
    )
  }, [token])
  useTitle(state.share ? t("share.docTitle", { title: state.share.title }) : state.error ? t("share.notFoundTitle") : "")
  const turns = useMemo(() => buildTurns(state.share?.messages || []), [state.share])
  const dark = pref === "dark" || (pref === "system" && window.matchMedia("(prefers-color-scheme: dark)").matches)
  return (
    <div className={`share-page ${report != null || doc ? "with-report" : ""}`}>
      <header className="share-top">
        <a className="brand" href="/">
          <TechlabLogo height={28} />
          <span className="brand-name">LegalAI</span>
        </a>
        <span className="share-badge">
          <IconLink size={13} /> <span>{t("share.badge")}</span>
        </span>
        <button className="icon-btn" onClick={() => setPref(dark ? "light" : "dark")} aria-label={dark ? t("common.themeToLight") : t("common.themeToDark")}>
          {dark ? <IconSun /> : <IconMoon />}
        </button>
        <LanguageToggle className="share-lang" onChange={signedIn ? changeLocale : undefined} />
        <a className="btn primary sm" href="/">
          {signedIn ? t("share.openApp") : t("share.tryApp")}
        </a>
      </header>
      <div className="share-body">
        <main className="share-main">
          {state.loading ? (
            <div className="chat-col">
              <MessagesSkeleton />
            </div>
          ) : state.error ? (
            <div className="state-page">
              <span className="state-code">{state.kind === "revoked" ? "410" : "404"}</span>
              <h1>{state.kind === "revoked" ? t("share.revokedTitle") : t("share.notFoundTitle")}</h1>
              <p>{state.kind === "revoked" ? t("share.revokedBody") : t("share.notFoundBody")}</p>
              <a className="btn primary" href="/">
                {t("common.home")}
              </a>
            </div>
          ) : (
            <div className="chat-col">
              <div className="share-head">
                <h1 data-source="user">{state.share.title}</h1>
                <p>{t("share.sharedOn", { date: fmtDate(state.share.createdAt) })}</p>
              </div>
              <div className="messages">
                {turns.map((tn, i) => (
                  <div className="turn" key={i}>
                    {tn.user && (
                      <UserMessage
                        msg={tn.user}
                        readOnly
                        scope={{ token }}
                        openDocId={doc?.id}
                        onPreviewDoc={(a, opts = {}) => {
                          setReport(null)
                          const view = opts.view || "preview"
                          setDoc((d) => (d?.id === a.id && (d.view || "preview") === view ? null : { ...a, ...opts, view }))
                        }}
                      />
                    )}
                    {tn.assistant.length > 0 && (
                      <AssistantTurn
                        messages={tn.assistant}
                        readOnly
                        active={false}
                        isLast={false}
                        grounding={state.share.grounding?.[i] ?? null}
                        scope={{ token }}
                        onPreviewDoc={(a, opts = {}) => {
                          setReport(null)
                          const view = opts.view || "preview"
                          setDoc((d) => (d?.id === a.id && (d.view || "preview") === view ? null : { ...a, ...opts, view }))
                        }}
                        openDocId={doc?.id}
                        reportOpen={report === i}
                        onOpenReport={() => {
                          setDoc(null)
                          setReport((r) => (r === i ? null : i))
                        }}
                      />
                    )}
                  </div>
                ))}
              </div>
              <p className="share-end">{t("share.end")}</p>
            </div>
          )}
        </main>
        <DocumentPanel artifact={doc} scope={{ token }} onClose={() => setDoc(null)} />
        <ReportPanel open={report != null} messages={report != null ? turns[report]?.assistant || [] : []} streaming={false} onClose={() => setReport(null)} scope={{ token }} />
      </div>
    </div>
  )
}

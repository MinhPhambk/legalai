// Admin-only: every user's chat history (list + read-only viewer) and the access log of those views.
import "../app-styles.js"
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../api.js"
import { navigate, relTime, useTitle } from "../lib.js"
import { fmtDateTime, useT } from "../i18n.jsx"
import { Pager, useQueryState, useToast } from "../components/ui.jsx"
import { IconLeft, IconSearch, IconShield } from "../components/Icons.jsx"
import { buildTurns } from "../components/ChatView.jsx"
import { AssistantTurn, MessagesSkeleton, UserMessage } from "../components/Messages.jsx"
import ReportPanel from "../components/ReportPanel.jsx"
import { DocumentPanel } from "../components/Extras.jsx"
import { useApp } from "../settings.jsx"

/** Admin → "Chat history": all chats across users, filters + paging kept in the URL (h* params). */
export function AdminChatHistory() {
  const t = useT()
  const [qs, setQs] = useQueryState({ hq: "", huser: "", hfrom: "", hto: "", hpage: "1", hsize: "20" })
  const [data, setData] = useState(null)
  const [err, setErr] = useState(false)
  const [draft, setDraft] = useState({ q: qs.hq, user: qs.huser })
  const load = useCallback(() => {
    setErr(false)
    api.admin.chats({ q: qs.hq, user: qs.huser, from: qs.hfrom, to: qs.hto, page: qs.hpage, size: qs.hsize }).then(setData, () => setErr(true))
  }, [qs.hq, qs.huser, qs.hfrom, qs.hto, qs.hpage, qs.hsize])
  useEffect(() => {
    load()
  }, [load])
  // Text filters apply shortly after typing stops.
  useEffect(() => {
    const timer = setTimeout(() => {
      if (draft.q !== qs.hq || draft.user !== qs.huser) setQs({ hq: draft.q, huser: draft.user, hpage: "1" })
    }, 300)
    return () => clearTimeout(timer)
  }, [draft]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <section className="admin-section" id="admin-chats">
      <div className="admin-section-head">
        <h2>{t("adminChats.title")}</h2>
      </div>
      <p className="set-row-desc adm-note">{t("adminChats.desc")}</p>
      <div className="adm-filters">
        <label className="admin-search">
          <IconSearch size={15} />
          <input value={draft.q} onChange={(e) => setDraft((d) => ({ ...d, q: e.target.value }))} placeholder={t("adminChats.keyword")} aria-label={t("adminChats.keyword")} />
        </label>
        <label className="admin-search">
          <input value={draft.user} onChange={(e) => setDraft((d) => ({ ...d, user: e.target.value }))} placeholder={t("adminChats.user")} aria-label={t("adminChats.user")} />
        </label>
        <label className="adm-date">
          <span>{t("adminChats.from")}</span>
          <input type="date" value={qs.hfrom} onChange={(e) => setQs({ hfrom: e.target.value, hpage: "1" })} />
        </label>
        <label className="adm-date">
          <span>{t("adminChats.to")}</span>
          <input type="date" value={qs.hto} onChange={(e) => setQs({ hto: e.target.value, hpage: "1" })} />
        </label>
      </div>
      <div className="table-wrap admin-table">
        <table>
          <thead>
            <tr>
              <th>{t("adminChats.col.user")}</th>
              <th>{t("adminChats.col.title")}</th>
              <th>{t("adminChats.col.created")}</th>
              <th>{t("adminChats.col.updated")}</th>
              <th className="num">{t("adminChats.col.turns")}</th>
              <th>{t("adminChats.col.flags")}</th>
            </tr>
          </thead>
          <tbody>
            {data === null && !err
              ? [1, 2, 3].map((i) => (
                  <tr key={i}>
                    <td colSpan={6}>
                      <div className="skeleton line" />
                    </td>
                  </tr>
                ))
              : (data?.chats || []).map((c) => (
                  <tr key={c.id} className="adm-chat-row" onClick={() => navigate(`/admin/chats/${c.id}`)}>
                    <td className="u-email">{c.ownerEmail}</td>
                    <td>
                      <a
                        href={`/admin/chats/${c.id}`}
                        className="adm-chat-title"
                        onClick={(e) => {
                          e.preventDefault()
                          e.stopPropagation()
                          navigate(`/admin/chats/${c.id}`)
                        }}
                      >
                        {c.title || t("chat.newChat")}
                      </a>
                    </td>
                    <td className="muted">{fmtDateTime(c.createdAt)}</td>
                    <td className="muted">{relTime(c.updatedAt)}</td>
                    <td className="num">{c.turns}</td>
                    <td>
                      {c.hasDocuments && <span className="status-badge">{t("adminChats.docs")}</span>} {c.hasEscalation && <span className="status-badge">{t("adminChats.escalated")}</span>}
                    </td>
                  </tr>
                ))}
            {data?.chats?.length === 0 && (
              <tr>
                <td colSpan={6} className="muted">
                  {t("adminChats.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {err && (
        <div className="list-sentinel" role="alert">
          {t("admin.loadFailed")}{" "}
          <button className="link-btn" onClick={load}>
            {t("common.retry")}
          </button>
        </div>
      )}
      {data && <Pager page={data.page} pages={data.pages} size={data.size} total={data.total} unit="adminChats.count" onPage={(p) => setQs({ hpage: String(p) })} onSize={(n) => setQs({ hsize: String(n), hpage: "1" })} />}
    </section>
  )
}

/** Admin → "Access log": who viewed / downloaded which user's chat, when. */
export function AdminAccessLog() {
  const t = useT()
  const [qs, setQs] = useQueryState({ lpage: "1", lsize: "20" })
  const [data, setData] = useState(null)
  useEffect(() => {
    api.admin.accessLog(qs.lpage, qs.lsize).then(setData, () => setData({ entries: [], total: 0, page: 1, pages: 1, size: 20 }))
  }, [qs.lpage, qs.lsize])
  return (
    <section className="admin-section" id="admin-access-log">
      <div className="admin-section-head">
        <h2>{t("accessLog.title")}</h2>
      </div>
      <p className="set-row-desc adm-note">{t("accessLog.desc")}</p>
      <div className="table-wrap admin-table">
        <table>
          <thead>
            <tr>
              <th>{t("accessLog.col.time")}</th>
              <th>{t("accessLog.col.admin")}</th>
              <th>{t("accessLog.col.action")}</th>
              <th>{t("accessLog.col.owner")}</th>
              <th>{t("accessLog.col.chat")}</th>
            </tr>
          </thead>
          <tbody>
            {data === null
              ? [1, 2].map((i) => (
                  <tr key={i}>
                    <td colSpan={5}>
                      <div className="skeleton line" />
                    </td>
                  </tr>
                ))
              : data.entries.map((e) => (
                  <tr key={e.id}>
                    <td className="muted">{fmtDateTime(e.at)}</td>
                    <td className="u-email">{e.adminEmail || "—"}</td>
                    <td>
                      <span className="status-badge">{t(`accessLog.action.${e.action}`)}</span>
                    </td>
                    <td className="u-email">{e.ownerEmail || "—"}</td>
                    <td>{e.chatTitle ? <a href={`/admin/chats/${e.chatId}`} onClick={(ev) => (ev.preventDefault(), navigate(`/admin/chats/${e.chatId}`))}>{e.chatTitle}</a> : <span className="muted">{e.chatTitleAtView ? `${e.chatTitleAtView} ` : ""}{t("accessLog.deleted")}</span>}</td>
                  </tr>
                ))}
            {data?.entries?.length === 0 && (
              <tr>
                <td colSpan={5} className="muted">
                  {t("accessLog.empty")}
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      {data && <Pager page={data.page} pages={data.pages} size={data.size} total={data.total} unit="accessLog.count" onPage={(p) => setQs({ lpage: String(p) })} onSize={(n) => setQs({ lsize: String(n), lpage: "1" })} />}
    </section>
  )
}

/** /admin/chats/:id – read-only viewer (same rendering as the chat, no composer / edit / share / delete). */
export default function AdminChatViewer({ chatId }) {
  const t = useT()
  const toast = useToast()
  const { settings } = useApp()
  const [state, setState] = useState({ loading: true })
  const [branch, setBranch] = useState(null)
  const [report, setReport] = useState(null)
  const [doc, setDoc] = useState(null)
  useEffect(() => {
    setState((s) => ({ ...s, loading: true }))
    api.admin.chatMessages(chatId, branch).then(
      (r) => setState({ data: r }),
      (e) => setState({ error: e.message, status: e.status }),
    )
  }, [chatId, branch])
  const d = state.data
  useTitle(d ? t("adminChats.viewerTitle", { title: d.chat?.title || "" }) : "")
  const turns = useMemo(() => buildTurns(d?.messages || []), [d])
  const vByTurn = useMemo(() => new Map((d?.versions || []).map((v) => [v.turn, v])), [d])
  const offset = d?.turnOffset || 0
  const scope = { chatId }
  const preview = (a, opts = {}) => {
    setReport(null)
    const view = opts.view || "preview"
    setDoc((x) => (x?.id === a.id && (x.view || "preview") === view ? null : { ...a, ...opts, view }))
  }
  const loadOlder = async () => {
    try {
      const r = await api.admin.chatMessages(chatId, branch, offset)
      setState({ data: { ...d, messages: [...r.messages, ...d.messages], turnOffset: r.turnOffset, hasMore: r.hasMore } })
    } catch (e) {
      toast.error(e.message)
    }
  }
  return (
    <div className={`share-page admin-viewer ${report != null || doc ? "with-report" : ""}`}>
      <header className="share-top">
        <a
          className="btn ghost sm"
          href="/admin/chats"
          onClick={(e) => {
            e.preventDefault()
            navigate("/admin/chats")
          }}
        >
          <IconLeft size={15} /> {t("adminChats.back")}
        </a>
        <span className="share-badge adm-ro-badge" role="note">
          <IconShield size={13} /> <span>{t("adminChats.banner", { email: d?.owner?.email || "…" })}</span>
        </span>
      </header>
      <div className="share-body">
        <main className="share-main">
          {state.loading && !d ? (
            <div className="chat-col">
              <MessagesSkeleton />
            </div>
          ) : state.error ? (
            <div className="state-page">
              <span className="state-code">{state.status || 404}</span>
              <h1>{state.error}</h1>
            </div>
          ) : (
            <div className="chat-col">
              <div className="share-head">
                <h1 data-source="user">{d.chat?.title}</h1>
                <p>
                  {d.owner?.email} · {fmtDateTime(d.chat?.createdAt)}
                </p>
              </div>
              {d.hasMore && (
                <button className="btn ghost sm adm-older" onClick={loadOlder}>
                  {t("adminChats.older")}
                </button>
              )}
              <div className="messages">
                {turns.map((tn, i) => {
                  const k = offset + i
                  const v = vByTurn.get(k)
                  return (
                    <div className="turn" key={k}>
                      {tn.user && (
                        <UserMessage msg={tn.user} readOnly versions={v?.kind === "edit" ? v : null} onSwitch={setBranch} scope={scope} openDocId={doc?.id} onPreviewDoc={preview} />
                      )}
                      {tn.assistant.length > 0 && (
                        <AssistantTurn
                          messages={tn.assistant}
                          readOnly
                          active={false}
                          isLast={false}
                          versions={v && v.kind !== "edit" ? v : null}
                          onSwitch={setBranch}
                          showReasoning={settings.showReasoning}
                          grounding={d.grounding?.[k] ?? null}
                          scope={scope}
                          onPreviewDoc={preview}
                          openDocId={doc?.id}
                          reportOpen={report === i}
                          onOpenReport={() => {
                            setDoc(null)
                            setReport((r) => (r === i ? null : i))
                          }}
                        />
                      )}
                    </div>
                  )
                })}
              </div>
              <p className="share-end">{t("adminChats.end")}</p>
            </div>
          )}
        </main>
        <DocumentPanel artifact={doc} scope={scope} onClose={() => setDoc(null)} />
        <ReportPanel open={report != null} messages={report != null ? turns[report]?.assistant || [] : []} streaming={false} onClose={() => setReport(null)} scope={scope} />
      </div>
    </div>
  )
}

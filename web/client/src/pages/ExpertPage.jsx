import "../app-styles.js"
import { useCallback, useEffect, useMemo, useState } from "react"
import { api } from "../api.js"
import { navigate, relTime, renderMarkdown, useTitle } from "../lib.js"

/** Reason of a request: server code (localized) or the assistant's own words (data). */
function Reason({ e }) {
  const t = useT()
  if (e.reasonCode === "user_request") return t("expert.reasonCode.user_request")
  return e.reason ? <Data v={e.reason} /> : null
}
/** Case title: chat title / reason (data) or the localized fallback. */
function CaseTitle({ e }) {
  const t = useT()
  if (e.chatTitle) return <Data v={e.chatTitle} />
  if (e.reason) return <Reason e={e} />
  return t("expert.case.untitled")
}
/** Summary of a request made from the chat (server-written parts, localized headings) or the agent's markdown. */
function Summary({ e }) {
  const t = useT()
  const p = e.summaryParts
  if (!p) return <div className="md case-summary" data-source="summary" dangerouslySetInnerHTML={{ __html: renderMarkdown(e.summary || "") }} />
  return (
    <div className="case-summary">
      {p.note && (
        <p>
          <b>{t("expert.summary.note")}:</b> <Data v={p.note} />
        </p>
      )}
      <p>
        <b>{t("expert.summary.question")}:</b> {p.question ? <Data v={p.question} /> : t("expert.summary.attachmentOnly")}
      </p>
      {p.attachments?.length > 0 && (
        <p>
          <b>{t("expert.summary.attachments")}:</b> <Data v={p.attachments.join(", ")} lang={null} />
        </p>
      )}
      <p>
        <b>{t("expert.summary.answer")}:</b> {p.noAnswer ? t("expert.summary.noAnswer") : null}
      </p>
      {p.answer && <div className="md" data-source="answer" dangerouslySetInnerHTML={{ __html: renderMarkdown(p.answer) }} />}
    </div>
  )
}
import { useT } from "../i18n.jsx"
import { ESC_CLOSED, ESC_IN_PROGRESS, ESC_NEW, ESC_STATUSES, LEVEL_KEY } from "../codes.js"
import { buildTurns } from "../components/ChatView.jsx"
import { AssistantTurn, UserMessage } from "../components/Messages.jsx"
import { ExpertReply, UrgencyBadge, statusLabel } from "../components/Extras.jsx"
import { Pager, useConfirm, useQueryState, useToast } from "../components/ui.jsx"
import { Data } from "../components/DataText.jsx"
import { IconLeft, IconRefresh, IconShield, Spinner } from "../components/Icons.jsx"

const FILTERS = ["open", ...ESC_STATUSES, ""]
const filterLabel = (t, k) => (k === "open" ? t("expert.filter.open") : k === "" ? t("expert.filter.all") : statusLabel(k))
const STATUS_CLASS = { [ESC_NEW]: "s-new", [ESC_CLOSED]: "s-closed" }

function Case({ id, me, onChanged }) {
  const toast = useToast()
  const t = useT()
  const confirm = useConfirm()
  const [data, setData] = useState(null)
  const [reply, setReply] = useState("")
  const [busy, setBusy] = useState("")
  const [preview, setPreview] = useState(false)
  const load = useCallback(() => api.expert.get(id).then(setData, (e) => toast.error(e.message)), [id, toast])
  useEffect(() => {
    setData(null)
    setReply("")
    setPreview(false)
    load()
  }, [load])
  const turns = useMemo(() => buildTurns(data?.messages || []), [data])
  if (!data)
    return (
      <div className="case-inner">
        {[40, 70, 90, 60].map((w, i) => (
          <div key={i} className="skeleton line" style={{ width: `${w}%`, height: i === 0 ? 24 : 14 }} />
        ))}
      </div>
    )
  const e = data.escalation
  const act = async (label, fn, msg) => {
    setBusy(label)
    try {
      await fn()
      await load()
      onChanged()
      if (msg) toast.success(msg)
    } catch (err) {
      toast.error(err.message)
    } finally {
      setBusy("")
    }
  }
  const send = () =>
    act(
      "reply",
      async () => {
        await api.expert.reply(e.id, reply.trim())
        setReply("")
      },
      t("expert.case.replySent"),
    )
  return (
    <div className="case-inner">
      <header className="case-head">
        <div className="queue-row">
          <span className="queue-id">{e.id}</span>
          <span className={`st-badge ${STATUS_CLASS[e.status] || ""}`}>{statusLabel(e.status)}</span>
          <UrgencyBadge u={e.urgency} />
          <span className="queue-sub">{e.origin === "manual" ? t("expert.origin.user") : t("expert.origin.agentCap")}</span>
        </div>
        <h2>
          <CaseTitle e={e} />
        </h2>
        <div className="queue-sub">
          {e.owner ? <Data v={e.owner} lang={null} /> : t("expert.case.unknownOwner")} · {t("expert.case.created", { when: relTime(e.createdAt) })} · {t("expert.case.updated", { when: relTime(e.updatedAt) })}
        </div>
      </header>
      <div className="case-controls">
        {e.assigneeId !== me.id && (
          <button className="btn primary sm" onClick={() => act("claim", () => api.expert.claim(e.id), t("expert.case.claimed"))} disabled={!!busy}>
            {busy === "claim" ? <Spinner size={13} /> : <IconShield size={14} />} {t("expert.case.claim")}
          </button>
        )}
        <label className="sr-only" htmlFor="case-assignee">
          {t("expert.case.assignee")}
        </label>
        <select id="case-assignee" value={e.assigneeId || ""} onChange={(ev) => act("assign", () => api.expert.update(e.id, { assigneeId: ev.target.value || null }), t("expert.case.assigned"))}>
          <option value="">{t("expert.case.unassignedOption")}</option>
          {data.experts.map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
              {x.id === me.id ? ` ${t("expert.case.me")}` : ""}
            </option>
          ))}
        </select>
        <label className="sr-only" htmlFor="case-status">
          {t("expert.case.status")}
        </label>
        <select
          id="case-status"
          value={e.status}
          onChange={async (ev) => {
            const v = ev.target.value
            if (v === ESC_CLOSED && !(await confirm({ title: t("expert.case.closeTitle"), body: t("expert.case.closeBody"), confirmLabel: t("expert.case.closeConfirm") }))) return
            act("status", () => api.expert.update(e.id, { status: v }), t("expert.case.statusChanged", { status: statusLabel(v) }))
          }}
        >
          {ESC_STATUSES.map((s) => (
            <option key={s} value={s}>
              {statusLabel(s)}
            </option>
          ))}
        </select>
        {e.chatId && <span className="queue-sub">{t("expert.case.assigneeShort", { name: e.assignee || t("expert.case.none") })}</span>}
      </div>
      <section className="case-box">
        <h3>{t("expert.case.request")}</h3>
        <dl className="case-grid">
          <div>
            <dt>{t("expert.case.reason")}</dt>
            <dd>{e.reason ? <Reason e={e} /> : "—"}</dd>
          </div>
          <div>
            <dt>{t("expert.case.topic")}</dt>
            <dd>{e.topic ? <Data v={e.topic} /> : "—"}</dd>
          </div>
          <div>
            <dt>{t("expert.case.deadline")}</dt>
            <dd>{e.deadline ? <Data v={e.deadline} /> : "—"}</dd>
          </div>
          <div>
            <dt>{t("expert.case.machineConfidence")}</dt>
            <dd>{e.confidence ? (LEVEL_KEY[e.confidence] ? t(`confidence.level.${LEVEL_KEY[e.confidence]}`) : e.confidence) : t("expert.case.unverified")}</dd>
          </div>
        </dl>
        <h3 style={{ marginTop: 14 }}>{t("expert.case.summary")}</h3>
        <Summary e={e} />
        {e.sources.length > 0 && (
          <>
            <h3 style={{ marginTop: 14 }}>{t("expert.case.sources")}</h3>
            <ul className="case-sources">
              {e.sources.map((u) => (
                <li key={u}>
                  <a href={u} target="_blank" rel="noopener noreferrer nofollow" data-source="url">
                    {u}
                  </a>
                </li>
              ))}
            </ul>
          </>
        )}
      </section>
      {e.replies.length > 0 && (
        <section className="case-box">
          <h3>{t("expert.case.replies")}</h3>
          {e.replies.map((r) => (
            <ExpertReply key={r.id} r={r} escalationId={e.id} />
          ))}
        </section>
      )}
      <section className="case-box reply-box">
        <h3>{t("expert.case.replyTitle")}</h3>
        {preview ? (
          <div className="md" dangerouslySetInnerHTML={{ __html: renderMarkdown(reply || `_${t("expert.case.emptyPreview")}_`) }} />
        ) : (
          <textarea
            className="input textarea"
            value={reply}
            maxLength={20000}
            onChange={(ev) => setReply(ev.target.value)}
            placeholder={t("expert.case.replyPlaceholder")}
            onKeyDown={(ev) => ev.key === "Enter" && (ev.ctrlKey || ev.metaKey) && reply.trim() && send()}
          />
        )}
        <div className="reply-actions">
          <span className="reply-hint">{t("expert.case.replyHint")}</span>
          <button className="btn ghost sm" onClick={() => setPreview((p) => !p)}>
            {preview ? t("common.edit") : t("docs.preview")}
          </button>
          <button className="btn primary sm" onClick={send} disabled={!reply.trim() || !!busy}>
            {busy === "reply" ? <Spinner size={13} /> : null} {t("expert.case.sendReply")}
          </button>
        </div>
      </section>
      <section className="case-box">
        <h3>{t("expert.case.conversation")}</h3>
        {turns.length === 0 ? (
          <p className="queue-sub">{t("expert.case.conversationMissing")}</p>
        ) : (
          <div className="case-convo">
            {turns.map((tn, i) => (
              <div className="turn" key={i}>
                {tn.user && <UserMessage msg={tn.user} readOnly />}
                {tn.assistant.length > 0 && (
                  <AssistantTurn messages={tn.assistant} readOnly active={false} isLast={false} grounding={data.grounding?.[i] ?? null} scope={{ chatId: e.chatId }} />
                )}
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  )
}

export default function ExpertPage({ me }) {
  const toast = useToast()
  const t = useT()
  useTitle(t("expert.docTitle"))
  // Filter, page and the open case live in the URL (?status=&page=&size=&id=)
  const [qs, setQs] = useQueryState({ status: "open", page: "1", size: "20", id: "" })
  const filter = qs.status
  const setFilter = (v) => setQs({ status: v, page: "1" })
  const [list, setList] = useState(null)
  const [counts, setCounts] = useState({})
  const [meta, setMeta] = useState({ total: 0, pages: 1 })
  const [listErr, setListErr] = useState(false)
  const sel = qs.id || null
  const load = useCallback(
    () =>
      api.expert.list({ ...(filter ? { status: filter } : {}), page: qs.page, size: qs.size }).then(
        (r) => {
          setList(r.escalations)
          setCounts(r.counts || {})
          setMeta({ total: r.total || 0, pages: r.pages || 1 })
          setListErr(false)
        },
        () => {
          setListErr(true)
          setList((l) => l || [])
        },
      ),
    [filter, qs.page, qs.size],
  )
  useEffect(() => {
    api.expert.seen().catch(() => {})
  }, [])
  useEffect(() => {
    load()
    const timer = setInterval(load, 15000)
    return () => clearInterval(timer)
  }, [load])
  const open = (id) => setQs({ id: id || "" })
  const countOf = (k) => (k === "open" ? (counts[ESC_NEW] || 0) + (counts[ESC_IN_PROGRESS] || 0) : k ? counts[k] || 0 : Object.values(counts).reduce((a, b) => a + b, 0))
  return (
    <div className="expert">
      <header className="admin-top">
        <button className="btn ghost sm" onClick={() => (sel && window.innerWidth < 900 ? open(null) : navigate("/"))}>
          <IconLeft size={15} /> <span>{sel && window.innerWidth < 900 ? t("expert.backToList") : t("admin.backToChat")}</span>
        </button>
        <h1>
          <IconShield size={20} /> {t("expert.navTitle")}
        </h1>
        <button className="icon-btn sm" onClick={load} aria-label={t("common.refresh")} title={t("common.refresh")}>
          <IconRefresh size={15} />
        </button>
        <span className="admin-me">{me.displayName || me.email}</span>
      </header>
      <div className={`expert-body ${sel ? "has-case" : ""}`}>
        <aside className="queue" aria-label={t("expert.queueLabel")}>
          <div className="queue-filters" role="tablist">
            {FILTERS.map((k) => (
              <button key={k || "all"} role="tab" aria-selected={filter === k} className={`chip-btn ${filter === k ? "on" : ""}`} onClick={() => setFilter(k)}>
                {filterLabel(t, k)} <span className="n">{countOf(k)}</span>
              </button>
            ))}
          </div>
          <ul className="queue-list">
            {list === null
              ? [1, 2, 3].map((i) => (
                  <li key={i} style={{ padding: 12 }}>
                    <div className="skeleton line" />
                  </li>
                ))
              : list.map((e, i) => (
                  <li key={e.id}>
                    <button className={`queue-item ${sel === e.id ? "sel" : ""}`} style={{ animationDelay: `${i * 30}ms` }} onClick={() => open(e.id)}>
                      <span className="queue-row">
                        <span className={`st-badge ${STATUS_CLASS[e.status] || ""}`}>{statusLabel(e.status)}</span>
                        <UrgencyBadge u={e.urgency} />
                        {e.deadline && (
                          <span className="queue-sub">
                            {t("expert.dueLabel")} <Data v={e.deadline} />
                          </span>
                        )}
                      </span>
                      <span className="queue-title">
                        <CaseTitle e={e} />
                      </span>
                      <span className="queue-sub">
                        {e.id} · {e.owner ? <Data v={e.owner} lang={null} /> : "—"} · {relTime(e.createdAt)}
                        {e.replyCount ? ` · ${t("expert.replies", { count: e.replyCount })}` : ""}
                        {e.assignee ? (
                          <>
                            {" · "}
                            <Data v={e.assignee} lang={null} />
                          </>
                        ) : (
                          ` · ${t("expert.unassigned")}`
                        )}
                      </span>
                    </button>
                  </li>
                ))}
            {list?.length === 0 && !listErr && <li className="case-empty">{t("expert.empty")}</li>}
          </ul>
          {listErr && (
            <div className="list-sentinel" role="alert">
              {t("expert.loadFailed")} <button className="link-btn" onClick={load}>{t("common.retry")}</button>
            </div>
          )}
          <div style={{ padding: "0 12px 12px" }}>
            <Pager page={Number(qs.page) || 1} pages={meta.pages} size={Number(qs.size) || 20} total={meta.total} unit="expert.requestsCount" onPage={(p) => setQs({ page: String(p) })} onSize={(n) => setQs({ size: String(n), page: "1" })} />
          </div>
        </aside>
        <main className="case">{sel ? <Case key={sel} id={sel} me={me} onChanged={load} /> : <div className="case-empty">{t("expert.pick")}</div>}</main>
      </div>
    </div>
  )
}

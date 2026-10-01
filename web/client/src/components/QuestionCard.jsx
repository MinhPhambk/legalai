// Clarifying-question card: the agent's "question" tool (multiple choice, one or more questions).
// Pending + answerable → interactive (pills, single / multi select, free-text "Khác…", stepper for several
// questions, "Bỏ qua"); otherwise a compact read-only summary. Renders whatever the model sends.
import { useEffect, useId, useMemo, useRef, useState } from "react"
import { useT } from "../i18n.jsx"
import { IconCheck, IconQuestion, Spinner } from "./Icons.jsx"

const REC_RE = /\s*\((khuyến nghị|khuyên dùng|recommended)\)\s*$/i // i18n-ignore (model output marker, not UI text)
const optLabel = (label) => String(label || "").replace(REC_RE, "")
const isRec = (label) => REC_RE.test(String(label || ""))

/** Tab labels: the header, unless headers repeat or are empty – then a short start of the question text. */
function tabLabels(questions) {
  const heads = questions.map((q) => (q.header || "").trim())
  const dup = (h) => !h || heads.filter((x) => x.toLowerCase() === h.toLowerCase()).length > 1
  return questions.map((q, i) => {
    if (!dup(heads[i])) return heads[i]
    const text = String(q.question || "").replace(/\s+/g, " ").trim()
    return text.length > 24 ? text.slice(0, 23).trimEnd() + "…" : text
  })
}

/** Answer array of one question from its UI state (selected labels in option order + free text). */
const answerOf = (q, st) => {
  const out = q.options.filter((o) => st.sel.has(o.label)).map((o) => o.label)
  if (st.custom.trim()) out.push(st.custom.trim())
  return out
}

export default function QuestionCard({ part, interactive, readOnlyNote, onReply, onReject, onDraft }) {
  const t = useT()
  const questions = part.questions || []
  const qstate = part.qstate || "pending"
  const live = interactive && qstate === "pending" && !!part.requestID
  if (qstate !== "pending") return <QuestionSummary part={part} />
  if (!interactive && questions.length) return <QuestionPreview part={part} note={readOnlyNote ?? t("question.waitingUser")} />
  if (!live)
    return (
      <div className="qcard is-loading" role="status">
        <Spinner size={14} /> <span>{t("question.preparing")}</span>
      </div>
    )
  return <QuestionForm key={part.requestID} part={part} onReply={onReply} onReject={onReject} onDraft={onDraft} />
}

function QuestionForm({ part, onReply, onReject, onDraft }) {
  const t = useT()
  const uid = useId()
  const questions = part.questions
  const total = questions.length
  const [idx, setIdx] = useState(0)
  const [state, setState] = useState(() => questions.map(() => ({ sel: new Set(), custom: "" })))
  const [sending, setSending] = useState(false)
  const rootRef = useRef(null)
  const optRefs = useRef([])
  const q = questions[idx]
  const st = state[idx]
  const answers = useMemo(() => questions.map((qq, i) => answerOf(qq, state[i])), [questions, state])
  const labels = useMemo(() => tabLabels(questions), [questions])
  useEffect(() => {
    onDraft?.(answers)
  }, [answers]) // eslint-disable-line react-hooks/exhaustive-deps

  // Focus the card when it appears (first / recommended option) and when the step changes.
  const firstRender = useRef(true)
  useEffect(() => {
    const opts = optRefs.current.filter(Boolean)
    const target = opts.find((b) => b.getAttribute("aria-checked") === "true") || opts[Math.max(0, q.options.findIndex((o) => isRec(o.label)))] || opts[0]
    const el = target || rootRef.current?.querySelector("input, button")
    el?.focus({ preventScroll: !firstRender.current })
    if (firstRender.current) rootRef.current?.scrollIntoView?.({ block: "nearest" })
    firstRender.current = false
  }, [idx]) // eslint-disable-line react-hooks/exhaustive-deps

  const update = (fn) => setState((s) => s.map((x, i) => (i === idx ? fn(x) : x)))
  const toggle = (label) => {
    if (sending) return
    if (q.multiple) {
      update((x) => {
        const sel = new Set(x.sel)
        sel.has(label) ? sel.delete(label) : sel.add(label)
        return { ...x, sel }
      })
      return
    }
    update(() => ({ sel: new Set([label]), custom: "" }))
    // Single choice: move on to the next question (the last one waits for "Gửi").
    if (idx < total - 1) setTimeout(() => setIdx((i) => Math.min(i + 1, total - 1)), 180)
  }
  const submit = async () => {
    if (sending) return
    setSending(true)
    const ok = await onReply?.(answers)
    if (ok === false) setSending(false)
  }
  const skip = async () => {
    if (sending) return
    setSending(true)
    const ok = await onReject?.()
    if (ok === false) setSending(false)
  }
  const next = () => (idx < total - 1 ? setIdx(idx + 1) : submit())

  const onKeyDown = (e) => {
    if (e.target.tagName === "INPUT") {
      if (e.key === "Enter" && !e.nativeEvent.isComposing) {
        e.preventDefault()
        next()
      }
      return
    }
    const opts = optRefs.current.filter(Boolean)
    const i = opts.indexOf(document.activeElement)
    if (/^[1-9]$/.test(e.key) && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const o = q.options[Number(e.key) - 1]
      if (o) {
        e.preventDefault()
        opts[Number(e.key) - 1]?.focus()
        toggle(o.label)
      }
      return
    }
    if (i >= 0 && ["ArrowDown", "ArrowRight", "ArrowUp", "ArrowLeft"].includes(e.key)) {
      e.preventDefault()
      const d = e.key === "ArrowDown" || e.key === "ArrowRight" ? 1 : -1
      const n = (i + d + opts.length) % opts.length
      opts[n].focus()
      // Radio behaviour: arrows move the selection too.
      if (!q.multiple && q.options[n]) update(() => ({ sel: new Set([q.options[n].label]), custom: "" }))
      return
    }
    if (e.key === "Enter" && i >= 0) {
      e.preventDefault()
      const o = q.options[i]
      if (o && !st.sel.has(o.label)) toggle(o.label)
      else next()
    }
  }

  const answeredCount = answers.filter((a) => a.length).length
  const qid = `${uid}-q`
  return (
    <section className="qcard" ref={rootRef} aria-labelledby={qid} onKeyDown={onKeyDown} aria-busy={sending || undefined}>
      <div className="qcard-head">
        <span className="qcard-icon" aria-hidden="true">
          <IconQuestion size={16} />
        </span>
        <span className="qcard-chip">{q.header || t("question.label")}</span>
        {total > 1 && <span className="qcard-step">{t("question.step", { n: idx + 1, total })}</span>}
      </div>
      {total > 1 && (
        <div className="qcard-tabs" role="tablist" aria-label={t("question.label")}>
          {questions.map((qq, i) => (
            <button
              key={i}
              type="button"
              role="tab"
              aria-selected={i === idx}
              className={`qcard-tab ${i === idx ? "on" : ""} ${answers[i].length ? "done" : ""}`}
              onClick={() => setIdx(i)}
              disabled={sending}
            >
              <span className="n">{answers[i].length ? <IconCheck size={12} /> : i + 1}</span>
              <span className="l" title={qq.question}>
                {labels[i] || t("question.step", { n: i + 1, total })}
              </span>
            </button>
          ))}
        </div>
      )}
      <p className="qcard-q" id={qid}>
        {q.question}
      </p>
      {q.multiple && <p className="qcard-sub">{t("question.multiHint")}</p>}
      <div className="qcard-opts" role={q.multiple ? "group" : "radiogroup"} aria-labelledby={qid}>
        {q.options.map((o, i) => {
          const on = st.sel.has(o.label)
          const rec = isRec(o.label)
          return (
            <button
              key={i}
              type="button"
              ref={(el) => (optRefs.current[i] = el)}
              role={q.multiple ? "checkbox" : "radio"}
              aria-checked={on}
              tabIndex={q.multiple || on || (!st.sel.size && i === 0) ? 0 : -1}
              className={`qopt ${on ? "on" : ""} ${rec ? "rec" : ""} ${q.multiple ? "multi" : ""}`}
              onClick={() => toggle(o.label)}
              disabled={sending}
            >
              <span className="qopt-key" aria-hidden="true">
                {on ? <IconCheck size={13} /> : i < 9 ? i + 1 : ""}
              </span>
              <span className="qopt-body">
                <span className="qopt-label">
                  {optLabel(o.label)}
                  {rec && <span className="qopt-rec">{t("question.recommended")}</span>}
                </span>
                {o.description && <span className="qopt-desc">{o.description}</span>}
              </span>
            </button>
          )
        })}
        {q.custom !== false && (
          <label className={`qopt-custom ${st.custom.trim() ? "on" : ""}`}>
            <span className="sr-only">{t("question.otherLabel")}</span>
            <input
              type="text"
              value={st.custom}
              maxLength={500}
              placeholder={t("question.other")}
              disabled={sending}
              onChange={(e) => {
                const v = e.target.value
                update((x) => ({ sel: q.multiple ? x.sel : v.trim() ? new Set() : x.sel, custom: v }))
              }}
            />
          </label>
        )}
      </div>
      <div className="qcard-foot">
        <span className="qcard-keys" aria-hidden="true">
          {t("question.keysHint")}
        </span>
        <button type="button" className="btn ghost sm" onClick={skip} disabled={sending}>
          {t("question.skip")}
        </button>
        {idx > 0 && (
          <button type="button" className="btn ghost sm" onClick={() => setIdx(idx - 1)} disabled={sending}>
            {t("question.back")}
          </button>
        )}
        {idx < total - 1 ? (
          <button type="button" className="btn primary sm" onClick={() => setIdx(idx + 1)} disabled={sending}>
            {t("question.next")}
          </button>
        ) : (
          <button type="button" className="btn primary sm" onClick={submit} disabled={sending || (!answeredCount && total === 1)}>
            {sending ? (
              <>
                <Spinner size={12} /> {t("question.sending")}
              </>
            ) : (
              t("question.submit")
            )}
          </button>
        )}
      </div>
    </section>
  )
}

/** Pending but not answerable here (admin read-only viewer, or the request is not known yet). */
function QuestionPreview({ part, note }) {
  const t = useT()
  return (
    <section className="qcard is-readonly" aria-label={t("question.label")}>
      <div className="qcard-head">
        <span className="qcard-icon" aria-hidden="true">
          <IconQuestion size={16} />
        </span>
        <span className="qcard-chip">{t("question.label")}</span>
        <span className="qcard-step">{note}</span>
      </div>
      {part.questions.map((q, i) => (
        <div key={i} className="qcard-ro">
          <p className="qcard-q">{q.question}</p>
          <ul className="qcard-ro-opts">
            {q.options.map((o, j) => (
              <li key={j} className={isRec(o.label) ? "rec" : ""}>
                {optLabel(o.label)}
              </li>
            ))}
          </ul>
        </div>
      ))}
    </section>
  )
}

/** Answered / skipped / stopped: compact read-only summary. */
function QuestionSummary({ part }) {
  const t = useT()
  const qs = part.questions || []
  const answers = part.answers || []
  if (part.qstate !== "answered")
    return (
      <div className={`qcard-done is-${part.qstate}`} role="note">
        <IconQuestion size={15} aria-hidden="true" />
        <span>
          {part.qstate === "dismissed" ? t("question.dismissed") : t("question.stopped")}
          {qs.length > 0 && <span className="qcard-done-q"> · {qs.map((q) => q.header || q.question).join(" · ")}</span>}
        </span>
      </div>
    )
  return (
    <div className="qcard-done is-answered" role="note">
      <IconCheck size={15} aria-hidden="true" />
      <div className="qcard-done-body">
        <span className="qcard-done-title">{t("question.answered")}:</span>
        <ul>
          {qs.map((q, i) => (
            <li key={i}>
              {(qs.length > 1 || q.header) && <span className="k">{q.header || q.question}: </span>}
              <span className={answers[i]?.length ? "v" : "v none"}>{answers[i]?.length ? answers[i].map(optLabel).join(", ") : t("question.unanswered")}</span>
            </li>
          ))}
        </ul>
      </div>
    </div>
  )
}

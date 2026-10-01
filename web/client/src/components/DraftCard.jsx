// Progress card for long-document drafting (draft_* tools, docs/DRAFTING.md): one card per draftId, merging the
// progress objects of all its tool parts (newest updatedAt wins). Stepper plan → write → check → fix → assemble,
// section list, open issues, and a link to the resulting document card.
import "../styles-draft.css"
import { useEffect, useState } from "react"
import { Trans, fmtDuration, fmtNumber, useT } from "../i18n.jsx"
import { Data } from "./DataText.jsx"
import { IconAlert, IconCheck, IconChevron, IconFile, IconX, Spinner } from "./Icons.jsx"

const KIND_KEY = { "hop-dong": "contract", "bao-cao": "report", "van-ban": "document" }
const STEPS = ["plan", "write", "check", "fix", "assemble"]
const WRITTEN = new Set(["written", "checked", "fixed"])

function useTick(on) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!on) return
    const t = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(t)
  }, [on])
  return now
}

/** State of each stepper step: done | current | failed | todo. */
function stepStates(d, running) {
  const idx = STEPS.indexOf(d.phase)
  if (d.phase === "done") return STEPS.map(() => "done")
  if (d.phase === "failed") {
    // The failing step = the one after the last step that has a timing.
    const lastTimed = STEPS.reduce((n, k, i) => (d.timings?.[k] != null ? i : n), -1)
    const at = Math.min(lastTimed + 1, STEPS.length - 1)
    return STEPS.map((_, i) => (i < at ? "done" : i === at ? "failed" : "todo"))
  }
  // A phase whose tool already finished (e.g. phase "check" after draft_check) counts as done while idle.
  const cur = running ? idx : idx + 1
  return STEPS.map((_, i) => (i < cur ? "done" : i === cur ? (running ? "current" : "todo") : "todo"))
}

function SectionIcon({ status }) {
  if (status === "writing") return <Spinner size={11} />
  if (status === "failed") return <IconX size={12} />
  if (WRITTEN.has(status)) return <IconCheck size={12} />
  return <span className="draft-dot" />
}

export default function DraftCard({ draft: d, parts = [], active, rootRef }) {
  const t = useT()
  const running = active && parts.some((p) => p.status === "running" || p.status === "pending")
  const now = useTick(running)
  const [open, setOpen] = useState(false)
  const states = stepStates(d, running)
  const total = d.sections.length
  const written = d.sections.filter((s) => WRITTEN.has(s.status)).length
  const words = d.sections.reduce((n, s) => n + (s.words || 0), 0)
  const elapsed = d.startedAt ? (running ? now : d.updatedAt || now) - d.startedAt : null
  const failedPart = [...parts].reverse().find((p) => p.status === "error")
  const failed = d.phase === "failed" || (!running && failedPart && d.phase !== "done")
  const err = d.error || failedPart?.error
  const openIssues = d.issues.errors + d.issues.warnings + d.issues.suggestions
  const phaseText = failed ? t("draft.phase.failed") : d.phase === "done" ? t("draft.phase.done") : running ? t(`draft.phase.${d.phase}`) : active ? t("draft.phase.between") : t("draft.phase.paused")
  // Titles, section labels / headings and error messages come from the document / the drafting tools: data.
  const dl = d.language === "en" ? "en" : d.language === "vi" ? "vi" : undefined
  const goToDoc = () => {
    const el = rootRef?.current?.querySelector(`.doc-card[data-doc-id="${d.document?.id}"]`) || document.querySelector(`.doc-card[data-doc-id="${d.document?.id}"]`)
    if (!el) return
    el.scrollIntoView({ block: "center", behavior: "smooth" })
    el.classList.remove("flash")
    void el.offsetWidth
    el.classList.add("flash")
    el.querySelector("button")?.focus({ preventScroll: true })
  }
  return (
    <section className={`draft-card ${running ? "running" : ""} ${failed ? "failed" : ""} ${d.phase === "done" ? "done" : ""}`} aria-label={t("draft.label", { title: d.title })}>
      <header className="draft-head">
        <span className="draft-icon" aria-hidden="true">
          {running ? <Spinner size={15} /> : failed ? <IconAlert size={16} /> : d.phase === "done" ? <IconCheck size={16} /> : <IconFile size={16} />}
        </span>
        <div className="draft-headtext">
          <div className="draft-title">
            <Data v={d.title} lang={dl} />
          </div>
          <div className="draft-sub">
            <span className="draft-chip">{t(`draft.kind.${KIND_KEY[d.kind] || "document"}`)}</span>
            <span className="draft-chip">{t(`draft.lang.${d.language}`)}</span>
            <span className={`draft-phase ${running ? "shimmer" : ""}`} aria-live="polite">
              {phaseText}
            </span>
            {elapsed != null && elapsed >= 0 && <span className="draft-time">· {fmtDuration(elapsed)}</span>}
          </div>
        </div>
      </header>

      <ol className="draft-steps" aria-label={t("draft.stepsLabel")}>
        {STEPS.map((k, i) => (
          <li key={k} className={`draft-step ${states[i]}`} aria-current={states[i] === "current" ? "step" : undefined}>
            <span className="draft-step-mark" aria-hidden="true">
              {states[i] === "done" ? <IconCheck size={12} /> : states[i] === "current" ? <Spinner size={11} /> : states[i] === "failed" ? <IconX size={12} /> : i + 1}
            </span>
            <span className="draft-step-name">{t(`draft.step.${k}`)}</span>
            {d.timings?.[k] != null && states[i] === "done" && <span className="draft-step-time">{fmtDuration(d.timings[k])}</span>}
            <span className="sr-only">{t(`draft.state.${states[i]}`)}</span>
          </li>
        ))}
      </ol>

      {total > 0 && (
        <div className="draft-progress">
          <div className="draft-bar" role="progressbar" aria-valuemin={0} aria-valuemax={total} aria-valuenow={written} aria-label={t("draft.sectionsDone", { done: written, total })}>
            <span style={{ width: `${total ? Math.round((written / total) * 100) : 0}%` }} />
          </div>
          <div className="draft-stats">
            <span>{t("draft.sectionsDone", { done: written, total })}</span>
            {words > 0 && <span>{t("draft.words", { count: words, n: fmtNumber(words) })}</span>}
            {(openIssues > 0 || ["check", "fix", "assemble", "done"].includes(d.phase)) && (
              <span className="draft-issues">
                {openIssues === 0 ? (
                  t("draft.noIssues")
                ) : (
                  <>
                    {d.issues.errors > 0 && <b className="sev-err">{t("draft.errors", { count: d.issues.errors })}</b>}
                    {d.issues.warnings > 0 && <span className="sev-warn">{t("draft.warnings", { count: d.issues.warnings })}</span>}
                    {d.issues.suggestions > 0 && <span>{t("draft.suggestions", { count: d.issues.suggestions })}</span>}
                  </>
                )}
                {d.round > 0 && <span className="muted">· {t("draft.rounds", { count: d.round })}</span>}
              </span>
            )}
          </div>
        </div>
      )}

      {total > 0 && (
        <div className="draft-sections">
          <button type="button" className="draft-toggle" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            <IconChevron size={14} className={`chev ${open ? "up" : ""}`} /> {t(open ? "draft.hideSections" : "draft.showSections", { count: total })}
          </button>
          {open && (
            <ol className="draft-section-list">
              {d.sections.map((s) => (
                <li key={s.key} className={`draft-sec ${s.status}`}>
                  <span className="draft-sec-icon" aria-hidden="true">
                    <SectionIcon status={s.status} />
                  </span>
                  <span className="draft-sec-name">
                    <Data v={[s.label ? `${s.label}.` : "", s.heading].filter(Boolean).join(" ")} lang={dl} />
                  </span>
                  <span className="draft-sec-meta">
                    {s.issues > 0 && <span className="draft-sec-issues">{t("draft.secIssues", { count: s.issues })}</span>}
                    {s.words > 0 && <span>{t("draft.words", { count: s.words, n: fmtNumber(s.words) })}</span>}
                    <span className="sr-only">{t(`draft.sec.${s.status}`)}</span>
                  </span>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}

      {failed && err && (
        <div className="draft-error" role="alert">
          <IconAlert size={14} /> <span>{t("draft.failedDetail")}</span> <Data v={err} />
        </div>
      )}
      {d.document && (
        <div className="draft-doc">
          <span>
            <Trans k="draft.docReady" vars={{ title: <Data v={d.document.title} lang={dl} q />, v: d.document.version }} />
          </span>
          <button type="button" className="btn ghost xs" onClick={goToDoc}>
            <IconFile size={13} /> {t("draft.openDoc")}
          </button>
        </div>
      )}
    </section>
  )
}

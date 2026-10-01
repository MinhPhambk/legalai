// Structured step summaries (server/stepview.mjs): arguments and result of a tool step rendered in the UI
// language – counters, statuses, units and dates from the locale files, source data (queries, titles, document
// names) as marked data. Records made before structured steps are converted by legacyStep() (codes.js).
import { Fragment } from "react"
import { fmtDate, fmtDateTime, hasKey, t, useT } from "../i18n.jsx"
import { STATUS_CODE_KEY, companyStepStatus, legacyStep } from "../codes.js"
import { Data } from "./DataText.jsx"

/** The structured step of a tool part (new records) or the conversion of its legacy strings. */
export const stepOf = (item) => (item?.step && Array.isArray(item.step.args) ? item.step : legacyStep(item?.label, item?.result))

const COUNT_UNITS = new Set(["results", "docs", "articles", "precedents", "judgments", "measures", "news", "notifications", "codes", "tariffLines", "ftas", "changes", "tasks", "entries", "items", "pages"])
/** "8 results" / "8 kết quả" (unit-specific plurals). */
export const countText = (n, unit) => t(`tools.count.${COUNT_UNITS.has(unit) ? unit : "items"}`, { count: n })
/** Localized skill name (library), else null. */
export const skillName = (id) => (hasKey(`library.skill.${id}.name`) ? t(`library.skill.${id}.name`) : null)
/** Legal status code (or a company tool status code) → { label, tone }. */
export function statusLabel(code) {
  const k = STATUS_CODE_KEY[code]
  if (k) return { label: t(`sources.status.${k[0]}`), tone: k[1] }
  const c = companyStepStatus(code)
  return c ? { label: t(c[0]), tone: c[1] } : null
}

function Arg({ a }) {
  switch (a.t) {
    case "q":
      return <Data v={a.v} lang={a.lang} q />
    case "doc":
      return <Data v={a.v} lang={a.lang} className="data-doc" />
    case "art":
      return <span className="step-chrome">{t("tools.text.article", { n: a.n })}</span>
    case "count":
      return <span className="step-chrome">{countText(a.n, a.unit)}</span>
    case "version":
      return <span className="step-chrome">{t("tools.arg.version", { n: a.n })}</span>
    case "skill": {
      const name = skillName(a.v)
      return name ? <span className="step-chrome">{name}</span> : <Data v={a.v} code />
    }
    default:
      return <Data v={a.v} code />
  }
}

/** Arguments of a step, separated by " · ". */
export function StepArgs({ args }) {
  useT()
  if (!args?.length) return null
  return args.map((a, i) => (
    <Fragment key={i}>
      {i > 0 && <span className="step-sep"> · </span>}
      <Arg a={a} />
    </Fragment>
  ))
}

/** Result of a step. */
export function StepRes({ res }) {
  useT()
  if (!res) return null
  switch (res.t) {
    case "count":
      return (
        <span className="step-chrome">
          {countText(res.n, res.unit)}
          {res.official > 0 && res.official < res.n ? ` · ${t("tools.res.official", { count: res.official })}` : res.official === res.n && res.n > 0 ? ` · ${t("tools.res.allOfficial")}` : ""}
        </span>
      )
    case "none":
      return <span className="step-chrome">{t("tools.res.none")}</span>
    case "status": {
      const s = statusLabel(res.code)
      return s ? <span className={`step-chrome step-status ${s.tone}`}>{s.label}</span> : null
    }
    case "verify":
      return <span className={`step-chrome ${res.code === "match" ? "ok" : "bad"}`}>{t(`tools.res.verify.${res.code === "match" ? "match" : "nomatch"}`)}</span>
    case "level":
      return <span className="step-chrome">{t(`confidence.level.${["high", "medium", "low"].includes(res.code) ? res.code : "medium"}`)}</span>
    case "title":
      return <Data v={res.v} lang={res.lang} q />
    case "id":
      return <Data v={res.v} code />
    case "files":
      return res.v?.length ? <Data v={res.v.join(", ")} code /> : <span className="step-chrome">{t("tools.text.noFiles")}</span>
    case "changes":
      return <span className="step-chrome">{t("tools.text.changes", { count: res.n })}</span>
    case "deadline":
      return (
        <span className="step-chrome">
          {t("tools.res.deadline", { date: fmtDate(res.date + "T00:00:00") })}
          {res.days != null ? ` · ${res.passed || res.days < 0 ? t("tools.res.overdue", { count: Math.abs(res.days) }) : t("tools.res.daysLeft", { count: res.days })}` : ""}
        </span>
      )
    case "datetime":
      return <span className="step-chrome">{fmtDateTime(res.iso)}</span>
    case "safety":
      return <span className="step-chrome">{t(`tools.res.safety.${res.code === "clean" ? "clean" : "flagged"}`)}</span>
    case "error":
      return <span className="step-chrome bad">{t("tools.res.error")}</span>
    default:
      return null
  }
}

/** Plain text of args / result (title attributes): localized chrome + raw data. */
export function stepPlain(step) {
  const arg = (a) =>
    a.t === "art" ? t("tools.text.article", { n: a.n }) : a.t === "count" ? countText(a.n, a.unit) : a.t === "version" ? t("tools.arg.version", { n: a.n }) : a.t === "skill" ? skillName(a.v) || a.v : a.t === "q" ? `“${a.v}”` : a.v
  return (step?.args || []).map(arg).join(" · ")
}

/** Error of a failed step: localized reason + the tool's own message as data. */
export function StepError({ item }) {
  useT()
  const e = item.errorInfo
  if (!e && !item.error) return null
  return (
    <div className="step-error">
      <span>{t(`tools.error.${["aborted", "timeout", "notFound", "failed"].includes(e?.code) ? e.code : "failed"}`)}</span>
      {(e?.detail || (!e && item.error)) && (
        <>
          {" "}
          <Data v={e?.detail || item.error} lang={e?.lang} className="step-error-detail" />
        </>
      )}
    </div>
  )
}

// Compact result cards inside the step list (server/resultcards.mjs): calculations (value, formula, steps, legal-cap
// warnings), exchange rates (rate, date, source links), web pages read (domain, official badge), tariff look-ups and
// company checks (tax code, official portals, company facts, field-by-field comparison).
// Cards are language-neutral (v: 2): numbers and dates are formatted here with Intl, every label comes from the
// locale files, and source data (amount in words, tool notes, product descriptions, page titles) is shown as data.
// Cards stored before v2 (old share snapshots) are rendered by LegacyCard with their strings marked as data.
import "../styles-cards.css"
import { fmtDate, fmtNumber, getLocale, useT } from "../i18n.jsx"
import { IconAlert, IconCheck, IconChevron, IconExternal, IconInfo, IconLock, IconShield, IconX } from "./Icons.jsx"
import { D, Data } from "./DataText.jsx"
import { OcrBadge } from "./OcrBadge.jsx"
import { COMPANY_STATUS_TONE } from "../codes.js"

const hostOf = (u) => {
  try {
    return new URL(u).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}
function Src({ url }) {
  if (!url) return null
  return (
    <a className="rc-src" href={url} target="_blank" rel="noopener noreferrer">
      <span data-source="host">{hostOf(url)}</span> <IconExternal size={11} />
    </a>
  )
}
function More({ label, children }) {
  return (
    <details className="rc-more">
      <summary>
        <IconChevron size={12} /> {label}
      </summary>
      {children}
    </details>
  )
}

// ---- formatting ------------------------------------------------------------------------------------------
const num = (n, digits) => {
  const x = Number(n)
  if (!Number.isFinite(x)) return String(n ?? "")
  return digits == null ? fmtNumber(x, { maximumFractionDigits: 10 }) : fmtNumber(x, { minimumFractionDigits: digits, maximumFractionDigits: digits })
}
/** Amount with its currency, VND without decimals, other currencies with 2. */
const money = (v) => {
  if (!v || v.n == null) return ""
  const d = !v.cur ? null : v.cur === "VND" ? 0 : Number.isInteger(Number(v.n)) && Math.abs(Number(v.n)) >= 1000 ? 0 : 2
  return `${num(v.n, d)}${v.cur ? ` ${v.cur}` : ""}`
}
const pct = (n) => `${num(n)}%`
const date = (iso) => (iso ? fmtDate(iso + "T00:00:00") : "")
const fact = (c, k) => (c.facts || []).find((f) => f.k === k)

function Warnings({ items }) {
  const t = useT()
  if (!items?.length) return null
  return (
    <ul className="rc-warn" role="note">
      {items.map((w, i) => (
        <li key={i}>
          <IconAlert size={13} />{" "}
          <span>{w.code ? t(`cards.calc.warn.${w.code === "loan_cap" ? "loan_cap" : "penalty_cap"}`, { rate: pct(w.rate), cap: pct(w.cap) }) : <D d={w} />}</span>
        </li>
      ))}
    </ul>
  )
}
const DataList = ({ items, className = "rc-note" }) => (items || []).map((n, i) => (n?.v ? <p key={i} className={className}><D d={n} /></p> : null))

// ---- calculations -------------------------------------------------------------------------------------------
function formulaLine(c, t) {
  const f = c.formula
  if (!f) return null
  const rate = fact(c, "rate")
  const days = fact(c, "days")
  const principal = fact(c, "principal")
  const base = fact(c, "base")
  const dc = fact(c, "dayCount")?.v
  const denom = dc === "actual/365" ? 365 : 360
  const label = t(`cards.calc.formula.${["penalty", "simple_year", "simple_day", "monthly", "daily"].includes(f) ? f : "simple_year"}`, { denom })
  let inst = ""
  if (f === "penalty" && rate && base) inst = `${pct(rate.n)} × ${money(base)}`
  else if (f === "simple_year" && rate && days && principal) inst = `${money(principal)} × ${pct(rate.n)} × ${num(days.n)} / ${denom}`
  else if (f === "simple_day" && rate && days && principal) inst = `${money(principal)} × ${pct(rate.n)} × ${num(days.n)}`
  return (
    <p className="rc-formula">
      <span>{label}</span>
      {inst && <code className="rc-expr">{inst}</code>}
    </p>
  )
}

function Calc({ c }) {
  const t = useT()
  const period = fact(c, "period")
  const days = fact(c, "days")
  const rate = fact(c, "rate")
  const comp = fact(c, "compounding")?.v
  const kind = fact(c, "kind")?.v
  const total = fact(c, "total")
  const unrounded = fact(c, "unrounded")
  const rounding = fact(c, "rounding")
  const meta = [
    kind ? t(`cards.calc.kind.${kind === "loan" ? "loan" : "late_payment"}`) : "",
    period && period.from && period.to ? t("cards.calc.period", { from: date(period.from), to: date(period.to), days: num(days?.n ?? 0) }) : days ? t("cards.calc.days", { count: Number(days.n) }) : "",
    rate && c.formula !== "penalty" ? t(`cards.calc.rate.${["year", "month", "day"].includes(rate.basis) ? rate.basis : "year"}`, { rate: pct(rate.n) }) : "",
    fact(c, "dayCount")?.v || "",
    comp ? t(`cards.calc.comp.${["simple", "monthly", "daily"].includes(comp) ? comp : "simple"}`) : "",
  ].filter(Boolean)
  const hasMore = c.steps?.length || c.notes?.length || unrounded || rounding || total
  return (
    <>
      <div className="rc-main">
        <span className="rc-chip">{t(`cards.calc.${["result", "interest", "penalty", "words"].includes(c.label) ? c.label : "result"}`)}</span>
        {c.value && <strong className="rc-result">{money(c.value)}</strong>}
      </div>
      {c.words?.v && (
        <p className="rc-words">
          <D d={c.words} />
        </p>
      )}
      {formulaLine(c, t) || (c.expression?.v ? <Data v={c.expression.v} code className="rc-expr" /> : null)}
      {meta.length > 0 && <p className="rc-muted rc-meta">{meta.join(" · ")}</p>}
      <Warnings items={c.warnings} />
      {hasMore && (
        <More label={c.steps?.length ? t("cards.steps", { count: c.steps.length }) : t("cards.details")}>
          {c.steps?.length > 0 && (
            <ol className="rc-steps">
              {c.steps.map((s, i) => (
                <li key={i}>
                  <D d={s} />
                </li>
              ))}
            </ol>
          )}
          {rounding && <p className="rc-note">{t("cards.calc.rounding", { count: rounding.digits })}</p>}
          {unrounded && <p className="rc-note">{t("cards.calc.unrounded", { v: money(unrounded) })}</p>}
          {total && <p className="rc-note">{t("cards.calc.total", { v: money(total) })}</p>}
          <DataList items={c.notes} />
        </More>
      )}
    </>
  )
}

function Check({ c }) {
  const t = useT()
  const ok = c.status === "ok"
  return (
    <>
      <div className="rc-main">
        <span className={`rc-badge ${ok ? "ok" : c.status === "style" ? "" : "bad"}`}>
          {ok ? <IconCheck size={12} /> : c.status === "style" ? null : <IconX size={12} />} {t(`cards.check.${["ok", "style", "mismatch", "unread"].includes(c.status) ? c.status : "mismatch"}`)}
        </span>
        {c.value && <strong className="rc-result">{money(c.value)}</strong>}
      </div>
      {c.said && <p className="rc-note">{t("cards.check.said", { v: money(c.said) })}</p>}
      {c.words?.v && (
        <p className="rc-note">
          {t("cards.check.words")}: <D d={c.words} />
        </p>
      )}
      {!ok && c.standard?.v && (
        <p className="rc-note">
          {t("cards.standard")}: <b><D d={c.standard} /></b>
        </p>
      )}
    </>
  )
}

function Contract({ c }) {
  const t = useT()
  const items = [...(c.errorItems || []).map((x) => ["bad", x]), ...(c.warningItems || []).map((x) => ["", x])].slice(0, 3)
  return (
    <>
      <div className="rc-main rc-counts">
        <span className={`rc-badge ${c.errors ? "bad" : "ok"}`}>{t("cards.contract.errors", { count: c.errors })}</span>
        <span className="rc-badge">{t("cards.contract.warnings", { count: c.warnings })}</span>
        <span className="rc-muted">{t("cards.contract.passed", { passed: c.passed, checks: c.checks })}</span>
      </div>
      {c.total && <p className="rc-note">{t("cards.contract.total", { v: money(c.total) })}</p>}
      {items.length > 0 && (
        <ul className="rc-issues">
          {items.map(([k, x], i) => (
            <li key={i} className={k}>
              <D d={x} />
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

// ---- exchange rates ------------------------------------------------------------------------------------------
const FX_SRC = ["sbv_central", "sbv_ref", "sbv_cross", "vcb", "vcb_cash", "vcb_transfer", "vcb_sell", "sbv_ref_buy", "sbv_ref_sell"]
const srcLabel = (t, src) => {
  if (String(src).startsWith("cross:")) {
    const [a, b] = String(src).slice(6).split("/")
    return t("cards.fx.crossVia", { a: srcLabel(t, a), b: srcLabel(t, b) })
  }
  return t(`cards.fx.src.${FX_SRC.includes(src) ? src : "other"}`)
}
function RateLine({ r }) {
  const t = useT()
  const cur = r.cur || "USD"
  let value = ""
  if (r.src === "sbv_central" || r.src === "sbv_cross") value = `1 ${cur} = ${num(r.rate, 0)} VND`
  else if (r.src === "sbv_ref") value = t("cards.fx.buySell", { buy: num(r.buy, 0), sell: num(r.sell, 0) })
  else if (r.src === "vcb") value = t("cards.fx.vcbRates", { cash: r.cash ? num(r.cash, 0) : "–", transfer: r.transfer ? num(r.transfer, 0) : "–", sell: r.sell ? num(r.sell, 0) : "–" })
  const when = r.src === "sbv_cross" && r.from ? t("cards.fx.validFrom", { from: date(r.from), to: date(r.to) }) : r.date ? t("cards.fx.dateOf", { date: date(r.date) }) : ""
  return (
    <li>
      <span className="rc-src-name">{srcLabel(t, r.src)}</span> <span>{value}</span>
      {when && <span className="rc-muted"> · {when}</span>} <Src url={r.url} />
    </li>
  )
}
function Fx({ c }) {
  const t = useT()
  const conv = c.mode === "convert" ? c.convert : null
  return (
    <>
      <div className="rc-main">
        <span className="rc-chip">{conv ? t("cards.fx.convert") : t("cards.fx.rateOn", { date: date(c.date) })}</span>
        {conv ? (
          <strong className="rc-result">
            {num(conv.amount)} {conv.fromCur} = {num(conv.result, conv.toCur === "VND" ? 0 : 2)} {conv.toCur}
          </strong>
        ) : (
          c.rates?.[0] && <strong className="rc-result">{c.rates[0].rate ? `1 ${c.rates[0].cur || c.currency} = ${num(c.rates[0].rate, 0)} VND` : c.currency}</strong>
        )}
      </div>
      {conv && (
        <p className="rc-muted rc-meta">
          {srcLabel(t, conv.src)}
          {conv.date ? ` · ${t("cards.fx.dateOf", { date: date(conv.date) })}` : ""}
        </p>
      )}
      {c.rates?.length > 0 && (
        <ul className="rc-rates">
          {c.rates.slice(0, 4).map((r, i) => (
            <RateLine key={i} r={r} />
          ))}
        </ul>
      )}
      {c.ways?.length > 1 && (
        <More label={t("cards.fx.ways", { count: c.ways.length })}>
          <ol className="rc-steps">
            {c.ways.map((w, i) => (
              <li key={i}>
                {srcLabel(t, w.src)}
                {w.date ? ` (${date(w.date)})` : ""}: {w.rate ? `${num(w.rate, 0)} → ` : ""}
                {num(w.result, conv?.toCur === "VND" ? 0 : 2)} {conv?.toCur || ""}
              </li>
            ))}
          </ol>
        </More>
      )}
      {c.errors > 0 && <p className="rc-note">{t("cards.fx.errors", { count: c.errors })}</p>}
      <p className="rc-note">{t("cards.fx.reference")}</p>
    </>
  )
}

// ---- web page read -----------------------------------------------------------------------------------------
function Web({ c }) {
  const t = useT()
  return (
    <div className="rc-main rc-web">
      <span className={`rc-badge ${c.official ? "ok" : "warn"}`}>
        {c.official ? <IconShield size={12} /> : <IconAlert size={12} />} {c.official ? t("cards.web.official") : t("cards.web.unofficial")}
      </span>
      <a className="rc-link" href={c.url} target="_blank" rel="noopener noreferrer" title={c.url}>
        {c.title?.v ? <D d={c.title} /> : <Data v={c.host} code />}
      </a>
      <span className="rc-muted">
        <Data v={c.host} code />
        {c.officialDomain && c.officialDomain !== c.host ? (
          <>
            {" · "}
            {t("cards.web.officialGroup")} <Data v={c.officialDomain} code />
          </>
        ) : null}
        {c.officialLabel?.v ? (
          <>
            {" · "}
            <D d={c.officialLabel} />
          </>
        ) : null}
        {" · "}
        {c.date ? t("cards.web.date", { date: date(c.date) }) : t("cards.web.noDate")}
        {c.ocr && (
          <>
            {" "}
            <OcrBadge pages={c.ocr.pages} kind="source" />
          </>
        )}
      </span>
    </div>
  )
}

// ---- tariffs ---------------------------------------------------------------------------------------------------
const TARIFF_COLS = ["mfn", "normal", "export", "fta", "general", "special", "col2", "third_country", "preference", "lvc", "quota", "antidumping", "countervailing", "safeguard", "additional", "other"]
function RateValue({ r }) {
  const t = useT()
  if (r.free) return <b>{t("cards.tariff.free")}</b>
  if (r.pct != null && r.pct !== "") return <b>{pct(r.pct)}</b>
  return r.raw?.v ? <D d={r.raw} /> : <span>–</span>
}
function Tariff({ c }) {
  const t = useT()
  const ui = getLocale()
  // Annex rate of the requested year replaces a Customs-database row of another period for the same schedule.
  const rates = (c.rates || []).filter((r) => !(r.stale && (c.rates || []).some((x) => x.annex && x.col === r.col && x.fta === r.fta)))
  const main = rates.slice(0, 6)
  const desc = (l) => (l.descAlt?.lang === ui && l.desc?.lang !== ui ? l.descAlt : l.desc)
  return (
    <>
      <div className="rc-main">
        <span className="rc-chip">{t(`cards.tariff.market.${["vn", "us", "eu"].includes(c.market) ? c.market : "vn"}`)}</span>
        <strong className="rc-result">
          <Data v={c.code} code />
        </strong>
        <span className="rc-muted">
          {[c.year ? t("cards.tariff.year", { year: c.year }) : "", c.origin ? t("cards.tariff.origin", { origin: c.origin }) : "", c.dest ? t("cards.tariff.dest", { dest: c.dest }) : ""].filter(Boolean).join(" · ")}
          {c.release ? (
            <>
              {c.year || c.origin ? " · " : ""}
              <Data v={c.release} lang="en" />
            </>
          ) : null}
        </span>
      </div>
      {main.length > 0 && (
        <ul className="rc-rates rc-tariff-rates">
          {main.map((r, i) => (
            <li key={i} className={r.stale ? "stale" : ""}>
              <span className="rc-src-name">
                {r.col === "other" && r.label?.v ? <D d={r.label} /> : t(`cards.tariff.col.${TARIFF_COLS.includes(r.col) ? r.col : "other"}`, { fta: r.fta || "" })}
                {r.geo === "erga_omnes" ? ` · ${t("cards.tariff.ergaOmnes")}` : r.geoName?.v ? (
                  <>
                    {" · "}
                    <D d={r.geoName} />
                  </>
                ) : null}
              </span>{" "}
              <RateValue r={r} />
              <span className="rc-muted">
                {r.basis ? (
                  <>
                    {" · "}
                    <Data v={r.basis} code />
                  </>
                ) : null}
                {r.annex ? ` · ${t("cards.tariff.annex", { year: r.year })}` : r.from ? ` · ${r.to ? t("cards.tariff.period", { from: date(r.from), to: date(r.to) }) : t("cards.tariff.since", { from: date(r.from) })}` : ""}
                {r.quota ? ` · ${t("cards.tariff.quota", { n: r.quota })}` : ""}
              </span>
              {r.stale && <span className="rc-badge warn">{t("cards.tariff.stale")}</span>}
            </li>
          ))}
        </ul>
      )}
      {c.extraDuties > 0 && (
        <ul className="rc-warn" role="note">
          <li>
            <IconAlert size={13} /> <span>{t("cards.tariff.extraDuties", { count: c.extraDuties })}</span>
          </li>
        </ul>
      )}
      {c.amended > 0 && (
        <ul className="rc-warn" role="note">
          <li>
            <IconAlert size={13} /> <span>{t("cards.tariff.amended", { count: c.amended })}</span>
          </li>
        </ul>
      )}
      {c.lines?.length > 0 && (
        <More label={t("cards.tariff.lines", { count: c.lines.length + (c.more || 0) })}>
          <ul className="rc-tariff-lines">
            {c.lines.map((l, i) => (
              <li key={i}>
                <Data v={l.code} code /> <D d={desc(l)} />
                {l.unit ? <span className="rc-muted"> · {t("cards.tariff.unit", { unit: l.unit })}</span> : null}
              </li>
            ))}
          </ul>
          {c.more > 0 && <p className="rc-note">{t("cards.tariff.more", { count: c.more })}</p>}
        </More>
      )}
      <p className="rc-note">
        {t("cards.tariff.note")} <Src url={c.url} />
      </p>
    </>
  )
}

// ---- company checks (company_lookup / company_verify) ---------------------------------------------------------
// Official portals are CAPTCHA-gated: without company data the card shows the portals + short steps. Company facts
// come from a paste of the official page (basis / origin "user_paste") or from reference aggregator sites
// ("aggregator" – unofficial: warning banner, source list, per-field cross-check, fields the sites disagree on shown
// with each site's value, official portal buttons kept for the final confirmation). Names, addresses and compared
// values are data (their own language).
const CO_PORTALS = ["dkkd", "dkkd_egazette", "gdt"]
const CO_GATES = ["captcha", "open", "blocked", "error"]
const CO_RESULTS = ["match", "partial", "mismatch", "not_checked"]
const CO_FIELDS = ["tax_code", "name", "address", "representative", "status"]
const CO_SKIPS = ["robots", "challenge", "not_found", "code_mismatch", "error"]
const CO_FACTS = ["name", "nameEn", "short", "code", "status", "legalType", "regDate", "address", "representative", "mainLine", "taxAuthority"]
// fact → field of the per-field comparison (verify) / cross-check between the reference sites
const FACT_FIELD = { name: "name", code: "tax_code", status: "status", address: "address", representative: "representative", regDate: "regDate" }
const coTone = (st) => COMPANY_STATUS_TONE[st] ?? ""
const toneClass = (tone) => (tone ? `co-${tone}` : "")
const RES_TONE = { match: "ok", partial: "warn", mismatch: "bad", not_checked: "" }
/** Date or timestamp (fetch time of a reference site) in the UI locale. */
const dateOrTs = (s) => (!s ? "" : s.includes("T") ? fmtDate(s) : date(s))
function ResIcon({ r, size = 13 }) {
  if (r === "match") return <IconCheck size={size} />
  if (r === "mismatch") return <IconX size={size} />
  if (r === "partial") return <IconAlert size={size} />
  return <span className="rc-co-dash" aria-hidden="true">–</span>
}

function CompanyPortals({ c, compact = false }) {
  const t = useT()
  const portals = (c.portals || []).filter((p) => CO_PORTALS.includes(p.src) && p.url)
  if (!portals.length) return null
  return (
    <ul className={`rc-co-portals ${compact ? "compact" : ""}`}>
      {portals.map((p) => {
        const name = t(`cards.company.portal.${p.src}`)
        return (
          <li key={p.src}>
            <a className="rc-co-portal" href={p.url} target="_blank" rel="noopener noreferrer" aria-label={`${name} (${t("cards.company.newTab")})`}>
              <span className="rc-co-portal-name">
                {name} <IconExternal size={12} />
              </span>
              {!compact && (
                <span className="rc-co-portal-meta">
                  <span data-source="host">{hostOf(p.url)}</span>
                  {" · "}
                  {t(`cards.company.portalHint.${p.src}`)}
                  {CO_GATES.includes(p.gate) && p.gate !== "error" ? (
                    <>
                      {" · "}
                      <span className={`rc-co-gate ${p.gate}`}>
                        {p.gate === "captcha" ? <IconLock size={11} /> : null} {t(`cards.company.gate.${p.gate}`)}
                      </span>
                    </>
                  ) : null}
                </span>
              )}
            </a>
          </li>
        )
      })}
    </ul>
  )
}

/** Each reference site's value: "site.com: value". */
function SiteValues({ values }) {
  if (!values?.length) return null
  return (
    <ul className="rc-co-sitevals">
      {values.map((v, i) => (
        <li key={i}>
          {v.domain ? (
            <>
              <span className="rc-co-site" data-source="host">
                {v.domain}
              </span>
              {": "}
            </>
          ) : null}
          <D d={v} />
        </li>
      ))}
    </ul>
  )
}

/** Cross-check between reference sites for one field: ✓ agree / ⚠ disagree with each site's value. */
function CrossMark({ x }) {
  const t = useT()
  if (!x) return null
  if (x.agree)
    return (
      <span className="rc-co-cross ok">
        <IconCheck size={11} /> {t("cards.company.cross.agree")}
      </span>
    )
  return (
    <span className="rc-co-cross warn">
      <IconAlert size={11} /> {t("cards.company.cross.disagree")}
      <SiteValues values={x.values} />
    </span>
  )
}

function CompanyStatus({ co }) {
  const t = useT()
  if (!co.status && !co.statusText?.v) return null
  const st = co.status && co.status in COMPANY_STATUS_TONE ? co.status : "other"
  return (
    <>
      <span className={`rc-badge ${toneClass(coTone(st))}`}>
        {coTone(st) === "ok" ? <IconShield size={12} /> : coTone(st) ? <IconAlert size={12} /> : null} {t(`cards.company.status.${st}`)}
      </span>
      {co.statusText?.v && (
        <>
          {" "}
          <D d={co.statusText} className="rc-co-raw" />
        </>
      )}
    </>
  )
}

function CompanyFacts({ c, cross, showCross }) {
  const t = useT()
  const co = c.company
  const conflicts = new Set(co.conflicts || [])
  const val = (k) => {
    if (k === "status") return co.status || co.statusText?.v ? <CompanyStatus co={co} /> : null
    if (k === "regDate") return co.regDate ? <span>{date(co.regDate)}</span> : null
    if (k === "code") return co.code ? <Data v={co.code} code /> : null
    return co[k]?.v ? <D d={co[k]} /> : null
  }
  const rows = CO_FACTS.map((k) => {
    const f = FACT_FIELD[k]
    const v = val(k)
    // a field the sites disagree on is left empty by the tool → each site's value (verify: shown in the table instead)
    if (!v && f && conflicts.has(f) && showCross)
      return [
        k,
        <span className="rc-co-conflict">
          <span className="rc-co-cross warn">
            <IconAlert size={11} /> {t("cards.company.conflict")}
          </span>
          <SiteValues values={cross[f]?.values} />
        </span>,
      ]
    if (!v) return null
    return [
      k,
      <>
        {v}
        {showCross && f && cross[f] ? (
          <>
            {" "}
            <CrossMark x={cross[f]} />
          </>
        ) : null}
      </>,
    ]
  }).filter(Boolean)
  if (!rows.length) return null
  return (
    <dl className="rc-co-facts">
      {rows.map(([k, v]) => (
        <div key={k} className="rc-co-fact">
          <dt>{t(`cards.company.field.${k}`)}</dt>
          <dd>{v}</dd>
        </div>
      ))}
    </dl>
  )
}

function CompanySources({ c }) {
  const t = useT()
  if (!c.sources?.length && !c.skipped?.length) return null
  return (
    <div className="rc-co-sources">
      {c.sources?.length > 0 && (
        <>
          <span className="rc-muted">{t(c.basis === "official" ? "cards.company.sourcesOfficial" : "cards.company.sources")}:</span>
          <ul>
            {c.sources.map((s, i) => (
              <li key={i}>
                <a className="rc-src" href={s.url} target="_blank" rel="noopener noreferrer" aria-label={`${s.domain} (${t("cards.company.newTab")})`}>
                  <span data-source="host">{s.domain}</span> <IconExternal size={11} />
                </a>
                <span className="rc-muted">
                  {!s.official ? ` · ${t("cards.company.unofficial")}` : ""}
                  {s.fetchedAt ? ` · ${t("cards.company.fetched", { date: dateOrTs(s.fetchedAt) })}` : ""}
                  {s.updated ? ` · ${t("cards.company.updated", { date: date(s.updated) })}` : ""}
                </span>
              </li>
            ))}
          </ul>
        </>
      )}
      {c.skipped?.length > 0 && (
        <p className="rc-note rc-co-skipped">
          {t("cards.company.skipped")}:{" "}
          {c.skipped.map((x, i) => (
            <span key={i}>
              {i > 0 ? ", " : ""}
              <span data-source="host">{x.domain}</span> ({t(`cards.company.skip.${CO_SKIPS.includes(x.reason) ? x.reason : "error"}`)})
            </span>
          ))}
        </p>
      )}
    </div>
  )
}

function CompanyCandidates({ c }) {
  const t = useT()
  if (!c.candidates?.length) return null
  return (
    <div className="rc-co-cands">
      <strong className="rc-co-sub">{t("cards.company.candidates")}</strong>
      <ul>
        {c.candidates.map((x, i) => (
          <li key={i}>
            <span className="rc-co-cand-main">
              <Data v={x.code} code className="rc-co-cand-code" /> {x.name?.v ? <D d={x.name} /> : null}
            </span>
            <span className="rc-muted rc-co-cand-meta">
              <span className="rc-co-hint">{t("cards.company.lookupThis")}</span>
              {x.url ? (
                <>
                  {" · "}
                  <a className="rc-src" href={x.url} target="_blank" rel="noopener noreferrer" aria-label={`${x.domain} (${t("cards.company.newTab")})`}>
                    <span data-source="host">{x.domain}</span> <IconExternal size={11} />
                  </a>
                </>
              ) : null}
            </span>
          </li>
        ))}
      </ul>
      <p className="rc-note">{t("cards.company.candidatesHint")}</p>
    </div>
  )
}

function VerifyTable({ c, cross }) {
  const t = useT()
  const rows = (c.fields || []).filter((f) => CO_FIELDS.includes(f.field))
  if (!rows.length) return null
  const looked = !!c.company
  const agg = c.basis === "aggregator" || c.company?.origin === "aggregator"
  const cols = [t("cards.company.col.expected"), agg ? t("cards.company.col.unofficial") : t("cards.company.col.official"), t("cards.company.col.result")]
  return (
    <div className="rc-co-tablewrap">
      <table className="rc-co-table">
        <thead>
          <tr>
            <th scope="col">{t("cards.company.col.field")}</th>
            {cols.map((h) => (
              <th scope="col" key={h}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((f, i) => {
            const r = CO_RESULTS.includes(f.result) ? f.result : "not_checked"
            const x = agg ? cross[f.field] : null
            return (
              <tr key={i} className={`r-${r}`}>
                <th scope="row">{t(`cards.company.field.${f.field}`)}</th>
                <td>
                  <span className="rc-co-cell-label">{cols[0]}</span>
                  {f.expected?.v ? <D d={f.expected} /> : <span className="rc-muted">–</span>}
                </td>
                <td>
                  <span className="rc-co-cell-label">{cols[1]}</span>
                  {x && !x.agree ? (
                    <CrossMark x={x} />
                  ) : (
                    <>
                      {f.official?.v ? <D d={f.official} /> : <span className="rc-muted">{looked ? "–" : t("cards.company.notLooked")}</span>}
                      {x ? (
                        <>
                          {" "}
                          <CrossMark x={x} />
                        </>
                      ) : null}
                    </>
                  )}
                </td>
                <td>
                  <span className="rc-co-cell-label">{cols[2]}</span>
                  <span className={`rc-co-res ${toneClass(RES_TONE[r])}`}>
                    <ResIcon r={r} /> {t(`cards.company.result.${agg && r === "partial" ? "unclear" : r}`)}
                  </span>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}

/** Risks / to-dos in the UI language, derived from the structured result (the tool's own sentences stay in the answer). */
function companyRisks(c, t) {
  const out = []
  const agg = c.basis === "aggregator" || c.company?.origin === "aggregator"
  if (c.mode === "verify" && c.checksum && c.checksum !== "valid" && c.checksum !== "personal_id") out.push(t("cards.company.risk.checksum"))
  if (c.mode === "verify" && c.codeKind === "branch") out.push(t("cards.company.risk.branch"))
  const fieldName = (f) => t(`cards.company.field.${f}`)
  const done = new Set()
  for (const f of c.fields || []) {
    // status → the status risk below; an invalid tax code → risk.checksum above
    if (f.field === "status" || (f.field === "tax_code" && c.checksum && c.checksum !== "valid")) continue
    if (f.result === "mismatch") out.push(f.field === "representative" && !agg ? t("cards.company.risk.representative") : t("cards.company.risk.mismatch", { field: fieldName(f.field) }))
    else if (f.result === "partial") out.push(t(`cards.company.risk.${agg ? "unclear" : "partial"}`, { field: fieldName(f.field) }))
    else continue
    done.add(f.field)
  }
  for (const f of c.company?.conflicts || []) if (!done.has(f)) out.push(t("cards.company.risk.conflict", { field: fieldName(f) }))
  const st = c.company?.status
  if (st && st !== "active") out.push(t(`cards.company.risk.${coTone(st) === "bad" ? "statusVeryHigh" : "statusHigh"}`, { status: t(`cards.company.status.${st in COMPANY_STATUS_TONE ? st : "other"}`) }))
  return out
}
function CompanyRisks({ c }) {
  const t = useT()
  const data = Array.isArray(c.risks) ? c.risks.filter((r) => r?.v) : []
  const derived = data.length ? [] : companyRisks(c, t)
  const n = typeof c.risks === "number" ? c.risks : 0
  if (!data.length && !derived.length) return n > 0 && c.company ? <p className="rc-note">{t("cards.company.risksMore", { count: n })}</p> : null
  return (
    <div className="rc-co-risks">
      <strong className="rc-co-sub">{t("cards.company.risksTitle")}</strong>
      <ul className="rc-warn" role="note">
        {(data.length ? data : derived).map((r, i) => (
          <li key={i}>
            <IconAlert size={13} /> <span>{typeof r === "string" ? r : <D d={r} />}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}

function Company({ c }) {
  const t = useT()
  const cross = Object.fromEntries((c.crossCheck || []).map((x) => [x.field, x]))
  const co = c.company
  const agg = c.basis === "aggregator" || co?.origin === "aggregator"
  const valid = c.checksum === "valid"
  const ck = c.checksum ? (valid ? (c.codeKind === "branch" ? "validBranch" : "valid") : c.checksum === "branch_zero" ? "branchZero" : c.checksum) : null
  // "check it yourself" state: no company data from any source (reference data replaces it, portals stay below)
  const manual = c.status === "manual_required" && !co && !agg
  const summary = c.mode === "verify" && ["match", "partial", "mismatch"].includes(c.result) ? c.result : null
  const modeKey = c.mode === "verify" ? (agg ? "verifyUnofficial" : "verify") : "lookup"
  return (
    <div className="rc-co">
      <div className="rc-main">
        <span className="rc-chip">{t(`cards.company.mode.${modeKey}`)}</span>
        {c.taxCode ? (
          <strong className="rc-result">
            <span className="rc-co-label">{t("cards.company.taxCode")}</span> <Data v={c.taxCode} code />
          </strong>
        ) : c.name?.v ? (
          <strong className="rc-result">
            <span className="rc-co-label">{t("cards.company.byName")}</span> <D d={c.name} />
          </strong>
        ) : null}
        {ck && (
          <span className={`rc-badge ${valid ? "co-ok" : "co-bad"}`} title={valid ? t("cards.company.checksumHint") : undefined}>
            {valid ? <IconCheck size={12} /> : <IconX size={12} />} {t(`cards.company.checksum.${ck}`)}
          </span>
        )}
        {summary && (
          <span className={`rc-badge ${toneClass(RES_TONE[summary])}`}>
            <ResIcon r={summary} size={12} /> {t(`cards.company.${agg ? "summaryUnofficial" : "summary"}.${summary}`)}
          </span>
        )}
        {c.date && <span className="rc-muted">{t("cards.company.date", { date: date(c.date) })}</span>}
      </div>

      {c.status === "personal_id" && (
        <div className="rc-co-notice warn" role="note">
          <IconLock size={16} />
          <p>{t("cards.company.personal")}</p>
        </div>
      )}
      {c.status === "invalid_code" && (
        <div className="rc-co-notice warn" role="note">
          <IconAlert size={16} />
          <p>{t("cards.company.invalid")}</p>
        </div>
      )}

      {agg && (
        <div className="rc-co-notice warn strong" role="note">
          <IconAlert size={16} />
          <p>
            <strong>{t("cards.company.origin.aggregator")}</strong>
          </p>
        </div>
      )}
      {c.codeMismatch && (
        <ul className="rc-warn" role="note">
          <li>
            <IconAlert size={13} /> <span>{t("cards.company.codeMismatch")}</span>
          </li>
        </ul>
      )}

      {manual && (
        <div className="rc-co-notice" role="note">
          <IconLock size={16} />
          <div>
            <p>
              <strong>{t("cards.company.manual.title")}</strong>
            </p>
            <p className="rc-muted">{t("cards.company.manual.body")}</p>
          </div>
        </div>
      )}
      {manual && <CompanyPortals c={c} />}
      {manual && (
        <div className="rc-co-steps">
          <strong className="rc-co-sub">{t("cards.company.manual.stepsTitle")}</strong>
          <ol className="rc-steps">
            <li>{c.taxCode ? t("cards.company.manual.step1Code", { code: c.taxCode }) : t("cards.company.manual.step1Name")}</li>
            <li>{t("cards.company.manual.step2")}</li>
            <li>{t("cards.company.manual.step3")}</li>
          </ol>
        </div>
      )}

      {co && <CompanyFacts c={c} cross={cross} showCross={c.mode !== "verify"} />}
      <CompanyCandidates c={c} />
      {c.mode === "verify" && <VerifyTable c={c} cross={cross} />}
      <CompanyRisks c={c} />
      <CompanySources c={c} />
      {co?.origin === "user_paste" && (
        <p className="rc-note rc-co-origin">
          <IconInfo size={12} /> {t("cards.company.origin.user_paste")}
        </p>
      )}
      {co?.origin === "official" && (
        <p className="rc-note rc-co-origin">
          <IconCheck size={12} /> {t("cards.company.origin.official")}
        </p>
      )}
      {c.assist && c.assist.status !== "done" && (
        <p className="rc-note rc-co-assist">
          <IconInfo size={12} /> {t(`cards.company.assist.${["cancelled", "timeout", "not_found", "unparsed"].includes(c.assist.status) ? c.assist.status : "error"}`)}
        </p>
      )}
      {!manual && c.status !== "personal_id" && (c.portals || []).length > 0 && (
        <div className="rc-co-confirm">
          <span className="rc-muted">{t("cards.company.confirm")}:</span>
          <CompanyPortals c={c} compact />
        </div>
      )}
      {manual && valid && <p className="rc-note">{t("cards.company.checksumHint")}</p>}
    </div>
  )
}

// ---- cards stored before v2 (strings) ---------------------------------------------------------------------
function LegacyCard({ c }) {
  const t = useT()
  const s = (v) => (typeof v === "string" && v ? <Data v={v} /> : null)
  return (
    <>
      <div className="rc-main">
        <span className="rc-chip">{t(`cards.legacy.${["calc", "check", "contract", "fx", "web"].includes(c.kind) ? c.kind : "calc"}`)}</span>
        {typeof c.result === "string" && <strong className="rc-result">{s(c.result)}</strong>}
        {c.kind === "contract" && <span className="rc-muted">{t("cards.contract.passed", { passed: c.passed ?? 0, checks: c.checks ?? 0 })}</span>}
        {c.kind === "web" && c.url && (
          <a className="rc-link" href={c.url} target="_blank" rel="noopener noreferrer">
            {s(c.title) || <Data v={c.host} code />}
          </a>
        )}
      </div>
      {typeof c.expression === "string" && c.expression && <Data v={c.expression} code className="rc-expr" />}
      {(c.warnings || []).filter((w) => typeof w === "string").map((w, i) => (
        <p key={i} className="rc-note">
          <Data v={w.replace(/^⚠\s*/, "")} />
        </p>
      ))}
    </>
  )
}

export default function ResultCard({ card }) {
  if (!card) return null
  const Body = card.v === 2 ? { calc: Calc, check: Check, contract: Contract, fx: Fx, web: Web, tariff: Tariff, company: Company }[card.kind] : LegacyCard
  if (!Body) return null
  return (
    <div className={`rcard rc-${card.kind} ${card.kind === "web" && !card.official ? "unofficial" : ""} ${card.warnings?.length || card.errors || card.extraDuties || card.result === "mismatch" || card.company?.origin === "aggregator" ? "has-warn" : ""}`}>
      <Body c={card} />
    </div>
  )
}

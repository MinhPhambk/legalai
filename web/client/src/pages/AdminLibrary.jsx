// Admin → tools & skills library: what the assistant can use, how often, and per-item on/off switches.
import "../styles-library.css"
import { useCallback, useEffect, useMemo, useRef, useState } from "react"
import { api } from "../api.js"
import { fold, renderMarkdown, toolTitle } from "../lib.js"
import { fmtDateTime, fmtDuration, fmtNumber, formatBytes, hasKey, relTime, useT } from "../i18n.jsx"
import { Dialog, Segmented, useToast } from "../components/ui.jsx"
import { IconBook, IconChevron, IconLock, IconRefresh, IconSearch, IconSettings } from "../components/Icons.jsx"

// Every tool / skill shows a localized name and a short localized description; the raw description (written for the
// AI model, not translated) stays under "Technical description" and is marked as data.
const toolLabel = (t, name) => (hasKey(`tools.name.${name}`) ? toolTitle(name) : name.startsWith("chrome_") ? t("tools.name._browser") : t("tools.name._tool"))
const toolDesc = (t, name) => (hasKey(`library.tool.${name}`) ? t(`library.tool.${name}`) : "")
const skillLabel = (t, name) => (hasKey(`library.skill.${name}.name`) ? t(`library.skill.${name}.name`) : name)
const skillDesc = (t, name) => (hasKey(`library.skill.${name}.desc`) ? t(`library.skill.${name}.desc`) : "")

function TechDesc({ text, children }) {
  const t = useT()
  if (!text && !children) return null
  return (
    <details className="lib-details lib-tech">
      <summary>
        <IconChevron size={13} /> {t("admin.lib.techDesc")}
      </summary>
      <p className="lib-technote muted">{t("admin.lib.techNote")}</p>
      {text && (
        <p className="lib-fulldesc" data-source="technical" lang="vi">
          {text}
        </p>
      )}
      {children}
    </details>
  )
}

/** Plain on/off switch for a list row (label comes from aria-label). */
function RowSwitch({ checked, disabled, onChange, label, busy }) {
  return (
    <button type="button" role="switch" aria-checked={!!checked} aria-label={label} disabled={disabled || busy} className={`switch ${checked ? "on" : ""} ${busy ? "busy" : ""}`} onClick={() => onChange(!checked)}>
      <span className="switch-thumb" />
    </button>
  )
}

function Usage({ u, period }) {
  const t = useT()
  const w = u?.[period]
  if (!w || !w.calls) return <span className="lib-usage muted">{t("admin.lib.unused")}</span>
  return (
    <span className="lib-usage">
      <span>{t("admin.lib.calls", { count: w.calls, n: fmtNumber(w.calls) })}</span>
      <span className={w.errors ? "lib-err" : ""}>{t("admin.lib.errorRate", { pct: fmtNumber(w.errorRate * 100, { maximumFractionDigits: 0 }) })}</span>
      {w.medianMs != null && <span>{t("admin.lib.median", { d: fmtDuration(w.medianMs) })}</span>}
      <span title={fmtDateTime(w.lastUsed)}>{t("admin.lib.lastUsed", { when: relTime(w.lastUsed) })}</span>
    </span>
  )
}

function Changed({ c }) {
  const t = useT()
  if (!c) return null
  return (
    <span className="lib-changed" title={fmtDateTime(c.at)}>
      {t(c.enabled ? "admin.lib.enabledBy" : "admin.lib.disabledBy", { who: c.by || "?", when: relTime(c.at) })}
    </span>
  )
}

function Params({ params }) {
  const t = useT()
  if (!params?.length) return <p className="lib-noparams muted">{t("admin.lib.noParams")}</p>
  return (
    <ul className="lib-params">
      {params.map((p) => (
        <li key={p.name}>
          <code className="lib-pname">{p.name}</code>
          <span className="lib-ptype">{p.type}</span>
          {p.required && <span className="status-badge">{t("admin.lib.required")}</span>}
          {p.description && (
            <span className="lib-pdesc" data-source="technical">
              {p.description}
            </span>
          )}
          {p.enum && (
            <span className="lib-penum" data-source="technical">
              {p.enum.join(" · ")}
            </span>
          )}
        </li>
      ))}
    </ul>
  )
}

function ToolRow({ tool, period, onToggle, busy }) {
  const t = useT()
  const label = toolLabel(t, tool.name)
  return (
    <li className={`lib-item ${tool.enabled ? "" : "off"}`}>
      <div className="lib-main">
        <div className="lib-title">
          <strong>{label}</strong>
          <code className="lib-code" data-source="id">
            {tool.name}
          </code>
          {tool.locked && (
            <span className="status-badge" title={t("admin.lib.lockedTip")}>
              <IconLock size={11} /> {t("admin.lib.locked")}
            </span>
          )}
          {!tool.enabled && <span className="status-badge bad">{t("admin.lib.off")}</span>}
        </div>
        <p className={`lib-desc ${toolDesc(t, tool.name) ? "" : "muted"}`}>{toolDesc(t, tool.name) || t("admin.lib.noDesc")}</p>
        <div className="lib-meta">
          <Usage u={tool.usage} period={period} />
          <Changed c={tool.changed} />
        </div>
        <TechDesc text={tool.description}>
          <p className="lib-params-title">{t("admin.lib.params", { count: tool.params.length })}</p>
          <Params params={tool.params} />
        </TechDesc>
      </div>
      <div className="lib-ctl">
        <RowSwitch checked={tool.enabled} disabled={tool.locked} busy={busy} onChange={(v) => onToggle(tool, v)} label={t("admin.lib.toggleLabel", { name: label })} />
        <span className="lib-ctl-text" aria-hidden="true">
          {tool.locked ? t("admin.lib.alwaysOn") : tool.enabled ? t("admin.lib.on") : t("admin.lib.off")}
        </span>
      </div>
    </li>
  )
}

function SkillRow({ skill, period, onToggle, onView, busy }) {
  const t = useT()
  return (
    <li className={`lib-item ${skill.enabled ? "" : "off"}`}>
      <div className="lib-main">
        <div className="lib-title">
          <strong>{skillLabel(t, skill.name)}</strong>
          <code className="lib-code" data-source="id">
            {skill.name}
          </code>
          {skill.locked && (
            <span className="status-badge" title={t("admin.lib.lockedTip")}>
              <IconLock size={11} /> {t("admin.lib.locked")}
            </span>
          )}
          {!skill.enabled && <span className="status-badge bad">{t("admin.lib.off")}</span>}
        </div>
        <p className={`lib-desc ${skillDesc(t, skill.name) ? "" : "muted"}`}>{skillDesc(t, skill.name) || t("admin.lib.noDesc")}</p>
        <TechDesc text={skill.description} />
        <div className="lib-meta">
          <span className="lib-file">
            {formatBytes(skill.size)} · <span title={fmtDateTime(skill.modified)}>{t("admin.lib.modified", { when: relTime(skill.modified) })}</span>
          </span>
          <Usage u={skill.usage} period={period} />
          <Changed c={skill.changed} />
        </div>
        <button type="button" className="btn ghost xs lib-view" onClick={() => onView(skill.name)}>
          <IconBook size={13} /> {t("admin.lib.view")}
        </button>
      </div>
      <div className="lib-ctl">
        <RowSwitch checked={skill.enabled} disabled={skill.locked} busy={busy} onChange={(v) => onToggle(skill, v)} label={t("admin.lib.toggleLabel", { name: skillLabel(t, skill.name) })} />
        <span className="lib-ctl-text" aria-hidden="true">
          {skill.locked ? t("admin.lib.alwaysOn") : skill.enabled ? t("admin.lib.on") : t("admin.lib.off")}
        </span>
      </div>
    </li>
  )
}

function SkillViewer({ name, onClose }) {
  const t = useT()
  const [data, setData] = useState(null)
  const [err, setErr] = useState("")
  useEffect(() => {
    if (!name) return
    setData(null)
    setErr("")
    api.admin.library.skill(name).then(setData, (e) => setErr(e.message))
  }, [name])
  const html = useMemo(() => (data ? renderMarkdown(data.content) : ""), [data])
  return (
    <Dialog
      open={!!name}
      onClose={onClose}
      title={t("admin.lib.viewTitle", { name: name ? skillLabel(t, name) : "" })}
      labelledBy="lib-skill-title"
      className="lib-skill-dialog"
      actions={
        <button className="btn primary" onClick={onClose}>
          {t("common.close")}
        </button>
      }
    >
      <p className="set-row-desc">{t("admin.lib.readOnly")}</p>
      {err ? (
        <div className="form-error show" role="alert">
          {err}
        </div>
      ) : !data ? (
        <div className="skeleton line" style={{ height: 160 }} />
      ) : (
        <div className="md lib-skill-md" data-source="technical" dangerouslySetInnerHTML={{ __html: html }} />
      )}
    </Dialog>
  )
}

const TABS = ["tools", "skills"]

export default function AdminLibrary() {
  const t = useT()
  const toast = useToast()
  const [tab, setTab] = useState("tools")
  const [period, setPeriod] = useState("d7")
  const [filter, setFilter] = useState("all")
  const [needle, setNeedle] = useState("")
  const [tools, setTools] = useState(null)
  const [skills, setSkills] = useState(null)
  const [errs, setErrs] = useState({})
  const [busy, setBusy] = useState("")
  const [viewing, setViewing] = useState("")
  const [collapsed, setCollapsed] = useState({})
  const tabRefs = useRef({})

  const load = useCallback(() => {
    setErrs({})
    api.admin.library.tools().then(setTools, (e) => {
      setTools((x) => x || { tools: [] })
      setErrs((s) => ({ ...s, tools: e.message }))
    })
    api.admin.library.skills().then(setSkills, (e) => {
      setSkills((x) => x || { skills: [] })
      setErrs((s) => ({ ...s, skills: e.message }))
    })
  }, [])
  useEffect(load, [load])

  const toggle = async (kind, item, enabled) => {
    const key = `${kind}:${item.name}`
    setBusy(key)
    const patch = (list, over) => list.map((x) => (x.name === item.name ? { ...x, ...over } : x))
    const set = kind === "tools" ? setTools : setSkills
    set((d) => ({ ...d, [kind]: patch(d[kind], { enabled }) }))
    try {
      const r = kind === "tools" ? await api.admin.library.setTool(item.name, enabled) : await api.admin.library.setSkill(item.name, enabled)
      set((d) => ({ ...d, [kind]: patch(d[kind], { enabled: r.enabled, changed: r.changed }) }))
      const name = kind === "tools" ? toolLabel(t, item.name) : skillLabel(t, item.name)
      toast.success(t(enabled ? "admin.lib.savedOn" : "admin.lib.savedOff", { name }))
    } catch (e) {
      set((d) => ({ ...d, [kind]: patch(d[kind], { enabled: !enabled }) }))
      toast.error(e.message)
    } finally {
      setBusy("")
    }
  }

  const f = fold(needle.trim())
  const match = (item, extra = "") => (!f || fold(`${item.name} ${item.summary || item.description || ""} ${extra}`).includes(f)) && (filter === "all" || (filter === "on" ? item.enabled : !item.enabled))
  const skillMatch = (x) => match(x, `${skillLabel(t, x.name)} ${skillDesc(t, x.name)}`)
  const toolGroups = useMemo(() => {
    if (!tools?.tools) return []
    const order = tools.groups || []
    const by = new Map()
    for (const x of tools.tools) {
      if (!match(x, `${toolLabel(t, x.name)} ${toolDesc(t, x.name)} ${t(`admin.lib.group.${x.group}`)}`)) continue
      if (!by.has(x.group)) by.set(x.group, [])
      by.get(x.group).push(x)
    }
    return [...by.entries()].sort((a, b) => order.indexOf(a[0]) - order.indexOf(b[0]))
  }, [tools, f, filter, t]) // eslint-disable-line react-hooks/exhaustive-deps
  const skillList = useMemo(() => (skills?.skills || []).filter(skillMatch), [skills, f, filter]) // eslint-disable-line react-hooks/exhaustive-deps

  const counts = {
    tools: tools?.tools ? { total: tools.tools.length, off: tools.tools.filter((x) => !x.enabled).length } : null,
    skills: skills?.skills ? { total: skills.skills.length, off: skills.skills.filter((x) => !x.enabled).length } : null,
  }
  const onTabKey = (e) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft" && e.key !== "Home" && e.key !== "End") return
    e.preventDefault()
    const i = TABS.indexOf(tab)
    const n = e.key === "Home" ? 0 : e.key === "End" ? TABS.length - 1 : (i + (e.key === "ArrowRight" ? 1 : -1) + TABS.length) % TABS.length
    setTab(TABS[n])
    tabRefs.current[TABS[n]]?.focus()
  }
  const usageOff = tab === "tools" ? tools && tools.usageAvailable === false : skills && skills.usageAvailable === false
  const shown = tab === "tools" ? toolGroups.reduce((n, [, l]) => n + l.length, 0) : skillList.length

  return (
    <section className="admin-section lib" aria-labelledby="lib-h">
      <div className="admin-section-head">
        <h2 id="lib-h">
          <IconSettings size={18} /> {t("admin.lib.title")}
        </h2>
        <button className="icon-btn sm" onClick={load} aria-label={t("admin.lib.reload")} title={t("common.refresh")}>
          <IconRefresh size={15} />
        </button>
      </div>
      <p className="set-row-desc lib-intro">{t("admin.lib.intro")}</p>

      <div className="lib-tabs" role="tablist" aria-label={t("admin.lib.title")}>
        {TABS.map((k) => (
          <button
            key={k}
            ref={(el) => (tabRefs.current[k] = el)}
            id={`lib-tab-${k}`}
            role="tab"
            type="button"
            aria-selected={tab === k}
            aria-controls={`lib-pane-${k}`}
            tabIndex={tab === k ? 0 : -1}
            className={`lib-tab ${tab === k ? "on" : ""}`}
            onClick={() => setTab(k)}
            onKeyDown={onTabKey}
          >
            {t(`admin.lib.tab.${k}`)}
            {counts[k] && <span className="lib-count">{counts[k].off ? t("admin.lib.countOff", { total: counts[k].total, off: counts[k].off }) : counts[k].total}</span>}
          </button>
        ))}
      </div>

      <div className="lib-toolbar">
        <label className="admin-search lib-search">
          <IconSearch size={15} />
          <input value={needle} onChange={(e) => setNeedle(e.target.value)} placeholder={t(tab === "tools" ? "admin.lib.searchTools" : "admin.lib.searchSkills")} aria-label={t("admin.lib.searchLabel")} type="search" />
        </label>
        <Segmented label={t("admin.lib.filterLabel")} value={filter} onChange={setFilter} options={["all", "on", "off"].map((v) => ({ value: v, label: t(`admin.lib.filter.${v}`) }))} />
        <Segmented label={t("admin.lib.periodLabel")} value={period} onChange={setPeriod} options={[{ value: "d7", label: t("admin.lib.period7") }, { value: "d30", label: t("admin.lib.period30") }]} />
      </div>
      <p className="lib-note" role="note">
        {t(tab === "tools" ? "admin.lib.noteTools" : "admin.lib.noteSkills")}
        {usageOff ? ` ${t("admin.lib.usageUnavailable")}` : ""}
      </p>

      <div id={`lib-pane-${tab}`} role="tabpanel" aria-labelledby={`lib-tab-${tab}`} className="lib-pane">
        {errs[tab] && (
          <div className="list-sentinel" role="alert">
            {errs[tab]}{" "}
            <button className="link-btn" onClick={load}>
              {t("common.retry")}
            </button>
          </div>
        )}
        {tab === "tools" && tools?.browser && tools.browser !== "connected" && tools.tools?.some((x) => x.group === "browser") && <p className="lib-note warn">{t("admin.lib.browserDown")}</p>}
        {(tab === "tools" ? tools : skills) === null ? (
          [1, 2, 3].map((i) => <div key={i} className="stat skeleton" style={{ height: 84, marginBottom: 8 }} />)
        ) : shown === 0 && !errs[tab] ? (
          <p className="muted lib-empty">{t("admin.lib.noMatch")}</p>
        ) : tab === "tools" ? (
          toolGroups.map(([g, list]) => {
            const open = f ? true : !collapsed[g]
            return (
              <div key={g} className="lib-group">
                <h3>
                  <button type="button" className="lib-group-btn" aria-expanded={open} onClick={() => setCollapsed((c) => ({ ...c, [g]: open }))}>
                    <IconChevron size={14} className="lib-chev" />
                    <span>{t(`admin.lib.group.${g}`)}</span>
                    <span className="lib-count">{list.length}</span>
                  </button>
                </h3>
                {open && (
                  <ul className="lib-list">
                    {list.map((x) => (
                      <ToolRow key={x.name} tool={x} period={period} busy={busy === `tools:${x.name}`} onToggle={(item, v) => toggle("tools", item, v)} />
                    ))}
                  </ul>
                )}
              </div>
            )
          })
        ) : (
          <ul className="lib-list">
            {skillList.map((x) => (
              <SkillRow key={x.name} skill={x} period={period} busy={busy === `skills:${x.name}`} onToggle={(item, v) => toggle("skills", item, v)} onView={setViewing} />
            ))}
          </ul>
        )}
      </div>
      <SkillViewer name={viewing} onClose={() => setViewing("")} />
    </section>
  )
}

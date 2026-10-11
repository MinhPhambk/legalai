// Admin → Lab thử nghiệm: pilot products sketched on the platform (admin only). A product is a name, a purpose and a
// DRAFT configuration (welcome text, sample questions, persona prompt, tools / skills, model) – stored for thinking it
// through; nothing here changes the running assistant yet (server/lab.mjs).
import { useEffect, useMemo, useState } from "react"
import { api } from "../api.js"
import { navigate, relTime } from "../lib.js"
import { useT } from "../i18n.jsx"
import { Dialog, Segmented, useConfirm, useToast } from "../components/ui.jsx"
import { IconLeft, IconPlus, IconRefresh, IconSparkle, IconTrash, Spinner } from "../components/Icons.jsx"

const STATUSES = ["idea", "building", "pilot", "paused"]
const lines = (s) => String(s || "").split("\n").map((x) => x.trim()).filter(Boolean)

function StatusBadge({ s }) {
  const t = useT()
  return <span className={`lab-status lab-${s}`}>{t(`admin.lab.status.${s}`)}</span>
}

// ---- list -------------------------------------------------------------------------------------------
function LabList() {
  const t = useT()
  const toast = useToast()
  const [data, setData] = useState(null)
  const [err, setErr] = useState("")
  const [creating, setCreating] = useState(false)
  const [form, setForm] = useState({ name: "", tagline: "" })
  const [busy, setBusy] = useState(false)
  const [filter, setFilter] = useState("all")
  const load = () => api.admin.lab.list().then(setData, (e) => setErr(e.message))
  useEffect(() => { load() }, [])
  const create = async () => {
    if (!form.name.trim()) return
    setBusy(true)
    try {
      const r = await api.admin.lab.create({ name: form.name, tagline: form.tagline, status: "idea" })
      setCreating(false)
      setForm({ name: "", tagline: "" })
      navigate(`/admin/lab/${r.product.id}`)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  const shown = (data?.products || []).filter((p) => filter === "all" || p.status === filter)
  return (
    <section className="admin-section lab" aria-labelledby="lab-h">
      <div className="admin-section-head">
        <h2 id="lab-h">
          <IconSparkle size={18} /> {t("admin.lab.title")}
        </h2>
        <button className="icon-btn sm" onClick={load} aria-label={t("common.refresh")} title={t("common.refresh")}>
          <IconRefresh size={15} />
        </button>
        <button className="btn primary sm" onClick={() => setCreating(true)}>
          <IconPlus size={14} /> {t("admin.lab.new")}
        </button>
      </div>
      <p className="set-row-desc">{t("admin.lab.intro")}</p>
      <div className="lab-filter">
        <Segmented value={filter} onChange={setFilter} label={t("admin.lab.filter")} options={[{ value: "all", label: t("admin.lab.all") }, ...STATUSES.map((s) => ({ value: s, label: t(`admin.lab.status.${s}`) }))]} />
      </div>
      {err && <p className="form-error">{err}</p>}
      {!data && !err && <Spinner />}
      {data && !data.products.length && (
        <div className="lab-empty adm-card">
          <p>{t("admin.lab.empty")}</p>
          <button className="btn primary sm" onClick={() => setCreating(true)}>
            <IconPlus size={14} /> {t("admin.lab.new")}
          </button>
        </div>
      )}
      {data && data.products.length > 0 && !shown.length && <p className="muted">{t("admin.lab.noneInFilter")}</p>}
      <ul className="lab-grid">
        {shown.map((p) => (
          <li key={p.id}>
            <a className="lab-card" href={`/admin/lab/${p.id}`} onClick={(e) => (e.preventDefault(), navigate(`/admin/lab/${p.id}`))}>
              <span className="lab-card-top">
                <strong>{p.name}</strong>
                <StatusBadge s={p.status} />
              </span>
              <span className="lab-card-tag">{p.tagline || <span className="muted">{t("admin.lab.noTagline")}</span>}</span>
              <span className="lab-card-meta muted">
                {t("admin.lab.counts", { tools: (p.tools || []).length, skills: (p.skills || []).length })} · {t("admin.lab.updated", { when: relTime(p.updatedAt) })}
              </span>
            </a>
          </li>
        ))}
      </ul>
      <Dialog
        open={creating}
        title={t("admin.lab.newTitle")}
        onClose={() => setCreating(false)}
        actions={
          <>
            <button className="btn" onClick={() => setCreating(false)}>{t("common.cancel")}</button>
            <button className="btn primary" disabled={!form.name.trim() || busy} onClick={create}>{busy ? <Spinner size={13} /> : t("admin.lab.create")}</button>
          </>
        }
      >
        <label className="field">
          <span>{t("admin.lab.f.name")}</span>
          <input autoFocus value={form.name} maxLength={120} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder={t("admin.lab.ph.name")} onKeyDown={(e) => e.key === "Enter" && create()} />
        </label>
        <label className="field">
          <span>{t("admin.lab.f.tagline")}</span>
          <input value={form.tagline} maxLength={300} onChange={(e) => setForm({ ...form, tagline: e.target.value })} placeholder={t("admin.lab.ph.tagline")} />
        </label>
      </Dialog>
    </section>
  )
}

// ---- detail -----------------------------------------------------------------------------------------
function Pick({ items, value, onToggle, label }) {
  const [q, setQ] = useState("")
  const t = useT()
  const set = new Set(value)
  // selected ones first, then the rest in library order
  const shown = items.filter((x) => !q || `${x.name} ${x.summary || ""}`.toLowerCase().includes(q.toLowerCase())).sort((a, b) => Number(set.has(b.name)) - Number(set.has(a.name)))
  return (
    <div className="lab-pick">
      <div className="lab-pick-head">
        <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("admin.lab.search")} aria-label={label} />
        <span className="muted">{t("admin.lab.picked", { n: value.length, total: items.length })}</span>
      </div>
      <ul>
        {shown.map((x) => (
          <li key={x.name}>
            <label title={x.summary || ""}>
              <input type="checkbox" checked={set.has(x.name)} onChange={(e) => onToggle(x.name, e.target.checked)} />
              <code>{x.name}</code>
              {x.summary && <span className="muted"> – {x.summary.slice(0, 90)}</span>}
            </label>
          </li>
        ))}
      </ul>
    </div>
  )
}

function LabDetail({ id }) {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const [p, setP] = useState(null)
  const [saved, setSaved] = useState(null)
  const [err, setErr] = useState("")
  const [busy, setBusy] = useState(false)
  const [lib, setLib] = useState({ tools: [], skills: [], models: [] })
  useEffect(() => {
    api.admin.lab.get(id).then((r) => { setP(r.product); setSaved(r.product) }, (e) => setErr(e.message))
    Promise.allSettled([api.admin.library.tools(), api.admin.library.skills(), api.admin.models()]).then(([a, b, c]) =>
      setLib({ tools: a.value?.tools || [], skills: b.value?.skills || [], models: c.value?.models || [] }))
  }, [id])
  const dirty = useMemo(() => p && saved && JSON.stringify(p) !== JSON.stringify(saved), [p, saved])
  useEffect(() => {
    const warn = (e) => { if (dirty) { e.preventDefault(); e.returnValue = "" } }
    window.addEventListener("beforeunload", warn)
    return () => window.removeEventListener("beforeunload", warn)
  }, [dirty])
  if (err) return <p className="form-error">{err}</p>
  if (!p) return <Spinner />
  // functional updates: several quick changes never overwrite each other
  const up = (k) => (e) => { const v = e?.target ? e.target.value : e; setP((cur) => ({ ...cur, [k]: v })) }
  const toggle = (k) => (name, on) => setP((cur) => { const list = cur[k] || []; return { ...cur, [k]: on ? [...new Set([...list, name])] : list.filter((v) => v !== name) } })
  const save = async () => {
    setBusy(true)
    try {
      const body = { ...p, examples: lines(p.examplesText ?? (p.examples || []).join("\n")) }
      delete body.examplesText
      const r = await api.admin.lab.update(id, body)
      setP(r.product)
      setSaved(r.product)
      toast.success(t("admin.lab.saved"))
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  const remove = async () => {
    if (!(await confirm({ title: t("admin.lab.deleteTitle"), body: t("admin.lab.deleteBody", { name: p.name }), confirmLabel: t("admin.lab.delete"), danger: true }))) return
    await api.admin.lab.remove(id).catch((e) => toast.error(e.message))
    navigate("/admin/lab")
  }
  const back = async () => {
    if (dirty && !(await confirm({ title: t("admin.lab.leaveTitle"), body: t("admin.lab.leaveBody"), confirmLabel: t("admin.lab.leave") }))) return
    navigate("/admin/lab")
  }
  const examplesText = p.examplesText ?? (p.examples || []).join("\n")
  return (
    <section className="admin-section lab lab-detail" aria-labelledby="lab-d-h">
      <div className="admin-section-head">
        <button className="btn ghost sm" onClick={back}>
          <IconLeft size={15} /> {t("admin.lab.back")}
        </button>
        <h2 id="lab-d-h">{p.name || t("admin.lab.untitled")}</h2>
        <StatusBadge s={p.status} />
        <span className="lab-actions">
          {dirty && <span className="muted">{t("admin.lab.unsaved")}</span>}
          <button className="btn primary sm" disabled={!dirty || busy || !p.name?.trim()} onClick={save}>{busy ? <Spinner size={13} /> : t("admin.lab.save")}</button>
          <button className="btn ghost sm danger" onClick={remove} aria-label={t("admin.lab.delete")} title={t("admin.lab.delete")}><IconTrash size={14} /></button>
        </span>
      </div>
      <p className="muted lab-meta">{t("admin.lab.createdUpdated", { created: relTime(p.createdAt), updated: relTime(p.updatedAt) })}</p>

      <div className="adm-card">
        <h3>{t("admin.lab.s.basic")}</h3>
        <label className="field"><span>{t("admin.lab.f.name")}</span><input value={p.name} maxLength={120} onChange={up("name")} /></label>
        <label className="field"><span>{t("admin.lab.f.tagline")}</span><input value={p.tagline || ""} maxLength={300} onChange={up("tagline")} placeholder={t("admin.lab.ph.tagline")} /></label>
        <div className="field"><span>{t("admin.lab.f.status")}</span>
          <Segmented value={p.status} onChange={up("status")} label={t("admin.lab.f.status")} options={STATUSES.map((s) => ({ value: s, label: t(`admin.lab.status.${s}`) }))} />
        </div>
      </div>

      <div className="adm-card">
        <h3>{t("admin.lab.s.idea")}</h3>
        <label className="field"><span>{t("admin.lab.f.goal")}</span><textarea rows={3} value={p.goal || ""} onChange={up("goal")} placeholder={t("admin.lab.ph.goal")} /></label>
        <label className="field"><span>{t("admin.lab.f.audience")}</span><textarea rows={2} value={p.audience || ""} onChange={up("audience")} placeholder={t("admin.lab.ph.audience")} /></label>
        <label className="field"><span>{t("admin.lab.f.notes")}</span><textarea rows={8} value={p.notes || ""} onChange={up("notes")} placeholder={t("admin.lab.ph.notes")} /></label>
      </div>

      <div className="adm-card">
        <h3>{t("admin.lab.s.draft")}</h3>
        <p className="set-row-desc lab-draft-note">{t("admin.lab.draftNote")}</p>
        <label className="field"><span>{t("admin.lab.f.welcome")}</span><input value={p.welcome || ""} maxLength={1000} onChange={up("welcome")} placeholder={t("admin.lab.ph.welcome")} /></label>
        <label className="field"><span>{t("admin.lab.f.examples")}</span><textarea rows={4} value={examplesText} onChange={(e) => { const v = e.target.value; setP((cur) => ({ ...cur, examplesText: v })) }} placeholder={t("admin.lab.ph.examples")} /></label>
        <label className="field"><span>{t("admin.lab.f.prompt")}</span><textarea rows={8} className="mono" value={p.prompt || ""} onChange={up("prompt")} placeholder={t("admin.lab.ph.prompt")} /></label>
        <label className="field"><span>{t("admin.lab.f.model")}</span>
          <select value={p.model || ""} onChange={up("model")}>
            <option value="">{t("admin.lab.modelDefault")}</option>
            {lib.models.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        </label>
        <div className="field"><span>{t("admin.lab.f.tools")}</span><Pick items={lib.tools} value={p.tools || []} onToggle={toggle("tools")} label={t("admin.lab.f.tools")} /></div>
        <div className="field"><span>{t("admin.lab.f.skills")}</span><Pick items={lib.skills} value={p.skills || []} onToggle={toggle("skills")} label={t("admin.lab.f.skills")} /></div>
      </div>
    </section>
  )
}

export default function AdminLab({ id }) {
  return id ? <LabDetail id={id} key={id} /> : <LabList />
}

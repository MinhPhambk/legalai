// Lab thử nghiệm (/lab, /lab/:id) – shown inside the chat app (admin only): a list of pilot products and, for each
// product, a blank workspace where its own UI will be built (e.g. "AI tạo slide từ tài liệu"). Data: server/lab.mjs.
import { useEffect, useState } from "react"
import { api } from "../api.js"
import { navigate, relTime } from "../lib.js"
import { useT } from "../i18n.jsx"
import { Dialog, useConfirm, useToast } from "./ui.jsx"
import { IconLeft, IconPlus, IconSparkle, IconTrash, Spinner } from "./Icons.jsx"

function NewProduct({ open, onClose }) {
  const t = useT()
  const toast = useToast()
  const [f, setF] = useState({ name: "", tagline: "" })
  const [busy, setBusy] = useState(false)
  const create = async () => {
    if (!f.name.trim() || busy) return
    setBusy(true)
    try {
      const r = await api.admin.lab.create({ name: f.name, tagline: f.tagline })
      setF({ name: "", tagline: "" })
      onClose()
      navigate(`/lab/${r.product.id}`)
    } catch (e) {
      toast.error(e.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog
      open={open}
      title={t("lab.newTitle")}
      onClose={onClose}
      actions={
        <>
          <button className="btn" onClick={onClose}>{t("common.cancel")}</button>
          <button className="btn primary" disabled={!f.name.trim() || busy} onClick={create}>{busy ? <Spinner size={13} /> : t("lab.create")}</button>
        </>
      }
    >
      <label className="field">
        <span>{t("lab.name")}</span>
        <input autoFocus value={f.name} maxLength={120} placeholder={t("lab.namePh")} onChange={(e) => setF({ ...f, name: e.target.value })} onKeyDown={(e) => e.key === "Enter" && create()} />
      </label>
      <label className="field">
        <span>{t("lab.tagline")}</span>
        <input value={f.tagline} maxLength={300} placeholder={t("lab.taglinePh")} onChange={(e) => setF({ ...f, tagline: e.target.value })} onKeyDown={(e) => e.key === "Enter" && create()} />
      </label>
    </Dialog>
  )
}

function LabHome() {
  const t = useT()
  const [list, setList] = useState(null)
  const [err, setErr] = useState("")
  const [creating, setCreating] = useState(false)
  useEffect(() => { api.admin.lab.list().then((r) => setList(r.products), (e) => setErr(e.message)) }, [])
  return (
    <div className="lab-page">
      <div className="lab-head">
        <h1><IconSparkle size={20} /> {t("lab.title")}</h1>
        <button className="btn primary sm" onClick={() => setCreating(true)}><IconPlus size={14} /> {t("lab.new")}</button>
      </div>
      <p className="lab-sub">{t("lab.intro")}</p>
      {err && <p className="form-error">{err}</p>}
      {!list && !err && <Spinner />}
      {list && !list.length && (
        <div className="lab-blank">
          <p>{t("lab.empty")}</p>
          <button className="btn sm" onClick={() => setCreating(true)}><IconPlus size={14} /> {t("lab.new")}</button>
        </div>
      )}
      {list?.length > 0 && (
        <ul className="lab-list">
          {list.map((p) => (
            <li key={p.id}>
              <a href={`/lab/${p.id}`} onClick={(e) => (e.preventDefault(), navigate(`/lab/${p.id}`))}>
                <strong>{p.name}</strong>
                {p.tagline && <span className="lab-tag">{p.tagline}</span>}
                <span className="lab-when">{relTime(p.updatedAt)}</span>
              </a>
            </li>
          ))}
        </ul>
      )}
      <NewProduct open={creating} onClose={() => setCreating(false)} />
    </div>
  )
}

function LabProduct({ id }) {
  const t = useT()
  const toast = useToast()
  const confirm = useConfirm()
  const [p, setP] = useState(null)
  const [err, setErr] = useState("")
  useEffect(() => { api.admin.lab.get(id).then((r) => setP(r.product), (e) => setErr(e.message)) }, [id])
  // name / description are edited in place and saved when the field loses focus
  const saveField = async (k, v) => {
    const val = v.trim()
    if (k === "name" && !val) return
    if ((p[k] || "") === val) return
    try {
      const r = await api.admin.lab.update(id, { [k]: val })
      setP(r.product)
    } catch (e) {
      toast.error(e.message)
    }
  }
  const remove = async () => {
    if (!(await confirm({ title: t("lab.deleteTitle"), body: t("lab.deleteBody", { name: p.name }), confirmLabel: t("lab.delete"), danger: true }))) return
    await api.admin.lab.remove(id).catch((e) => toast.error(e.message))
    navigate("/lab")
  }
  if (err) return <div className="lab-page"><p className="form-error">{err}</p></div>
  if (!p) return <div className="lab-page"><Spinner /></div>
  return (
    <div className="lab-page lab-product">
      <div className="lab-head">
        <button className="btn ghost sm" onClick={() => navigate("/lab")}><IconLeft size={15} /> {t("lab.title")}</button>
        <button className="icon-btn sm" onClick={remove} aria-label={t("lab.delete")} title={t("lab.delete")}><IconTrash size={15} /></button>
      </div>
      <input className="lab-title-in" defaultValue={p.name} maxLength={120} aria-label={t("lab.name")} onBlur={(e) => saveField("name", e.target.value)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
      <input className="lab-tag-in" defaultValue={p.tagline || ""} maxLength={300} placeholder={t("lab.taglinePh")} aria-label={t("lab.tagline")} onBlur={(e) => saveField("tagline", e.target.value)} onKeyDown={(e) => e.key === "Enter" && e.currentTarget.blur()} />
      <div className="lab-canvas" aria-label={t("lab.canvas")}>
        <p>{t("lab.canvasEmpty")}</p>
      </div>
    </div>
  )
}

export default function LabView({ id }) {
  return id ? <LabProduct id={id} key={id} /> : <LabHome />
}

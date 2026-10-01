// Admin → Người dùng: users table (search, paging in the URL), create, one-time password reset, roles, lock, delete.
import { useCallback, useEffect, useState } from "react"
import { api } from "../api.js"
import { copyText, relTime } from "../lib.js"
import { Trans, useT } from "../i18n.jsx"
import { Dialog, Pager, Switch, useConfirm, useQueryState, useToast } from "../components/ui.jsx"
import { IconCheck, IconCopy, IconLock, IconPlus, IconSearch, IconTrash, IconUsers, Spinner } from "../components/Icons.jsx"

function OneTimePassword({ data, onClose }) {
  const t = useT()
  const [copied, setCopied] = useState(false)
  return (
    <Dialog
      open={!!data}
      onClose={onClose}
      title={data?.title}
      labelledBy="otp-title"
      actions={
        <button className="btn primary" onClick={onClose}>
          {t("admin.otp.done")}
        </button>
      }
    >
      <p>
        <Trans k="admin.otp.body" vars={{ email: data?.email || "" }} components={{ b: <strong /> }} />
      </p>
      <div className="otp">
        <code>{data?.password}</code>
        <button
          className="btn ghost sm"
          onClick={async () => {
            if (await copyText(data.password)) {
              setCopied(true)
              setTimeout(() => setCopied(false), 1500)
            }
          }}
        >
          {copied ? <IconCheck size={14} /> : <IconCopy size={14} />} {copied ? t("common.copiedShort") : t("common.copy")}
        </button>
      </div>
    </Dialog>
  )
}

function CreateUser({ open, onClose, onCreated }) {
  const toast = useToast()
  const t = useT()
  const [email, setEmail] = useState("")
  const [admin, setAdmin] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState("")
  useEffect(() => {
    if (open) {
      setEmail("")
      setAdmin(false)
      setErr("")
    }
  }, [open])
  const submit = async (e) => {
    e.preventDefault()
    setBusy(true)
    setErr("")
    try {
      const r = await api.admin.createUser({ email, isAdmin: admin })
      onCreated(r)
      toast.success(t("admin.create.done"))
    } catch (e2) {
      setErr(e2.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <Dialog open={open} onClose={onClose} title={t("admin.create.title")} labelledBy="cu-title">
      <form onSubmit={submit} className="auth-form">
        <div className="field">
          <label htmlFor="cu-email">{t("auth.email")}</label>
          <input id="cu-email" className="input" type="email" value={email} onChange={(e) => setEmail(e.target.value)} required data-autofocus placeholder={t("auth.emailPlaceholder")} />
        </div>
        <Switch id="cu-admin" label={t("admin.create.adminRole")} description={t("admin.create.adminRoleDesc")} checked={admin} onChange={setAdmin} />
        <p className="set-row-desc">{t("admin.create.passwordNote")}</p>
        {err && (
          <div className="form-error show" role="alert">
            {err}
          </div>
        )}
        <div className="dialog-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {t("common.cancel")}
          </button>
          <button className="btn primary" disabled={busy || !email}>
            {busy ? <Spinner size={14} /> : <IconPlus size={15} />} {t("admin.create.submit")}
          </button>
        </div>
      </form>
    </Dialog>
  )
}


export default function AdminUsers() {
  const toast = useToast()
  const t = useT()
  const confirm = useConfirm()
  const [users, setUsers] = useState(null)
  // Filters and paging live in the URL (?q=&page=&size=)
  const [qs, setQs] = useQueryState({ q: "", page: "1", size: "20" })
  const q = qs.q
  const setQ = (v) => setQs({ q: v, page: "1" })
  const [meta, setMeta] = useState({ total: 0, pages: 1 })
  const [listErr, setListErr] = useState(false)
  const [otp, setOtp] = useState(null)
  const [creating, setCreating] = useState(false)
  const loadUsers = useCallback(
    (term) =>
      api.admin.users(term, Number(qs.page) || 1, Number(qs.size) || 20).then(
        (r) => {
          setUsers(r.users)
          setMeta({ total: r.total, pages: r.pages })
          setListErr(false)
        },
        () => {
          setListErr(true)
          setUsers((u) => u || [])
        },
      ),
    [qs.page, qs.size],
  )
  useEffect(() => {
    const timer = setTimeout(() => loadUsers(q), 200)
    return () => clearTimeout(timer)
  }, [q, loadUsers])

  const reset = async (u) => {
    const ok = await confirm({ title: t("admin.reset.title"), body: t("admin.reset.body", { email: u.email }), confirmLabel: t("admin.reset.confirm") })
    if (!ok) return
    try {
      const r = await api.admin.resetPassword(u.id)
      setOtp({ title: t("admin.otp.newPassword"), email: u.email, password: r.password })
    } catch (e) {
      toast.error(e.message)
    }
  }
  const toggleDisabled = async (u) => {
    if (!u.disabled) {
      const ok = await confirm({ title: t("admin.lock.title"), body: t("admin.lock.body", { email: u.email }), confirmLabel: t("admin.lock.confirm"), danger: true })
      if (!ok) return
    }
    try {
      await api.admin.updateUser(u.id, { disabled: !u.disabled })
      loadUsers(q)
    } catch (e) {
      toast.error(e.message)
    }
  }
  const toggleAdmin = async (u) => {
    const ok = await confirm({
      title: u.isAdmin ? t("admin.adminRole.revokeTitle") : t("admin.adminRole.grantTitle"),
      body: u.isAdmin ? t("admin.adminRole.revokeBody", { email: u.email }) : t("admin.adminRole.grantBody", { email: u.email }),
      confirmLabel: t("common.ok"),
    })
    if (!ok) return
    try {
      await api.admin.updateUser(u.id, { isAdmin: !u.isAdmin })
      loadUsers(q)
    } catch (e) {
      toast.error(e.message)
    }
  }
  const toggleExpert = async (u) => {
    try {
      await api.admin.updateUser(u.id, { isExpert: !u.isExpert })
      toast.success(u.isExpert ? t("admin.expertRole.revoked") : t("admin.expertRole.granted"))
      loadUsers(q)
    } catch (e) {
      toast.error(e.message)
    }
  }
  const remove = async (u) => {
    const ok = await confirm({
      title: t("admin.delete.title"),
      body: t("admin.delete.body", { email: u.email, count: u.chats }),
      confirmLabel: t("common.delete"),
      danger: true,
      typed: u.email,
    })
    if (!ok) return
    try {
      await api.admin.deleteUser(u.id)
      toast.success(t("admin.delete.done"))
      loadUsers(q)
    } catch (e) {
      toast.error(e.message)
    }
  }

  return (
    <>
          <section className="admin-section" id="admin-users">
            <div className="admin-section-head">
              <h2>
                <IconUsers size={18} /> {t("admin.users")}
              </h2>
              <div className="admin-tools">
                <label className="admin-search">
                  <IconSearch size={15} />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={t("admin.searchPlaceholder")} aria-label={t("admin.searchLabel")} />
                </label>
                <button className="btn primary sm" onClick={() => setCreating(true)}>
                  <IconPlus size={15} /> {t("admin.create.title")}
                </button>
              </div>
            </div>
            <p className="set-row-desc adm-note">{t("admin.console.desc.users")}</p>
            <div className="table-wrap admin-table">
              <table>
                <thead>
                  <tr>
                    <th>{t("admin.col.user")}</th>
                    <th>{t("admin.col.role")}</th>
                    <th>{t("admin.col.status")}</th>
                    <th className="num">{t("admin.col.chats")}</th>
                    <th>{t("admin.col.activity")}</th>
                    <th className="actions">
                      <span className="sr-only">{t("admin.col.actions")}</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {users === null
                    ? [1, 2, 3].map((i) => (
                        <tr key={i}>
                          <td colSpan={6}>
                            <div className="skeleton line" />
                          </td>
                        </tr>
                      ))
                    : users.map((u) => (
                        <tr key={u.id} className={u.disabled ? "is-disabled" : ""}>
                          <td>
                            <div className="u-cell">
                              <span className="avatar sm">{(u.displayName || u.email).slice(0, 1).toUpperCase()}</span>
                              <span>
                                <span className="u-email">{u.email}</span>
                                {u.displayName && <span className="u-name">{u.displayName}</span>}
                              </span>
                            </div>
                          </td>
                          <td>
                            {u.isAdmin && <span className="status-badge">{t("admin.role.admin")}</span>} {u.isExpert && <span className="status-badge">{t("admin.role.expert")}</span>}
                            {!u.isAdmin && !u.isExpert && t("admin.role.member")}
                          </td>
                          <td>{u.disabled ? <span className="status-badge bad">{t("admin.state.locked")}</span> : <span className="status-badge ok">{t("admin.state.active")}</span>}</td>
                          <td className="num">{u.chats}</td>
                          <td className="muted">{u.lastPromptAt ? relTime(u.lastPromptAt) : u.lastLoginAt ? t("admin.signedIn", { when: relTime(u.lastLoginAt) }) : t("admin.neverUsed")}</td>
                          <td className="actions">
                            <button className="btn ghost xs" onClick={() => reset(u)} title={t("admin.reset.tip")}>
                              <IconLock size={13} /> {t("admin.reset.short")}
                            </button>
                            <button className="btn ghost xs" onClick={() => toggleExpert(u)}>
                              {u.isExpert ? t("admin.expertRole.revoke") : t("admin.expertRole.grant")}
                            </button>
                            {!u.self && (
                              <>
                                <button className="btn ghost xs" onClick={() => toggleAdmin(u)}>
                                  {u.isAdmin ? t("admin.adminRole.revoke") : t("admin.adminRole.grant")}
                                </button>
                                <button className="btn ghost xs" onClick={() => toggleDisabled(u)}>
                                  {u.disabled ? t("admin.lock.unlock") : t("admin.lock.confirm")}
                                </button>
                                <button className="icon-btn sm" onClick={() => remove(u)} aria-label={t("admin.delete.label", { email: u.email })} title={t("common.delete")}>
                                  <IconTrash size={15} />
                                </button>
                              </>
                            )}
                            {u.self && <span className="muted small">{t("admin.you")}</span>}
                          </td>
                        </tr>
                      ))}
                  {users?.length === 0 && (
                    <tr>
                      <td colSpan={6} className="muted">
                        {t("admin.noMatch", { q })}
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            {listErr && (
              <div className="list-sentinel" role="alert">
                {t("admin.loadFailed")}{" "}
                <button className="link-btn" onClick={() => loadUsers(q)}>
                  {t("common.retry")}
                </button>
              </div>
            )}
            <Pager page={Number(qs.page) || 1} pages={meta.pages} size={Number(qs.size) || 20} total={meta.total} unit="admin.usersCount" onPage={(p) => setQs({ page: String(p) })} onSize={(n) => setQs({ size: String(n), page: "1" })} />
          </section>
      <CreateUser
        open={creating}
        onClose={() => setCreating(false)}
        onCreated={(r) => {
          setCreating(false)
          loadUsers(q)
          if (r.password) setOtp({ title: t("admin.otp.created"), email: r.user.email, password: r.password })
        }}
      />
      <OneTimePassword data={otp} onClose={() => setOtp(null)} />
    </>
  )
}

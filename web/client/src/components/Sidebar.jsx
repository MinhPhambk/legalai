import { useEffect, useMemo, useRef, useState } from "react"
import { groupChats, modKey, navigate, useThemePref } from "../lib.js"
import { useApp } from "../settings.jsx"
import { useT } from "../i18n.jsx"
import { Popover, useConfirm } from "./ui.jsx"
import {
  IconClose, IconInfo, IconKeyboard, IconLogout, IconMonitor, IconMoon, IconMore, IconNew, IconPencil, IconPin, IconSearch, IconSettings,
  IconShare, IconShield, IconSun, IconTrash, IconChevron, Spinner,
} from "./Icons.jsx"
import { TechlabLogo } from "./Logo.jsx"

function ChatItem({ chat, active, onSelect, onRename, onDelete, onPin, onShare }) {
  const t = useT()
  const [menu, setMenu] = useState(false)
  const [editing, setEditing] = useState(false)
  const [value, setValue] = useState(chat.title)
  const btnRef = useRef(null)
  const inputRef = useRef(null)
  useEffect(() => {
    if (editing) {
      inputRef.current?.focus()
      inputRef.current?.select()
    }
  }, [editing])
  const commit = () => {
    const v = value.trim()
    setEditing(false)
    if (v && v !== chat.title) onRename(chat, v)
    else setValue(chat.title)
  }
  const item = (label, icon, fn, cls = "") => (
    <button
      role="menuitem"
      className={`menu-item ${cls}`}
      onClick={() => {
        setMenu(false)
        fn()
      }}
    >
      {icon} {label}
    </button>
  )
  return (
    <li className={`chat-item ${active ? "active" : ""} ${menu ? "menu-open" : ""}`}>
      {editing ? (
        <input
          ref={inputRef}
          className="chat-rename"
          value={value}
          maxLength={120}
          aria-label={t("sidebar.renameLabel")}
          onChange={(e) => setValue(e.target.value)}
          onBlur={commit}
          onKeyDown={(e) => {
            if (e.key === "Enter") commit()
            if (e.key === "Escape") {
              setValue(chat.title)
              setEditing(false)
            }
          }}
        />
      ) : (
        <a
          href={`/c/${chat.id}`}
          className="chat-link"
          aria-current={active ? "page" : undefined}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return
            e.preventDefault()
            onSelect(chat)
          }}
          title={chat.title}
        >
          {chat.pinned && <IconPin size={13} className="chat-pin-icon" aria-label={t("sidebar.pinned")} />}
          <span className="chat-title" data-source="user">
            {chat.title}
          </span>
          {chat.unread > 0 && <span className="chat-unread" aria-label={t("sidebar.unreadExpert", { count: chat.unread })} />}
        </a>
      )}
      {!editing && (
        <button ref={btnRef} className="icon-btn sm chat-more" aria-label={t("sidebar.optionsFor", { title: chat.title })} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu((m) => !m)}>
          <IconMore size={16} />
        </button>
      )}
      <Popover open={menu} onClose={() => setMenu(false)} anchorRef={btnRef} className="chat-menu" label={t("sidebar.chatOptions")}>
        {item(chat.pinned ? t("sidebar.unpin") : t("sidebar.pin"), <IconPin size={16} />, () => onPin(chat, !chat.pinned))}
        {item(t("common.share"), <IconShare size={16} />, () => onShare(chat))}
        {item(t("sidebar.rename"), <IconPencil size={16} />, () => {
          setValue(chat.title)
          setEditing(true)
        })}
        <div className="menu-sep" role="separator" />
        {item(t("common.delete"), <IconTrash size={16} />, () => onDelete(chat), "danger")}
      </Popover>
    </li>
  )
}

function UserMenu({ user, onLogout }) {
  const t = useT()
  const [open, setOpen] = useState(false)
  const [pref, setPref] = useThemePref()
  const { openDialog } = useApp()
  const ref = useRef(null)
  const name = user.displayName || user.email
  const initial = (name || "?").slice(0, 1).toUpperCase()
  const themes = [
    { k: "light", label: t("theme.light"), icon: <IconSun size={16} /> },
    { k: "dark", label: t("theme.dark"), icon: <IconMoon size={16} /> },
    { k: "system", label: t("theme.systemLong"), icon: <IconMonitor size={16} /> },
  ]
  const go = (fn) => () => {
    setOpen(false)
    fn()
  }
  return (
    <div className="user-menu">
      <button ref={ref} className="user-btn" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="avatar" aria-hidden="true">
          {initial}
        </span>
        <span className="user-id">
          <span className="user-name">{name}</span>
          {user.displayName && <span className="user-email">{user.email}</span>}
        </span>
      </button>
      <Popover open={open} onClose={() => setOpen(false)} anchorRef={ref} className="user-pop" label={t("sidebar.account")}>
        <button role="menuitem" className="menu-item" onClick={go(() => openDialog("settings:general"))}>
          <IconSettings size={16} /> {t("settings.title")}
        </button>
        <button role="menuitem" className="menu-item" onClick={go(() => openDialog("shortcuts"))}>
          <IconKeyboard size={16} /> {t("shortcuts.title")} <kbd className="menu-kbd">?</kbd>
        </button>
        <button role="menuitem" className="menu-item" onClick={go(() => openDialog("about"))}>
          <IconInfo size={16} /> {t("about.link")}
        </button>
        {(user.isExpert || user.isAdmin) && (
          <button role="menuitem" className="menu-item" onClick={go(() => navigate("/expert"))}>
            <IconShield size={16} /> {t("expert.navTitle")}
          </button>
        )}
        {user.isAdmin && (
          <button role="menuitem" className="menu-item" onClick={go(() => navigate("/admin"))}>
            <IconShield size={16} /> {t("admin.title")}
          </button>
        )}
        <div className="menu-sep" role="separator" />
        <div className="menu-label">{t("theme.label")}</div>
        {themes.map((th) => (
          <button key={th.k} role="menuitemradio" aria-checked={pref === th.k} className={`menu-item ${pref === th.k ? "checked" : ""}`} onClick={() => setPref(th.k)}>
            {th.icon} {th.label}
            <span className="menu-check" aria-hidden="true" />
          </button>
        ))}
        <div className="menu-sep" role="separator" />
        <button role="menuitem" className="menu-item" onClick={go(onLogout)}>
          <IconLogout size={16} /> {t("sidebar.logout")}
        </button>
      </Popover>
    </div>
  )
}

export default function Sidebar({ open, onClose, chats, loading, activeId, onNew, onSelect, onRename, onDelete, onPin, onShare, user, onLogout, notif, paging }) {
  const listRef = useRef(null)
  const { openDialog } = useApp()
  const confirm = useConfirm()
  const t = useT()
  const pinned = useMemo(() => (chats || []).filter((c) => c.pinned).sort((a, b) => b.pinnedAt - a.pinnedAt), [chats])
  const groups = useMemo(() => groupChats((chats || []).filter((c) => !c.pinned)), [chats])
  const [openOlder, setOpenOlder] = useState(null) // null = default (collapsed unless the open chat is in it)
  const askDelete = async (c) => {
    const ok = await confirm({
      title: t("sidebar.deleteTitle"),
      body: t("sidebar.deleteBody", { title: c.title }),
      confirmLabel: t("common.delete"),
      danger: true,
    })
    if (ok) onDelete(c)
  }
  const list = (items) => (
    <ul>
      {items.map((c) => (
        <ChatItem key={c.id} chat={c} active={c.id === activeId} onSelect={onSelect} onRename={onRename} onDelete={askDelete} onPin={onPin} onShare={onShare} />
      ))}
    </ul>
  )
  return (
    <>
      <div className={`sidebar-overlay ${open ? "show" : ""}`} onClick={onClose} aria-hidden="true" />
      <aside className={`sidebar ${open ? "open" : ""}`} aria-label={t("sidebar.label")}>
        <div className="sidebar-head">
          <a
            className="brand"
            href="/"
            onClick={(e) => {
              e.preventDefault()
              onNew()
            }}
          >
            <TechlabLogo height={28} />
            <span className="brand-name">LegalAI</span>
          </a>
          <button className="icon-btn sidebar-close" onClick={onClose} aria-label={t("sidebar.close")}>
            <IconClose />
          </button>
        </div>
        <div className="sidebar-actions">
          <button className="new-chat" onClick={onNew}>
            <IconNew size={17} />
            <span>{t("chat.newChat")}</span>
          </button>
          {(user.isExpert || user.isAdmin) && (
            <button className="search-btn" onClick={() => navigate("/expert")}>
              <IconShield size={16} />
              <span>{t("sidebar.expertQueue")}</span>
              {notif?.queue > 0 ? <span className="nav-badge" aria-label={t("sidebar.newRequests", { count: notif.queue })}>{notif.queue}</span> : notif?.expertOpen ? <kbd>{notif.expertOpen}</kbd> : null}
            </button>
          )}
          <button className="search-btn" onClick={() => openDialog("search")} aria-keyshortcuts="Control+K">
            <IconSearch size={16} />
            <span>{t("sidebar.search")}</span>
            <kbd>{modKey} K</kbd>
          </button>
        </div>
        <nav className="chat-list" aria-label={t("sidebar.history")} ref={listRef}>
          {loading ? (
            <div className="skeleton-list" aria-label={t("common.loading")}>
              {[70, 52, 84, 60, 76, 45].map((w, i) => (
                <div key={i} className="skeleton line" style={{ width: `${w}%`, animationDelay: `${i * 80}ms` }} />
              ))}
            </div>
          ) : pinned.length || groups.length ? (
            <>
              {pinned.length > 0 && (
                <section className="chat-group">
                  <h3 className="group-label">{t("sidebar.pinned")}</h3>
                  {list(pinned)}
                </section>
              )}
              {groups.map((g) => {
                // Older than 30 days: collapsed by default (with a count), unless it holds the open chat.
                const foldable = g.key === "older"
                const shut = foldable && !(openOlder ?? g.items.some((c) => c.id === activeId))
                return (
                  <section key={g.key} className={`chat-group ${foldable ? "is-foldable" : ""}`}>
                    {foldable ? (
                      <h3 className="group-label">
                        <button type="button" className="group-toggle" aria-expanded={!shut} onClick={() => setOpenOlder(shut)}>
                          <IconChevron size={13} className={`chev ${shut ? "" : "up"}`} />
                          <span>{g.label}</span>
                          <span className="group-count">{g.items.length}{paging && !paging.done ? "+" : ""}</span>
                        </button>
                      </h3>
                    ) : (
                      <h3 className="group-label">{g.label}</h3>
                    )}
                    {!shut && list(g.items)}
                  </section>
                )
              })}
              {paging && !paging.done && (
                <div className="list-more">
                  {paging.error && <span className="list-more-err">{t("common.loadFailed")}</span>}
                  <button type="button" className="show-more" onClick={paging.loadMore} disabled={paging.loading} aria-busy={paging.loading || undefined}>
                    {paging.loading ? <Spinner size={12} /> : null}
                    <span>{paging.error ? t("common.retry") : t("sidebar.showMore")}</span>
                  </button>
                </div>
              )}
            </>
          ) : (
            <p className="chat-empty">{t("sidebar.empty")}</p>
          )}
        </nav>
        <UserMenu user={user} onLogout={onLogout} />
      </aside>
    </>
  )
}

import "../app-styles.js"
import { useCallback, useEffect, useState } from "react"
import { api } from "../api.js"
import { modKey, navigate, useTitle } from "../lib.js"
import { useT } from "../i18n.jsx"
import { useApp } from "../settings.jsx"
import ChatView from "../components/ChatView.jsx"
import Sidebar from "../components/Sidebar.jsx"
import SettingsDialog from "../components/Settings.jsx"
import { AboutDialog, SearchDialog, ShareDialog, ShortcutsDialog, useGlobalShortcuts } from "../components/Dialogs.jsx"
import { useToast } from "../components/ui.jsx"
import { ConnectionBanner } from "./StatePages.jsx"
import { IconMenu, IconNew, IconShare } from "../components/Icons.jsx"
import LabView from "../components/LabView.jsx"

export default function ChatApp({ user, chatId, lab, onLogout }) {
  const toast = useToast()
  const t = useT()
  const { dialog, openDialog, closeDialog } = useApp()
  const [chats, setChats] = useState(null)
  const [sidebar, setSidebar] = useState(false)
  const [shareChat, setShareChat] = useState(null)
  const [stream, setStream] = useState("up")
  const [notif, setNotif] = useState(null)
  useGlobalShortcuts()

  // Paged chat list: first 15 (+ all pinned, not counted), 15 more per "Xem thêm" click (cursor).
  const [next, setNext] = useState(null)
  const [pageState, setPageState] = useState({ loading: false, error: false })
  const [extraActive, setExtraActive] = useState(null)
  const refresh = useCallback(() => {
    api.chats().then(
      (r) => {
        setChats([...(r.pinned || []), ...r.chats])
        setNext(r.next)
        setPageState({ loading: false, error: false })
      },
      (e) => {
        setChats((c) => c || [])
        toast.error(e.message)
      },
    )
  }, [toast])
  const loadMore = useCallback(() => {
    if (!next || pageState.loading) return
    setPageState({ loading: true, error: false })
    api.chats(next).then(
      (r) => {
        setChats((xs) => {
          const have = new Set((xs || []).map((x) => x.id))
          return [...(xs || []), ...r.chats.filter((c) => !have.has(c.id))]
        })
        setNext(r.next)
        setPageState({ loading: false, error: false })
      },
      () => setPageState({ loading: false, error: true }),
    )
  }, [next, pageState.loading])
  useEffect(refresh, [refresh])
  // Back to the first page after a search pick.
  useEffect(() => {
    window.addEventListener("chats:reset", refresh)
    return () => window.removeEventListener("chats:reset", refresh)
  }, [refresh])
  // Expert replies for the owner, new requests for experts.
  useEffect(() => {
    let prev = null
    const poll = () =>
      api.notifications().then(
        (n) => {
          if (prev && n.replies > prev.replies) {
            toast.info(t("expert.toastReplied"))
            refresh()
          }
          if (prev && n.queue > prev.queue) toast.info(t("expert.toastNewRequest"))
          prev = n
          setNotif(n)
        },
        () => {},
      )
    poll()
    const timer = setInterval(poll, 20000)
    return () => clearInterval(timer)
  }, [refresh]) // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape" && !document.querySelector(".dialog")) setSidebar(false)
    }
    window.addEventListener("keydown", onKey)
    return () => window.removeEventListener("keydown", onKey)
  }, [])

  const active = chats?.find((c) => c.id === chatId) || (extraActive?.id === chatId ? extraActive : null)
  useTitle(active ? t("app.chatTitle", { title: active.title }) : t("app.title"))
  // A chat id that is not in the (loaded) list: deleted, or someone else's.
  useEffect(() => {
    if (chats && chatId && !chats.some((c) => c.id === chatId)) {
      // Not on the loaded pages (older chat) – fetch just its metadata, or leave if it is gone.
      api.chat(chatId).then(
        (r) => setExtraActive(r.chat),
        (e) => e.status === 404 && navigate("/", { replace: true }),
      )
    }
  }, [chats, chatId])

  const onNew = () => {
    setSidebar(false)
    navigate("/")
  }
  const onSelect = (c) => {
    setSidebar(false)
    navigate(`/c/${c.id}`)
  }
  const patchLocal = (id, patch) => setChats((xs) => xs?.map((x) => (x.id === id ? { ...x, ...patch } : x)))
  const onRename = async (c, title) => {
    patchLocal(c.id, { title })
    try {
      await api.updateChat(c.id, { title })
    } catch (e) {
      toast.error(e.message)
      refresh()
    }
  }
  const onPin = async (c, pinned) => {
    patchLocal(c.id, { pinned, pinnedAt: pinned ? Date.now() : null })
    try {
      const r = await api.updateChat(c.id, { pinned })
      patchLocal(c.id, r.chat)
      toast.success(pinned ? t("sidebar.toastPinned") : t("sidebar.toastUnpinned"))
    } catch (e) {
      toast.error(e.message)
      refresh()
    }
  }
  const onDelete = async (c) => {
    setChats((xs) => xs.filter((x) => x.id !== c.id))
    if (c.id === chatId) navigate("/", { replace: true })
    try {
      await api.deleteChat(c.id)
      toast.success(t("sidebar.toastDeleted"))
    } catch (e) {
      toast.error(e.message)
      refresh()
    }
  }
  // New chat: show it at once, then reload the first page (the list starts over from the top).
  const onChatCreated = (chat) => {
    setChats((xs) => [chat, ...(xs || []).filter((x) => x.id !== chat.id)])
    refresh()
  }
  const onActivity = (id) =>
    setChats((xs) => {
      if (!xs) return xs
      const c = xs.find((x) => x.id === id)
      return c ? [{ ...c, updatedAt: Date.now() }, ...xs.filter((x) => x.id !== id)] : xs
    })
  const onTitle = (chat) => chat && patchLocal(chat.id, { title: chat.title, pinned: chat.pinned, pinnedAt: chat.pinnedAt })

  const settingsTab = dialog?.startsWith("settings:") ? dialog.slice(9) : null
  return (
    <div className="shell">
      <ConnectionBanner stream={stream} signedIn />
      <Sidebar
        open={sidebar}
        onClose={() => setSidebar(false)}
        chats={chats}
        loading={chats === null}
        activeId={chatId}
        onNew={onNew}
        onSelect={onSelect}
        onRename={onRename}
        onDelete={onDelete}
        onPin={onPin}
        onShare={setShareChat}
        notif={notif}
        paging={{ done: !next, loading: pageState.loading, error: pageState.error, loadMore }}
        user={user}
        onLogout={onLogout}
      />
      <main className="main">
        <header className="topbar">
          <button className="icon-btn menu-btn" onClick={() => setSidebar(true)} aria-label={t("sidebar.open")} aria-expanded={sidebar}>
            <IconMenu />
          </button>
          <div className="topbar-title" title={active?.title} data-source={active?.title ? "user" : undefined}>
            {lab ? t("lab.title") : active?.title || t("chat.newChat")}
          </div>
          <span className="model-chip" title={t("chat.modelTip")}>
            {t("chat.modelBadge")}
          </span>
          {active && (
            <button className="btn ghost sm share-btn" onClick={() => setShareChat(active)} title={t("share.buttonTip")}>
              <IconShare size={15} />
              <span>{t("common.share")}</span>
            </button>
          )}
          <button className="icon-btn new-btn" onClick={onNew} aria-label={t("chat.newChat")} title={t("chat.newChatTip", { mod: modKey })}>
            <IconNew />
          </button>
        </header>
        {lab ? <LabView id={lab.id} /> : <ChatView chatId={chatId} onChatCreated={onChatCreated} onActivity={onActivity} onTitle={onTitle} onStream={setStream} />}
      </main>
      <SearchDialog open={dialog === "search"} onClose={closeDialog} chats={chats} />
      <ShortcutsDialog open={dialog === "shortcuts"} onClose={closeDialog} />
      <AboutDialog open={dialog === "about"} onClose={closeDialog} />
      <SettingsDialog tab={settingsTab} onTab={(t) => openDialog(`settings:${t}`)} onClose={closeDialog} onLoggedOut={onLogout} onChatsChanged={refresh} />
      <ShareDialog chat={shareChat} onClose={() => setShareChat(null)} />
    </div>
  )
}

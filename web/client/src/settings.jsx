// Per-user preferences (stored server-side) + small cross-app UI state (settings / shortcuts / search dialogs).
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react"
import { api } from "./api.js"
import { getLocale, setLocale, takeExplicitLocale } from "./i18n.jsx"

export const DEFAULT_SETTINGS = { fontSize: "md", showReasoning: false, enterToSend: true, showFollowups: true, adminReasoning: true, autoRepair: false }
const Ctx = createContext(null)
export const useApp = () => useContext(Ctx)

export function AppProvider({ user, setUser, meta, reloadMeta, children }) {
  const [settings, setSettings] = useState(() => ({ ...DEFAULT_SETTINGS, ...(user?.settings || {}) }))
  const [dialog, setDialog] = useState(null) // "settings:<tab>" | "shortcuts" | "search" | null
  useEffect(() => {
    setSettings({ ...DEFAULT_SETTINGS, ...(user?.settings || {}) })
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const root = document.documentElement
    root.dataset.fontSize = settings.fontSize
    return () => delete root.dataset.fontSize
  }, [settings.fontSize])
  // UI language: the account's saved locale wins, unless the user picked one on the sign-in page
  // just before signing in; an account without a saved locale adopts the current one.
  useEffect(() => {
    if (!user?.id) return
    const explicit = takeExplicitLocale()
    if (explicit) {
      setLocale(explicit)
      if (user.locale !== explicit) api.saveLocale(explicit).catch(() => {})
    } else if (user.locale) setLocale(user.locale)
    else api.saveLocale(getLocale()).catch(() => {})
  }, [user?.id]) // eslint-disable-line react-hooks/exhaustive-deps
  const changeLocale = useCallback(
    async (l) => {
      setLocale(l)
      if (!user?.id) return
      try {
        await api.saveLocale(l)
        setUser?.((u) => (u ? { ...u, locale: l } : u))
      } catch {}
    },
    [user?.id, setUser],
  )
  const updateSettings = useCallback(async (patch) => {
    setSettings((s) => ({ ...s, ...patch }))
    try {
      const r = await api.saveSettings(patch)
      setSettings(r.settings)
    } catch {}
  }, [])
  // "Tự tra lại khi độ tin cậy thấp": offered only while the admin allows repairs (meta.autoRepair); the server
  // enforces both switches. set() returns false (and reloads meta) when the server refused.
  const setAutoRepair = useCallback(
    async (v) => {
      const prev = settings.autoRepair
      setSettings((s) => ({ ...s, autoRepair: v }))
      try {
        const r = await api.setAutoRepair(v)
        setSettings(r.settings)
        return true
      } catch (e) {
        setSettings((s) => ({ ...s, autoRepair: prev }))
        if (e.status === 403) reloadMeta?.()
        throw e
      }
    },
    [settings.autoRepair, reloadMeta],
  )
  const autoRepair = useMemo(() => {
    const allowed = meta?.autoRepair === true
    return { allowed, enabled: allowed && settings.autoRepair === true, set: setAutoRepair }
  }, [meta?.autoRepair, settings.autoRepair, setAutoRepair])
  const value = useMemo(
    () => ({ user, setUser, meta, reloadMeta, settings, updateSettings, changeLocale, autoRepair, dialog, openDialog: setDialog, closeDialog: () => setDialog(null) }),
    [user, setUser, meta, reloadMeta, settings, updateSettings, changeLocale, autoRepair, dialog],
  )
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>
}

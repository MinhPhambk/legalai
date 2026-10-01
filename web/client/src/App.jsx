import { Suspense, lazy, useEffect, useRef, useState } from "react"
import { api } from "./api.js"
import { navigate, sitePage, useRoute } from "./route.js"
import { AppProvider } from "./settings.jsx"
import { ErrorBoundary, Splash } from "./pages/StatePages.jsx"
import SitePages from "./site/SitePages.jsx"

// The app screens load on demand so the public (prerendered) pages stay light.
const AuthPage = lazy(() => import("./pages/Auth.jsx"))
const ChatApp = lazy(() => import("./pages/ChatApp.jsx"))
const SharePage = lazy(() => import("./pages/SharePage.jsx"))
const AdminPage = lazy(() => import("./pages/AdminPage.jsx"))
const ExpertPage = lazy(() => import("./pages/ExpertPage.jsx"))
const AdminChatViewer = lazy(() => import("./pages/AdminChats.jsx"))
const NotFound = lazy(() => import("./pages/NotFoundPage.jsx"))
const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches
import { useToast } from "./components/ui.jsx"
import { useT } from "./i18n.jsx"

/** Cross-fades between top-level views (auth ↔ app ↔ admin). */
function PageTransition({ viewKey, children }) {
  const [shown, setShown] = useState({ key: viewKey, node: children })
  const [phase, setPhase] = useState("in")
  const first = useRef(true)
  useEffect(() => {
    if (first.current) {
      first.current = false
      return
    }
    if (viewKey === shown.key) return
    setPhase("out")
    const t = setTimeout(
      () => {
        setShown({ key: viewKey, node: null })
        setPhase("in")
      },
      reducedMotion() ? 0 : 170,
    )
    return () => clearTimeout(t)
  }, [viewKey]) // eslint-disable-line react-hooks/exhaustive-deps
  const node = viewKey === shown.key ? children : shown.node
  return (
    <div key={shown.key} className={`page page-${phase}`}>
      {node}
    </div>
  )
}

const ROUTES = {
  auth: /^\/(login|register)$/,
  chat: /^\/(c\/([A-Za-z0-9_-]+))?$/,
  share: /^\/s\/([A-Za-z0-9_-]+)$/,
  admin: /^\/admin(?:\/(users|chats|access-log|experts|models|library|settings))?$/,
  adminChat: /^\/admin\/chats\/([A-Za-z0-9_-]+)$/,
  expert: /^\/expert$/,
}

export default function App({ initialUser, ssr = false }) {
  const path = useRoute()
  const toast = useToast()
  const t = useT() // the whole tree re-renders when the language changes
  const [user, setUser] = useState(initialUser)
  const [meta, setMeta] = useState({ allowRegistration: false }) // sign-up links only once the server says it is open
  const [resetKey, setResetKey] = useState(0)

  const loadMeta = () => api.meta().then(setMeta, () => {})
  useEffect(() => {
    api.me().then(
      (r) => setUser(r.user),
      () => setUser(null),
    )
    loadMeta()
    const expired = () => {
      setUser((u) => {
        if (u) toast.error(t("auth.sessionExpired"))
        return null
      })
    }
    window.addEventListener("auth:expired", expired)
    // admin switches that change what users see (e.g. "Cho phép tự tra lại…") reach open tabs on focus
    window.addEventListener("focus", loadMeta)
    return () => {
      window.removeEventListener("auth:expired", expired)
      window.removeEventListener("focus", loadMeta)
    }
  }, []) // eslint-disable-line react-hooks/exhaustive-deps

  const site = sitePage(path)
  // The landing is for signed-out visitors; signed-in users go straight to the app ("/" = new chat).
  // A prerendered landing shows at once; otherwise wait for the session check (no flash of the landing for signed-in users).
  const showSite = !!site && (site.page !== "landing" || user === null || (user === undefined && ssr))
  const isAuthPath = ROUTES.auth.test(path)
  const isShare = ROUTES.share.test(path)
  const isKnown = isAuthPath || isShare || ROUTES.chat.test(path) || ROUTES.admin.test(path) || ROUTES.adminChat.test(path) || ROUTES.expert.test(path)
  useEffect(() => {
    if (user && site?.page === "landing" && path !== "/") return navigate("/", { replace: true })
    if (user === undefined || isShare || !isKnown || showSite) return
    if (!user && !isAuthPath) navigate("/login", { replace: true })
    else if (user && isAuthPath) navigate("/", { replace: true })
    else if (user && ROUTES.admin.test(path) && !user.isAdmin) navigate("/", { replace: true })
    else if (user && ROUTES.expert.test(path) && !(user.isExpert || user.isAdmin)) navigate("/", { replace: true })
  }, [user, path, isAuthPath, isShare, isKnown, showSite, site?.page, meta.allowRegistration])

  // Public site pages render immediately (they are prerendered and hydrated; the session check runs in the background).
  if (showSite) return <SitePages page={site.page} locale={site.locale} signedIn={!!user} allowRegistration={meta.allowRegistration} />
  if (user === undefined) return <Splash />

  const onAuthed = (u) => {
    // Load the full profile (display name, settings).
    api.me().then((r) => setUser(r.user || u), () => setUser(u))
    loadMeta()
    navigate("/", { replace: true })
  }
  const onLogout = async () => {
    try {
      await api.logout()
    } catch {}
    setUser(null)
    navigate("/login", { replace: true })
  }

  let key, view
  if (isShare) {
    key = "share"
    view = <SharePage token={path.match(ROUTES.share)[1]} signedIn={!!user} />
  } else if (!isKnown) {
    key = "404"
    view = <NotFound />
  } else if (!user) {
    key = "auth" // login ↔ register animate inside the auth layout
    view = <AuthPage mode={path === "/register" ? "register" : "login"} allowRegistration={meta.allowRegistration} onAuthed={onAuthed} />
  } else if (ROUTES.expert.test(path)) {
    key = "expert"
    view = user.isExpert || user.isAdmin ? <ExpertPage me={user} /> : <Splash />
  } else if (ROUTES.adminChat.test(path)) {
    key = "admin-chat"
    view = user.isAdmin ? <AdminChatViewer chatId={path.match(ROUTES.adminChat)[1]} /> : <NotFound />
  } else if (ROUTES.admin.test(path)) {
    key = "admin"
    view = user.isAdmin ? <AdminPage me={user} section={path.match(ROUTES.admin)[1] || "overview"} /> : <Splash />
  } else {
    key = "app"
    const m = path.match(ROUTES.chat)
    view = <ChatApp user={user} chatId={m?.[2] || null} onLogout={onLogout} />
  }
  return (
    <AppProvider user={user} setUser={setUser} meta={meta} reloadMeta={loadMeta}>
      <ErrorBoundary key={resetKey} onReset={() => setResetKey((k) => k + 1)}>
        <Suspense fallback={<Splash />}>
          <PageTransition viewKey={key}>{view}</PageTransition>
        </Suspense>
      </ErrorBoundary>
    </AppProvider>
  )
}

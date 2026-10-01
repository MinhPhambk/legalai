// Admin → Hệ thống: server-enforced grounding switches (server/grounding.mjs).
import { useEffect, useState } from "react"
import { api } from "../api.js"
import { useT } from "../i18n.jsx"
import { useApp } from "../settings.jsx"
import { Switch, useToast } from "./ui.jsx"

export default function AdminGrounding() {
  const t = useT()
  const toast = useToast()
  const [s, setS] = useState(null)
  const { reloadMeta } = useApp() || {}
  // autoRepairLowConfidence = "Cho phép tự tra lại khi độ tin cậy thấp" (opt-in, default off)
  const norm = (r) => ({ serverGrounding: r.serverGrounding !== false, autoRepairLowConfidence: r.autoRepairLowConfidence === true })
  useEffect(() => {
    api.admin.settings().then(
      (r) => setS(norm(r)),
      () => {},
    )
  }, [])
  const save = async (key, v) => {
    const prev = s
    setS({ ...s, [key]: v })
    try {
      const r = await api.admin.saveSettings({ [key]: v })
      setS(norm(r))
      reloadMeta?.()
      toast.success(t("admin.grounding.saved"))
    } catch (e) {
      setS(prev)
      toast.error(e.message)
    }
  }
  return (
    <>
      <Switch
        id="adm-server-grounding"
        label={t("admin.grounding.server")}
        description={t("admin.grounding.serverDesc")}
        checked={!!s?.serverGrounding}
        disabled={!s}
        onChange={(v) => save("serverGrounding", v)}
      />
      <Switch
        id="adm-auto-repair"
        label={t("admin.grounding.repair")}
        description={t("admin.grounding.repairDesc")}
        checked={!!s?.autoRepairLowConfidence}
        disabled={!s}
        onChange={(v) => save("autoRepairLowConfidence", v)}
      />
    </>
  )
}

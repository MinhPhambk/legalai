// LegalAI square mark (see scripts/brand-build.mjs): the official TECHLAB logo centred on a tile of its own red.
// `tile` is kept for API compatibility (the logo always comes with its red tile).
export function LogoMark({ size = 28, className = "", title }) {
  return (
    <img
      className={`logo-svg ${className}`}
      src="/brand/legalai-mark-color.svg"
      width={size}
      height={size}
      alt={title || ""}
      aria-hidden={title ? undefined : "true"}
      draggable="false"
    />
  )
}

/** TECHLAB logo (official raster, /brand/techlab-logo.png) + "LegalAI" wordmark (live text in Be Vietnam Pro Bold). */
export function Lockup({ size = 28, className = "" }) {
  return (
    <span className={`lockup ${className}`} style={{ "--lockup": `${size}px` }}>
      <img className="lockup-techlab" src="/brand/techlab-logo.png" alt="FTU Tech Lab" height={size} width={Math.round((size * 377) / 152)} />
      <span className="lockup-word">LegalAI</span>
    </span>
  )
}

/** The official TECHLAB logo on its own (in-app brand slots: sidebar, auth, empty state, splash). */
export function TechlabLogo({ height = 28, className = "" }) {
  return <img className={`techlab-logo ${className}`} src="/brand/techlab-logo.png" alt="FTU Tech Lab" height={height} width={Math.round((height * 377) / 152)} draggable="false" />
}

// LegalAI logo mark (see scripts/brand-build.mjs – same geometry): a balance whose fulcrum is a spark.
// `tile` = the rounded brand-red square; without it, only the glyph in currentColor (for icon slots).
export function LogoMark({ size = 28, tile = true, className = "", title }) {
  const a11y = title ? { role: "img", "aria-label": title } : { "aria-hidden": "true", focusable: "false" }
  return (
    <svg className={`logo-svg ${className}`} width={size} height={size} viewBox="0 0 32 32" {...a11y}>
      {title ? <title>{title}</title> : null}
      {tile ? <rect width="32" height="32" rx="8" fill="var(--brand, #C20B11)" /> : null}
      <path d="M6.5 12.5h19M16 12.5V25M11 25h10" fill="none" stroke={tile ? "#fff" : "currentColor"} strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M4.8 16.5h8.4a4.2 4.2 0 0 1-8.4 0ZM18.8 16.5h8.4a4.2 4.2 0 0 1-8.4 0ZM16 3.8Q16.9 7.6 20.6 8.4 16.9 9.2 16 13 15.1 9.2 11.4 8.4 15.1 7.6 16 3.8Z"
        fill={tile ? "#fff" : "currentColor"}
      />
    </svg>
  )
}

/** Mark + "LegalAI" wordmark (live text in Be Vietnam Pro Bold). */
export function Lockup({ size = 28, className = "" }) {
  return (
    <span className={`lockup ${className}`} style={{ "--lockup": `${size}px` }}>
      <LogoMark size={size} />
      <span className="lockup-word">LegalAI</span>
    </span>
  )
}

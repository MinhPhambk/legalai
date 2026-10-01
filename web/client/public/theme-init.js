// Applies the saved theme and UI language before first paint (external file so the CSP can forbid inline scripts;
// the prerendered site pages inline it, allowed by its hash).
;(function () {
  var d = document.documentElement
  d.className += " js" // scroll-reveal styles apply only when scripts run
  try {
    var t = localStorage.getItem("nd45-theme")
    if (t === "light" || t === "dark") d.setAttribute("data-theme", t)
  } catch (e) {}
  // Public site pages (prerendered, <html data-site>) take their language from the URL and load the app
  // bundle only after the page has loaded (the static HTML is complete; the bundle hydrates it).
  if (d.hasAttribute("data-site")) {
    var boot = function () {
      var e = document.getElementById("app-entry")
      if (!e || e.getAttribute("data-done")) return
      e.setAttribute("data-done", "1")
      var s = document.createElement("script")
      s.type = "module"
      s.src = e.getAttribute("data-src")
      document.head.appendChild(s)
    }
    if (document.readyState === "complete") setTimeout(boot, 0)
    else window.addEventListener("load", function () { setTimeout(boot, 0) })
    // A first interaction (tap, key) loads it right away.
    ;["pointerdown", "keydown", "touchstart"].forEach(function (ev) {
      window.addEventListener(ev, boot, { once: true, passive: true })
    })
    return
  }
  try {
    var l = localStorage.getItem("nd45-locale")
    if (l !== "vi" && l !== "en") l = /^vi/i.test(navigator.language || "") ? "vi" : "en"
    d.lang = l
    if (l === "en") document.title = "LegalAI – AI legal assistant"
  } catch (e) {}
})()

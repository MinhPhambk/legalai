// Responsive QA: every screen × viewport, asserting no horizontal overflow, no clipped elements (outside
// intended scroll containers), dialogs/menus fully visible, composer visible. Separate headless Chrome.
// Usage: node scripts/responsive-qa.mjs  (env: QA_USER, QA_PW, QA_ADMIN, QA_ADMIN_PW, QA_LONG, QA_REPORT, QA_DOC, QA_SHARE, QA_SHOTS=1, QA_ONLY=screen1,screen2)
//        QA_DOCV = chat with a document that has ≥ 2 versions (doc-versions / doc-diff screens; skipped when unset)
//        QA_LOCALE = vi (default) | en – UI language for the whole run (English strings are longer)
//        QA_FOLLOW = chat whose last answer has follow-up suggestions (followups screen)
//        QA_STEPS = chat whose answer has a long tool-step list (15+ steps, long args) – steps-long screen
//        (pii-warn screen always runs: the personal-identifier warning no longer depends on the model)
//        QA_OCR_PDF = a scanned PDF (ocr-chip), QA_OCR = chat with an OCR-recognised attachment (ocr-attach), QA_OCR_STEPS = chat
//        whose steps read OCR text (ocr-steps) – OCR harness only (v11)
//        QA_REPAIR=1 (admin allows "tự tra lại": repair-composer), QA_REPAIR_LOW = chat whose last answer is THẤP, not repaired (repair-low)
import path from "node:path"
import fs from "node:fs"
import { createRequire } from "node:module"
import { fileURLToPath } from "node:url"

const web = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..")
const require = createRequire(path.join(web, "..", "package.json"))
const puppeteer = require("puppeteer-core")
const APP = process.env.APP_URL || "http://127.0.0.1:3000"
const E = process.env
const shots = path.join(web, "screenshots")
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const LOCALE = E.QA_LOCALE === "en" ? "en" : "vi"
const TAG = LOCALE === "vi" ? "" : `${LOCALE}-`

const VIEWPORTS = [
  [320, 568], [360, 740], [375, 667], [390, 844], [414, 896], [844, 390], [390, 500],
  [768, 1024], [1024, 768], [820, 1180], [1180, 820], [1280, 720], [1366, 768], [1440, 900], [1920, 1080], [1280, 800, 2],
]

const innerWidthOf = (p) => p.viewport()?.width || 1440
const goto = async (p, url) => {
  await p.goto(APP + url, { waitUntil: "domcontentloaded" })
}
const SITE = (page) => (LOCALE === "en" ? "/en" : "") + (page ? "/" + page : LOCALE === "en" ? "" : "/")
const SCREENS = {
  // Public site (prerendered): landing, its mobile menu, brand guideline, draft legal pages.
  landing: { auth: false, go: (p) => goto(p, SITE("")), wait: ".site .hero .display", after: async (p) => (await p.evaluate(() => document.querySelectorAll(".reveal").forEach((e) => e.classList.add("in"))), sleep(200)) },
  "landing-menu": {
    auth: false,
    viewports: [[320, 568], [360, 740], [375, 667], [390, 844], [414, 896], [844, 390], [390, 500], [768, 1024], [820, 1180]],
    go: (p) => goto(p, SITE("")),
    wait: ".site-menu-btn",
    after: async (p) => (await p.click(".site-menu-btn"), sleep(250)),
    popup: ".site-menu",
  },
  brand: { auth: false, go: (p) => goto(p, SITE("brand")), wait: ".brand-page .logo-grid", after: async (p) => (await p.evaluate(() => document.querySelectorAll(".reveal").forEach((e) => e.classList.add("in"))), sleep(200)) },
  privacy: { auth: false, go: (p) => goto(p, SITE("privacy")), wait: ".legal h1" },
  terms: { auth: false, go: (p) => goto(p, SITE("terms")), wait: ".legal h1" },
  login: { auth: false, go: (p) => goto(p, "/login"), wait: ".auth-card input[type=email]" },
  // Registration may be closed (pilot): then /register shows the "request access" state instead of the form.
  register: { auth: false, go: (p) => goto(p, "/register"), wait: ".auth-card .auth-title" },
  forgot: { auth: false, go: (p) => goto(p, "/login"), wait: ".link-btn.subtle", after: async (p) => (await p.click(".link-btn.subtle"), sleep(400)) },
  "chat-empty": { go: (p) => goto(p, "/"), wait: ".empty", composer: true },
  "chat-report": { go: (p) => goto(p, "/c/" + E.QA_REPORT), wait: ".report-card", composer: true },
  "chat-long-url": { go: (p) => goto(p, "/c/" + E.QA_LONG), wait: ".msg-assistant .md", composer: true, scrollBottom: true },
  "chat-doc-card": { go: (p) => goto(p, "/c/" + E.QA_DOC), wait: ".doc-card", composer: true, scrollTo: ".doc-card" },
  "report-panel": { go: (p) => goto(p, "/c/" + E.QA_REPORT), wait: ".report-card", after: async (p) => (await p.click(".report-card"), p.waitForSelector(".report-panel"), sleep(700)) },
  "doc-panel": { go: (p) => goto(p, "/c/" + E.QA_DOC), wait: ".doc-card .btn.primary", after: async (p) => (await p.click(".doc-card .btn.primary"), p.waitForSelector(".doc-panel"), sleep(900)) },
  // Versioned document: card with the ‹ v1 v2 › switcher, and the diff panel (+ "chỉ hiện chỗ thay đổi").
  "doc-versions": { need: "QA_DOCV", go: (p) => goto(p, "/c/" + E.QA_DOCV), wait: ".doc-card .doc-vnav", composer: true, scrollTo: ".doc-card:has(.doc-diff-btn)" },
  "doc-diff": {
    need: "QA_DOCV",
    go: (p) => goto(p, "/c/" + E.QA_DOCV),
    wait: ".doc-card .doc-diff-btn",
    after: async (p) => {
      const b = (await p.$$(".doc-card .doc-diff-btn")).at(-1)
      await b.evaluate((e) => e.scrollIntoView({ block: "center" }))
      await b.click()
      await p.waitForSelector(".doc-panel .diff-page .diff-text", { timeout: 10000 })
      await sleep(700)
    },
    popup: ".doc-panel",
  },
  "doc-diff-only": {
    need: "QA_DOCV",
    go: (p) => goto(p, "/c/" + E.QA_DOCV),
    wait: ".doc-card .doc-diff-btn",
    after: async (p) => {
      const b = (await p.$$(".doc-card .doc-diff-btn")).at(-1)
      await b.evaluate((e) => e.scrollIntoView({ block: "center" }))
      await b.click()
      await p.waitForSelector(".doc-panel .diff-page .diff-text", { timeout: 10000 })
      await p.click(".doc-only .switch")
      await sleep(600)
    },
    popup: ".doc-panel",
  },
  "cite-hover": {
    go: (p) => goto(p, "/c/" + (E.QA_CITE || E.QA_REPORT)),
    wait: ".msg-assistant",
    after: async (p) => {
      // Long answers render as a report on narrow screens: the chips are then inside the panel.
      if (!(await p.$(".msg-assistant .md a.cite")) && (await p.$(".report-card"))) {
        await p.click(".report-card")
        await p.waitForSelector(".report-panel .md a.cite", { timeout: 8000 })
        await sleep(500)
      }
      const c = (await p.$(".report-panel .md a.cite")) || (await p.$(".md a.cite"))
      await c.evaluate((e) => e.scrollIntoView({ block: "center" }))
      if (innerWidthOf(p) < 800) await c.tap()
      else await c.hover()
      await sleep(400)
    },
    popup: ".cite-card",
  },
  search: { go: (p) => goto(p, "/"), wait: ".empty", after: async (p) => (await p.keyboard.down("Control"), await p.keyboard.press("KeyK"), await p.keyboard.up("Control"), p.waitForSelector(".search-dialog"), await p.type(".search-dialog input", "phat"), sleep(700)), popup: ".search-dialog" },
  settings: { go: (p) => goto(p, "/"), wait: ".empty", after: async (p) => (await p.keyboard.down("Control"), await p.keyboard.press("Comma"), await p.keyboard.up("Control"), p.waitForSelector(".settings-dialog"), sleep(500)), popup: ".settings-dialog" },
  "settings-account": {
    go: (p) => goto(p, "/"),
    wait: ".empty",
    after: async (p) => (await p.keyboard.down("Control"), await p.keyboard.press("Comma"), await p.keyboard.up("Control"), await p.waitForSelector(".settings-tab"), await (await p.$$(".settings-tab"))[1].click(), sleep(800)),
    popup: ".settings-dialog",
  },
  "user-menu": {
    go: (p) => goto(p, "/"),
    wait: ".empty",
    after: async (p) => {
      if (await p.$eval(".menu-btn", (b) => getComputedStyle(b).display !== "none")) {
        await p.click(".menu-btn")
        await sleep(450)
      }
      await p.click(".user-btn")
      await sleep(300)
    },
    popup: ".user-pop",
  },
  // Sidebar history: first 15 chats + "Xem thêm" at the end (clicked once), "Cũ hơn" group collapsed with a count.
  // Result cards in the step list (QA_CARDS = chat whose answer used calc_* / fx_* / web_read / company_*), steps expanded.
  "step-cards": {
    need: "QA_CARDS",
    go: (p) => goto(p, "/c/" + E.QA_CARDS),
    wait: ".steps-head",
    composer: true,
    after: async (p) => {
      if (!(await p.$(".steps .collapse.open"))) await p.click(".steps-head")
      await p.waitForSelector(".rcard")
      await p.evaluate(() => document.querySelector(".rc-calc .rc-more")?.setAttribute("open", ""))
      await p.evaluate(() => (document.querySelector(".rc-company") || document.querySelector(".rc-fx"))?.scrollIntoView({ block: "center" }))
      await sleep(300)
    },
  },
  // Long-document drafting progress card (QA_DRAFT = chat whose answer drafted a document with draft_* tools), sections expanded.
  "draft-card": {
    need: "QA_DRAFT",
    go: (p) => goto(p, "/c/" + E.QA_DRAFT),
    wait: ".draft-card.done",
    composer: true,
    after: async (p) => (await p.click(".draft-card .draft-toggle"), await p.evaluate(() => document.querySelector(".draft-card").scrollIntoView({ block: "center" })), sleep(300)),
  },
  "sidebar-more": {
    go: (p) => goto(p, "/"),
    wait: ".empty",
    after: async (p) => {
      if (await p.$eval(".menu-btn", (b) => getComputedStyle(b).display !== "none")) {
        await p.click(".menu-btn")
        await sleep(450)
      }
      await p.waitForSelector(".chat-list .chat-group", { timeout: 10000 })
      if (await p.$(".show-more")) {
        await p.click(".show-more")
        await p.waitForFunction(() => !document.querySelector(".show-more[aria-busy]"), { timeout: 10000 })
      }
      await p.evaluate(() => {
        const l = document.querySelector(".chat-list")
        l.scrollTop = l.scrollHeight
      })
      await sleep(250)
    },
  },
  "chat-menu": {
    go: (p) => goto(p, "/"),
    wait: ".chat-link",
    after: async (p) => {
      if (await p.$eval(".menu-btn", (b) => getComputedStyle(b).display !== "none")) {
        await p.click(".menu-btn")
        await sleep(450)
      }
      await p.click(".chat-more")
      await sleep(300)
    },
    popup: ".chat-menu",
  },
  "delete-confirm": {
    go: (p) => goto(p, "/"),
    wait: ".chat-link",
    after: async (p) => {
      if (await p.$eval(".menu-btn", (b) => getComputedStyle(b).display !== "none")) {
        await p.click(".menu-btn")
        await sleep(450)
      }
      await p.click(".chat-more")
      await sleep(250)
      await (await p.$$(".chat-menu .menu-item")).at(-1).click()
      await sleep(400)
    },
    popup: ".dialog",
    cleanup: async (p) => p.keyboard.press("Escape"),
  },
  "share-dialog": { go: (p) => goto(p, "/c/" + E.QA_REPORT), wait: ".share-btn", after: async (p) => (await p.click(".share-btn"), p.waitForSelector(".share-dialog"), sleep(700)), popup: ".share-dialog" },
  "escalate-dialog": {
    go: (p) => goto(p, "/c/" + E.QA_REPORT),
    wait: '.msg-actions button[data-act="escalate"]',
    after: async (p) => (await p.click('.msg-actions button[data-act="escalate"]'), p.waitForSelector(".esc-dialog"), sleep(400)),
    popup: ".esc-dialog",
  },
  about: {
    go: (p) => goto(p, "/"),
    wait: ".composer-about",
    // The composer note (with the link) is hidden on very short screens; the dialog must still fit.
    after: async (p) => (await p.$eval(".composer-about", (b) => b.click()), await p.waitForSelector(".about-dialog"), sleep(500)),
    popup: ".about-dialog",
    cleanup: async (p) => p.keyboard.press("Escape"),
  },
  followups: {
    need: "QA_FOLLOW",
    go: (p) => goto(p, "/c/" + E.QA_FOLLOW),
    wait: ".followups .followup",
    composer: true,
    scrollBottom: true,
  },
  // Clarifying questions: QA_QUESTION = chat with an answered question card (compact summary);
  // QA_QPENDING = chat whose run is waiting on a question (interactive card, owner = QA_USER).
  "question-answered": {
    need: "QA_QUESTION",
    go: (p) => goto(p, "/c/" + E.QA_QUESTION),
    wait: ".qcard-done",
    composer: true,
    scrollTo: ".qcard-done",
  },
  "question-pending": {
    need: "QA_QPENDING",
    go: (p) => goto(p, "/c/" + E.QA_QPENDING),
    wait: ".qcard .qopt",
    composer: true,
    scrollTo: ".qcard",
  },
  // Assisted browsing: QA_ASSIST = chat whose run waits for the user on an official page (harness: prompt "ASSIST …",
  // owner = QA_USER, within the request's 5 minutes) – floating live-view window (full-screen sheet on phones),
  // its 100 % zoom, and the one-line chip once the window is closed.
  "assist-window": {
    need: "QA_ASSIST",
    go: (p) => goto(p, "/c/" + E.QA_ASSIST),
    wait: ".assist-pop .assist-canvas",
    after: async (p) => (await p.waitForFunction(() => !document.querySelector(".assist-pop .assist-loading"), { timeout: 15000 }).catch(() => {}), sleep(400)),
    popup: ".assist-pop",
  },
  "assist-zoom": {
    need: "QA_ASSIST",
    shotsAt: [390, 1024, 1366],
    go: (p) => goto(p, "/c/" + E.QA_ASSIST),
    wait: ".assist-pop .assist-canvas",
    after: async (p) => {
      await p.click(".assist-zoom-in") // one step above the starting zoom
      await sleep(500)
    },
    popup: ".assist-pop",
  },
  "assist-chip": {
    need: "QA_ASSIST",
    go: (p) => goto(p, "/c/" + E.QA_ASSIST),
    wait: ".assist-pop .assist-head",
    after: async (p) => (await p.click(".assist-close"), p.waitForSelector(".assist-chip .link-btn"), sleep(300)),
    composer: true,
    scrollTo: ".assist-chip",
  },
  // Expanded long tool-step list: grid rows – results / times right-aligned in one column, short results
  // never truncated, no "Điều Điều", confidence in badge wording; phones: name + time, then arg · result.
  "steps-long": {
    need: "QA_STEPS",
    shotsAt: [320, 390, 768, 1366, 1920],
    go: (p) => goto(p, "/c/" + E.QA_STEPS),
    wait: ".steps-head",
    after: async (p) => {
      await p.evaluate(() => {
        const heads = [...document.querySelectorAll(".steps-head")]
        const count = (h) => Number((h.textContent.match(/(\d+)/g) || ["0"]).at(-1))
        const best = heads.sort((a, b) => count(b) - count(a))[0]
        if (best.getAttribute("aria-expanded") !== "true") best.click()
        best.scrollIntoView({ block: "start" })
      })
      await p.waitForSelector(".step-list .step-line")
      await sleep(700)
      await p.evaluate(() => {
        const extra = (window.__qaExtra = window.__qaExtra || [])
        const list = [...document.querySelectorAll(".step-list")].sort((a, b) => b.children.length - a.children.length)[0]
        const rows = [...list.querySelectorAll(".step-line")]
        if (rows.length < 15) extra.push(`only ${rows.length} steps (need 15+)`)
        const phone = innerWidth <= 600
        const rights = (sel) => rows.map((r) => r.querySelector(sel)).filter(Boolean).map((e) => e.getBoundingClientRect().right)
        const spread = (xs) => (xs.length ? Math.max(...xs) - Math.min(...xs) : 0)
        if (spread(rights(".step-time")) > 1.5) extra.push(`step times not aligned (spread ${spread(rights(".step-time")).toFixed(1)} px)`)
        if (!phone && spread(rights(".step-result")) > 1.5) extra.push(`step results not aligned (spread ${spread(rights(".step-result")).toFixed(1)} px)`)
        for (const e of list.querySelectorAll(".step-result, .step-arg")) {
          const txt = e.textContent.trim()
          if (e.classList.contains("step-result") && txt.length <= 24 && e.scrollWidth > e.clientWidth + 1) extra.push(`short result truncated: "${txt}"`)
          if (/Điều\s+Điều|Article\s+Article|khoản\s+khoản/i.test(txt)) extra.push(`doubled unit: "${txt.slice(0, 40)}"`)
          if (/^(cao|thấp|trung bình|high|low|medium)$/.test(txt)) extra.push(`confidence not in badge wording: "${txt}"`)
        }
        for (const r of rows) {
          const b = r.getBoundingClientRect()
          for (const c of r.children) {
            const x = c.getBoundingClientRect()
            if (x.width && (x.right > b.right + 1 || x.left < b.left - 1)) { extra.push("step cell outside its row"); break }
          }
        }
      })
    },
  },
  // v11 OCR: upload chip of a scanned PDF (QA_OCR_PDF, OCR harness – cached after the first run) with the OCR badge,
  // the sent attachment pill + imported document card (QA_OCR = chat whose first message attached a scan), and
  // tool steps / cards with OCR badges (QA_OCR_STEPS = the "OCRSTEP" chat of the OCR harness).
  "ocr-chip": {
    need: "QA_OCR_PDF",
    go: (p) => goto(p, "/"),
    wait: ".composer textarea",
    after: async (p) => {
      await (await p.$(".composer input[type=file]")).uploadFile(E.QA_OCR_PDF)
      await p.waitForSelector(".chip.done .ocr-badge, .chip.error", { timeout: 120000 })
      await sleep(300)
    },
    composer: true,
  },
  "ocr-attach": { need: "QA_OCR", go: (p) => goto(p, "/c/" + E.QA_OCR), wait: ".msg-user .file-pill .ocr-badge", composer: true, scrollTo: ".msg-user .doc-card" },
  "ocr-steps": {
    need: "QA_OCR_STEPS",
    go: (p) => goto(p, "/c/" + E.QA_OCR_STEPS),
    wait: ".steps-head",
    composer: true,
    after: async (p) => {
      if (!(await p.$(".steps .collapse.open"))) await p.click(".steps-head")
      await p.waitForSelector(".step-ocr")
      await p.evaluate(() => document.querySelector(".step-ocr")?.scrollIntoView({ block: "center" }))
      await sleep(300)
    },
  },
  // Opt-in "look up again" (repair harness, admin switch on): composer switch ("Tự tra lại") next to the clip button,
  // and the "Tra lại ngay" link on a THẤP warning (QA_REPAIR_LOW = chat whose last answer is THẤP and not repaired).
  "repair-composer": { need: "QA_REPAIR", go: (p) => goto(p, "/"), wait: ".composer-toggle", composer: true },
  "repair-low": { need: "QA_REPAIR_LOW", go: (p) => goto(p, "/c/" + E.QA_REPAIR_LOW), wait: ".conf-warn .conf-repair", composer: true, scrollTo: ".answer-foot" },
  "pii-warn": {
    go: (p) => goto(p, "/"),
    wait: ".composer textarea",
    after: async (p) => {
      await p.type(".composer textarea", "CCCD 079203001234 – 0912 345 678")
      await p.keyboard.press("Enter")
      await p.waitForSelector(".pii-warn")
      await sleep(300)
    },
    popup: ".pii-warn",
    composer: true,
  },
  // Mobile address bar showing / hiding changes only the height: the A4 preview must not re-zoom.
  "doc-panel-resize": {
    viewports: [[390, 844], [360, 740]],
    go: (p) => goto(p, "/c/" + E.QA_DOC),
    wait: ".doc-card .btn.primary",
    after: async (p) => {
      await p.click(".doc-card .btn.primary")
      await p.waitForSelector(".doc-panel .doc-page-wrap")
      await sleep(900)
      const vp = p.viewport()
      const read = () => p.evaluate(() => {
        const w = document.querySelector(".doc-page-wrap")
        const f = document.querySelector(".doc-page")
        return { w: w?.getBoundingClientRect().width, ws: w?.style.width, ft: f?.style.transform }
      })
      const base = await read()
      const bad = []
      for (const dh of [-56, 0, 56, -56, 0]) {
        await p.setViewport({ ...vp, height: vp.height + dh })
        await sleep(350)
        const now = await read()
        if (now.w !== base.w || now.ws !== base.ws || now.ft !== base.ft) bad.push(`doc preview re-zoomed on height ${vp.height + dh}: ${JSON.stringify(base)} → ${JSON.stringify(now)}`)
      }
      await p.setViewport(vp)
      await p.evaluate((b) => (window.__qaExtra = b), bad)
    },
    popup: ".doc-panel",
  },
  shortcuts: { go: (p) => goto(p, "/"), wait: ".empty", after: async (p) => (await p.keyboard.down("Control"), await p.keyboard.press("Slash"), await p.keyboard.up("Control"), await p.waitForSelector(".kbd-dialog"), sleep(400)), popup: ".kbd-dialog", cleanup: async (p) => p.keyboard.press("Escape") },
  share: { auth: false, go: (p) => goto(p, "/s/" + E.QA_SHARE), wait: ".share-head" },
  "share-missing": { auth: false, go: (p) => goto(p, "/s/khongtontaikhongtontai00"), wait: ".state-page" },
  "not-found": { go: (p) => goto(p, "/khong-co-trang"), wait: ".state-page" },
  offline: {
    go: (p) => goto(p, "/"),
    wait: ".empty",
    after: async (p) => (await p.setOfflineMode(true), await p.evaluate(() => dispatchEvent(new Event("offline"))), sleep(500)),
    popup: ".conn-banner.show",
    cleanup: async (p) => (await p.setOfflineMode(false), p.evaluate(() => dispatchEvent(new Event("online")))),
  },
  toast: { go: (p) => goto(p, "/"), wait: ".empty", after: async (p) => (await p.evaluate(() => dispatchEvent(new CustomEvent("auth:expired-test"))), sleep(100)), popupOptional: ".toast" },
  // Admin console: one screen per section (/admin/<section>); the sub-navigation is a tab strip ≤ 768 px.
  admin: { admin: true, shotsAt: [320, 390, 768, 1366, 1920], go: (p) => goto(p, "/admin"), wait: ".stats .stat-value" },
  "admin-users": { admin: true, shotsAt: [320, 390, 768, 1366, 1920], go: (p) => goto(p, "/admin/users"), wait: ".admin-table .u-email" },
  "admin-experts": { admin: true, shotsAt: [320, 390, 768, 1366, 1920], go: (p) => goto(p, "/admin/experts"), wait: ".adm-card .adm-card-head" },
  "admin-models": { admin: true, shotsAt: [320, 390, 768, 1366, 1920], go: (p) => goto(p, "/admin/models"), wait: ".adm-model-list .adm-model" },
  "admin-settings": { admin: true, shotsAt: [320, 390, 768, 1366, 1920], go: (p) => goto(p, "/admin/settings"), wait: ".admin-followups .segmented" },
  "admin-nav-end": {
    admin: true,
    viewports: [[320, 568], [360, 740], [390, 844], [768, 1024]],
    go: (p) => goto(p, "/admin/settings"),
    wait: ".adm-nav .adm-nav-item.on",
    after: async (p) => {
      await sleep(300)
      await p.evaluate(() => {
        const on = document.querySelector(".adm-nav .adm-nav-item.on").getBoundingClientRect()
        if (on.right > innerWidth + 1 || on.left < -1) (window.__qaExtra = window.__qaExtra || []).push("active tab not scrolled into view")
      })
    },
  },
  // Admin-only: all users' chat history, the access log and the read-only chat viewer (QA_ADMIN_CHAT = a chat of another user).
  "admin-chats": { admin: true, shotsAt: [320, 390, 768, 1366, 1920], go: (p) => goto(p, "/admin/chats?hsize=20"), wait: "#admin-chats .adm-chat-row" },
  "admin-access-log": { admin: true, shotsAt: [320, 390, 768, 1366, 1920], go: (p) => goto(p, "/admin/access-log"), wait: "#admin-access-log table" },
  // Admin → tools & skills library: tools tab (one parameter list expanded), skills tab, read-only skill viewer.
  "admin-tools": {
    admin: true,
    shotsAt: [320, 390, 768, 1366, 1920],
    go: (p) => goto(p, "/admin/library"),
    wait: ".lib .lib-item",
    after: async (p) => {
      await p.evaluate(() => {
        const d = document.querySelector(".lib .lib-details")
        if (d) d.open = true
        document.querySelector(".lib")?.scrollIntoView({ block: "start" })
      })
      await sleep(300)
    },
  },
  "admin-skills": {
    admin: true,
    shotsAt: [320, 390, 768, 1366, 1920],
    go: (p) => goto(p, "/admin/library"),
    wait: ".lib .lib-item",
    after: async (p) => {
      await p.click("#lib-tab-skills")
      await p.waitForSelector("#lib-pane-skills .lib-item")
      await p.evaluate(() => document.querySelector(".lib")?.scrollIntoView({ block: "start" }))
      await sleep(300)
    },
  },
  "admin-skill-view": {
    admin: true,
    shotsAt: [320, 390, 768, 1366, 1920],
    go: (p) => goto(p, "/admin/library"),
    wait: ".lib .lib-item",
    after: async (p) => {
      await p.click("#lib-tab-skills")
      await p.waitForSelector("#lib-pane-skills .lib-view")
      await p.click("#lib-pane-skills .lib-view")
      await p.waitForSelector(".lib-skill-dialog .lib-skill-md")
      await sleep(400)
    },
    popup: ".lib-skill-dialog",
  },
  "admin-viewer": {
    admin: true,
    need: "QA_ADMIN_CHAT",
    shotsAt: [320, 390, 768, 1366, 1920],
    go: (p) => goto(p, "/admin/chats/" + E.QA_ADMIN_CHAT),
    wait: ".admin-viewer .msg-assistant, .admin-viewer .messages .turn",
    after: async (p) => {
      await sleep(500)
      await p.evaluate(() => {
        const extra = (window.__qaExtra = window.__qaExtra || [])
        if (!document.querySelector(".adm-ro-badge")) extra.push("read-only banner missing")
        if (document.querySelector(".admin-viewer .composer, .admin-viewer .share-btn")) extra.push("composer / share visible in read-only viewer")
      })
    },
  },
  expert: {
    admin: true,
    go: (p) => goto(p, "/expert"),
    wait: ".chip-btn",
    after: async (p) => {
      await (await p.$$(".chip-btn")).at(-1).click()
      await p.waitForSelector(".queue-item", { timeout: 8000 })
      await p.click(".queue-item")
      await p.waitForSelector(".case-head h2", { timeout: 8000 })
      await sleep(400)
    },
  },
}

/** Runs in the page: returns the list of layout problems. */
function audit({ popup, popupOptional, composer }) {
  const W = innerWidth
  const H = innerHeight
  const problems = [...(window.__qaExtra || [])]
  window.__qaExtra = []
  const se = document.scrollingElement
  if (se.scrollWidth > W + 1) problems.push(`page scrollWidth ${se.scrollWidth} > ${W}`)
  const isScrollBox = (el) => {
    const cs = getComputedStyle(el)
    return /(auto|scroll|hidden)/.test(cs.overflowX) && el !== document.body && el !== document.documentElement
  }
  const hiddenByAncestor = (el) => {
    for (let a = el; a && a !== document.body; a = a.parentElement) {
      const cs = getComputedStyle(a)
      if (cs.visibility === "hidden" || cs.display === "none" || Number(cs.opacity) === 0) return true
    }
    return false
  }
  const clippedBy = (el) => {
    for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) if (isScrollBox(a)) return a
    return null
  }
  const describe = (el) => el.tagName.toLowerCase() + (el.id ? "#" + el.id : "") + (el.className && typeof el.className === "string" ? "." + el.className.trim().split(/\s+/).slice(0, 2).join(".") : "")
  let n = 0
  for (const el of document.body.querySelectorAll("*")) {
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) continue
    const partial = (r.left < -1 && r.right > 1) || (r.left < W - 1 && r.right > W + 1)
    if (!partial) continue
    if (hiddenByAncestor(el)) continue
    const box = clippedBy(el)
    if (box) {
      const b = box.getBoundingClientRect()
      if (b.left >= -1 && b.right <= W + 1) continue // inside an on-screen scroll/clip container: intended
    }
    if (getComputedStyle(el).position === "fixed" && (r.right <= 0 || r.left >= W)) continue
    problems.push(`clipped ${describe(el)} [${Math.round(r.left)}..${Math.round(r.right)}] of ${W}`)
    if (++n >= 4) break
  }
  const checkPopup = (sel, optional) => {
    const el = document.querySelector(sel)
    if (!el) return optional ? null : problems.push(`popup ${sel} missing`)
    const r = el.getBoundingClientRect()
    const scrollable = el.scrollHeight > el.clientHeight + 1 || [...el.querySelectorAll("*")].some((c) => /(auto|scroll)/.test(getComputedStyle(c).overflowY) && c.scrollHeight > c.clientHeight)
    if (r.left < -1 || r.right > W + 1) problems.push(`popup ${sel} off-screen horizontally [${Math.round(r.left)}..${Math.round(r.right)}]`)
    if ((r.top < -1 || r.bottom > H + 1) && !scrollable) problems.push(`popup ${sel} off-screen vertically [${Math.round(r.top)}..${Math.round(r.bottom)}] of ${H}`)
    if ((r.top < -1 || r.bottom > H + 1) && scrollable && (r.top < -1 || r.height > H + 2)) problems.push(`popup ${sel} taller than viewport [${Math.round(r.top)}..${Math.round(r.bottom)}]`)
  }
  if (popup) checkPopup(popup)
  if (popupOptional) checkPopup(popupOptional, true)
  if (composer) {
    const c = document.querySelector(".composer")
    if (!c) problems.push("composer missing")
    else {
      const r = c.getBoundingClientRect()
      if (r.bottom > H + 1 || r.top < 0) problems.push(`composer not fully visible [${Math.round(r.top)}..${Math.round(r.bottom)}] of ${H}`)
    }
  }
  return problems
}

async function login(p, email, pw) {
  await p.goto(APP + "/login", { waitUntil: "domcontentloaded" })
  await p.waitForSelector("input[type=email]")
  await p.type("input[type=email]", email)
  await p.type("input[type=password]", pw)
  await p.keyboard.press("Enter")
  await p.waitForSelector(".composer textarea", { timeout: 20000 })
}

const only = (E.QA_ONLY || "").split(",").filter(Boolean)
const results = {} // screen -> vp -> problems
const t0 = Date.now()
const withTimeout = (p, ms, label) => Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`timeout ${ms} ms (${label})`)), ms))])
// A fresh browser per screen (one hung page can never stall the whole matrix).
for (const [name, sc] of Object.entries(SCREENS)) {
  if (only.length && !only.includes(name)) continue
  if (sc.need && !E[sc.need]) {
    console.log(`SKIP ${name} (${sc.need} not set)`)
    continue
  }
  results[name] = {}
  const browser = await puppeteer.launch({
    executablePath: E.CHROME_PATH || "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    headless: true,
    args: ["--no-first-run", `--lang=${LOCALE === "en" ? "en-US" : "vi-VN"}`],
    protocolTimeout: 30000,
  })
  try {
    const ctx = await browser.createBrowserContext()
    // UI language for the run: stored choice + "explicit" marker (it also becomes the account's locale at sign-in).
    const setLocale = (pg) => pg.evaluateOnNewDocument((l) => {
      try {
        localStorage.setItem("nd45-locale", l)
        sessionStorage.setItem("nd45-locale-explicit", l)
      } catch {}
    }, LOCALE)
    let p = await ctx.newPage()
    await setLocale(p)
    p.on("pageerror", (e) => console.log("pageerror:", name, e.message))
    p.setDefaultTimeout(12000)
    if (sc.auth !== false) await withTimeout(login(p, sc.admin ? E.QA_ADMIN : E.QA_USER, sc.admin ? E.QA_ADMIN_PW : E.QA_PW), 30000, "login")
    for (const [w, h, dpr = 1] of sc.viewports || VIEWPORTS) {
      const key = `${w}x${h}${dpr > 1 ? "@2x" : ""}`
      try {
        await withTimeout(
          (async () => {
            await p.setViewport({ width: w, height: h, deviceScaleFactor: dpr, isMobile: w < 800, hasTouch: w < 800 })
            await sc.go(p)
            await p.waitForSelector(sc.wait)
            await sleep(350)
            if (sc.scrollBottom) await p.evaluate(() => document.querySelector(".chat-scroll")?.scrollTo(0, 1e9))
            if (sc.scrollTo) await p.evaluate((s) => document.querySelector(s)?.scrollIntoView({ block: "center" }), sc.scrollTo)
            if (sc.after) await sc.after(p)
            const probs = await p.evaluate(audit, { popup: sc.popup, popupOptional: sc.popupOptional, composer: sc.composer })
            results[name][key] = probs
            if (E.QA_SHOTS && (probs.length || (sc.shotsAt || [320, 390, 768, 1440]).includes(w))) await p.screenshot({ path: path.join(shots, `qa-${TAG}${name}-${key}.png`) })
            if (sc.cleanup) await sc.cleanup(p)
          })(),
          25000,
          key,
        )
      } catch (e) {
        results[name][key] = [`error: ${e.message.split("\n")[0].slice(0, 120)}`]
        // The page may be wedged: continue on a fresh tab.
        await p.close().catch(() => {})
        p = await ctx.newPage()
        await setLocale(p)
        p.setDefaultTimeout(12000)
      }
    }
  } catch (e) {
    results[name].setup = [`error: ${e.message.slice(0, 120)}`]
  } finally {
    await browser.close().catch(() => {})
  }
  const fails = Object.entries(results[name]).filter(([, v]) => v.length)
  console.log(`${fails.length ? "FAIL" : "PASS"} ${name}${fails.length ? " – " + fails.map(([k, v]) => `${k}: ${v[0]}`).slice(0, 3).join(" | ") : ""}`)
}

fs.writeFileSync(E.QA_OUT || path.join(web, "..", ".sandbox", "web", `responsive-qa${TAG ? "-" + LOCALE : ""}.json`), JSON.stringify(results, null, 2))
// Matrix
const vps = VIEWPORTS.map(([w, h, d = 1]) => `${w}x${h}${d > 1 ? "@2x" : ""}`)
const rows = [["screen", ...vps].join(" | ")]
for (const [name, r] of Object.entries(results)) rows.push([name, ...vps.map((v) => (r[v]?.length ? "✗" : "✓"))].join(" | "))
console.log("\n" + rows.join("\n"))
console.log(`\nlocale: ${LOCALE} · ${((Date.now() - t0) / 1000).toFixed(0)} s`)

// Usage: APP_URL=http://127.0.0.1:3000 [CANON_HOST=<SITE_URL host>] node scripts/seo-check.mjs
// SEO smoke checks against a running server (no JS execution): content in HTML, head tags, JSON-LD,
// robots / sitemap and the noindex policy per host.
const BASE = process.env.APP_URL || "http://127.0.0.1:3103"
const get = async (p, host) => {
  const r = await fetch(BASE + p, { headers: host ? { "X-Forwarded-Host": host, "X-Forwarded-Proto": "https" } : {}, redirect: "manual" })
  return { status: r.status, headers: Object.fromEntries(r.headers), text: await r.text() }
}
const ok = (c, m) => console.log(`${c ? "ok  " : "FAIL"} ${m}`)
for (const [label, host] of [["canonical host (SITE_URL)", process.env.CANON_HOST], ["trycloudflare host", "october-employer-net-aged.trycloudflare.com"], ["plain 127.0.0.1", null]]) {
  if (label.startsWith("canonical") && !host) continue
  console.log(`\n== ${label} ${host || ""}`)
  for (const [p, lang, h1] of [["/", "vi", "Trợ lý pháp lý AI"], ["/en", "en", "AI legal assistant"]]) {
    const r = await get(p, host)
    const t = r.text
    const idx = !/noindex/.test(r.headers["x-robots-tag"] || "") && /name="robots" content="index/.test(t)
    ok(r.status === 200, `${p} 200`)
    ok(new RegExp(`<html lang="${lang}"`).test(t), `${p} <html lang="${lang}">`)
    ok((t.match(/<h1[\s>]/g) || []).length === 1 && t.includes(h1), `${p} one <h1> with content "${h1}…" (no JS)`)
    ok(/<title>[^<]{20,}<\/title>/.test(t) && /name="description" content="[^"]{80,}"/.test(t), `${p} title + description`)
    ok(/rel="canonical" href="https?:\/\/[^"]+"/.test(t) && /hreflang="vi"/.test(t) && /hreflang="en"/.test(t) && /hreflang="x-default"/.test(t), `${p} canonical + hreflang vi/en/x-default → ${t.match(/rel="canonical" href="([^"]+)"/)?.[1]}`)
    ok(/property="og:image" content="https?:[^"]+og-image-(vi|en)\.png"/.test(t) && /twitter:card" content="summary_large_image"/.test(t), `${p} Open Graph + Twitter card`)
    const ld = [...t.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)].map((m) => JSON.parse(m[1]))
    const types = ld.flatMap((x) => x["@graph"] || [x]).map((x) => x["@type"])
    ok(["Organization", "WebSite", "SoftwareApplication", "FAQPage", "VideoObject"].every((x) => types.includes(x)), `${p} JSON-LD types: ${types.join(", ")}`)
    const g = ld.flatMap((x) => x["@graph"])
    const org = g.find((x) => x["@type"] === "Organization"), app = g.find((x) => x["@type"] === "SoftwareApplication"), faq = g.find((x) => x["@type"] === "FAQPage"), vid = g.find((x) => x["@type"] === "VideoObject")
    ok(org?.parentOrganization?.["@type"] === "CollegeOrUniversity" && org.parentOrganization.url === "https://ftu.edu.vn", `${p} Organization → parentOrganization CollegeOrUniversity ftu.edu.vn`)
    ok(app?.applicationCategory === "BusinessApplication" && app.operatingSystem === "Web" && !app.aggregateRating && !app.offers, `${p} SoftwareApplication (no ratings / offers)`)
    ok(faq?.mainEntity?.length === 8 && faq.mainEntity.every((q) => t.includes(q.name.replace(/&/g, "&amp;").slice(0, 20))), `${p} FAQPage 8 Q&A, questions visible in HTML`)
    ok(vid && vid.duration && vid.uploadDate && vid.thumbnailUrl?.[0] && vid.contentUrl, `${p} VideoObject ${vid?.duration} ${vid?.uploadDate}`)
    ok(t.includes("FTU Tech Lab") && t.includes("ftu-logo.png"), `${p} FTU endorsement in HTML`)
    console.log(`     indexable: ${idx}  (X-Robots-Tag: ${r.headers["x-robots-tag"] || "–"})`)
  }
  const robots = await get("/robots.txt", host)
  console.log("     robots.txt:", robots.text.trim().split("\n").join(" | "))
  const sm = await get("/sitemap.xml", host)
  const locs = [...sm.text.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
  ok(sm.status === 200 && locs.length === 6 && !locs.some((l) => /brand|login|\/c\/|\/s\//.test(l)), `sitemap.xml: ${locs.join(" ")}`)
  for (const p of ["/brand", "/login", "/register", "/c/abc", "/s/abc", "/admin"]) {
    const r = await get(p, host)
    ok(/noindex/.test(r.headers["x-robots-tag"] || "") || /name="robots" content="noindex/.test(r.text), `${p} noindex (${r.headers["x-robots-tag"]})`)
  }
}
const b = await get("/brand")
ok(/<meta name="robots" content="noindex, follow"/.test(b.text), "/brand meta robots noindex")
const pr = await get("/privacy")
ok(pr.text.includes("Bản nháp") && pr.text.includes("<h1"), "/privacy draft page prerendered")
const r301 = await get("/en/")
ok(r301.status === 301 && r301.headers.location === "/en", "/en/ → 301 /en")

// Public-site configuration. FILL IN before launch (see docs/BRAND.md):
//  - CONTACT_EMAIL: the real contact address for access requests (placeholder – not a real mailbox).
export const CONTACT_EMAIL = "lienhe@example.com" // PLACEHOLDER – replace with the lab's real address
export const CONTACT_IS_PLACEHOLDER = CONTACT_EMAIL.endsWith("@example.com")
export const FTU_URL = "https://ftu.edu.vn"
export const ORG_NAME = "FTU Tech Lab"

/** Official sources the agent looks up live (names only – no third-party logos). */
/** Official sources the agent looks up live (names come from the dictionary: site.sources.<key>; no third-party logos). */
export const SOURCES = ["vbpl", "court", "trav", "fedreg", "eurlex", "eping", "fta"]

/** Demo video (encoded by scripts/demo-video – see README). */
export const VIDEO = {
  mp4: "/media/legalai-demo.mp4",
  webm: "/media/legalai-demo.webm",
  poster: "/media/legalai-demo-poster.webp", // JPG version for the VideoObject thumbnail
  vtt: { vi: "/media/legalai-demo.vi.vtt", en: "/media/legalai-demo.en.vtt" },
  width: 1280,
  height: 720,
}

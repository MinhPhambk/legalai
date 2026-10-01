// LegalAI design tokens – single source for the /brand page and scripts/brand-contrast.mjs.
// The CSS custom properties in site/brand.css mirror these values (keep them in sync; the contrast
// script checks both).
export const RED = {
  50: "#FEF2F2",
  100: "#FDE3E3",
  200: "#FAC7C8",
  300: "#F49A9D",
  400: "#EC6468",
  500: "#DD2F35",
  600: "#C20B11", // FTU red (official logo) – brand
  700: "#9E0A0F", // hover / pressed (the official darker red is #B70A0F)
  800: "#7D0C10",
  900: "#5C0C0F",
}
export const NEUTRAL = {
  0: "#FFFFFF",
  50: "#F8F8F8",
  100: "#F0F0F0",
  200: "#E6E6E6",
  300: "#CFCFCF",
  400: "#A3A3A3",
  500: "#737373",
  600: "#4D4D4D",
  700: "#2E2E2E",
  800: "#1C1C1C",
  900: "#121212",
  950: "#0F0F0F",
}
export const STATUS = {
  light: { success: "#15803D", warning: "#B45309", error: "#B42318", info: "#1D4ED8" },
  dark: { success: "#4ADE80", warning: "#FBBF24", error: "#F97066", info: "#7AA2F7" },
}
/** Semantic roles per theme (what components use). */
export const ROLES = {
  light: { bg: "#FFFFFF", surface: "#FFFFFF", soft: "#F8F8F8", text: "#121212", text2: "#4D4D4D", text3: "#6B6B6B", border: "#E6E6E6", brand: RED[600], brandHover: "#B70A0F", onBrand: "#FFFFFF", link: RED[600], ring: RED[600], brandSoft: RED[50] },
  dark: { bg: "#0F0F0F", surface: "#171717", soft: "#151515", text: "#F2F2F2", text2: "#B5B5B5", text3: "#8F8F8F", border: "#282828", brand: RED[600], brandHover: "#D0141A", onBrand: "#FFFFFF", link: RED[300], ring: RED[400], brandSoft: "#2A1112" },
}
/** Pairs that must meet WCAG AA (text 4.5:1, large text / UI 3:1). */
export const CONTRAST_PAIRS = [
  ["light", "text", "bg", 4.5],
  ["light", "text2", "bg", 4.5],
  ["light", "text3", "bg", 4.5],
  ["light", "text3", "soft", 4.5],
  ["light", "onBrand", "brand", 4.5],
  ["light", "onBrand", "brandHover", 4.5],
  ["light", "link", "bg", 4.5],
  ["light", "link", "brandSoft", 4.5],
  ["light", "ring", "bg", 3],
  ["dark", "text", "bg", 4.5],
  ["dark", "text2", "surface", 4.5],
  ["dark", "text3", "bg", 4.5],
  ["dark", "text3", "surface", 4.5],
  ["dark", "onBrand", "brand", 4.5],
  ["dark", "onBrand", "brandHover", 4.5],
  ["dark", "link", "bg", 4.5],
  ["dark", "link", "surface", 4.5],
  ["dark", "link", "brandSoft", 4.5],
  ["dark", "ring", "bg", 3],
]
export const TYPE_SCALE = [
  { token: "display", size: "clamp(40px, 6.2vw, 76px)", line: 1.03, weight: 700, track: "-0.042em" },
  { token: "h1", size: "clamp(32px, 4.2vw, 52px)", line: 1.1, weight: 700, track: "-0.032em" },
  { token: "h2", size: "clamp(28px, 3.3vw, 42px)", line: 1.12, weight: 700, track: "-0.03em" },
  { token: "h3", size: "20px", line: 1.3, weight: 600, track: "-0.012em" },
  { token: "lead", size: "clamp(17px, 1.55vw, 19px)", line: 1.6, weight: 400, track: "0" },
  { token: "body", size: "15px", line: 1.6, weight: 400, track: "0" },
  { token: "small", size: "13px", line: 1.5, weight: 500, track: "0" },
  { token: "eyebrow", size: "12.5px", line: 1.4, weight: 600, track: "0.09em" },
]

// ---- WCAG 2.x contrast ---------------------------------------------------------------------------------
const lin = (c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
export function luminance(hex) {
  const n = parseInt(hex.slice(1), 16)
  return 0.2126 * lin(((n >> 16) & 255) / 255) + 0.7152 * lin(((n >> 8) & 255) / 255) + 0.0722 * lin((n & 255) / 255)
}
export function contrast(a, b) {
  const [x, y] = [luminance(a), luminance(b)].sort((p, q) => q - p)
  return (x + 0.05) / (y + 0.05)
}

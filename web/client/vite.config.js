import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

export default defineConfig({
  root: import.meta.dirname,
  plugins: [react()],
  cacheDir: "../node_modules/.vite",
  build: {
    outDir: "dist",
    emptyOutDir: true,
    sourcemap: false,
    target: "es2022",
    chunkSizeWarningLimit: 900,
    assetsInlineLimit: 0, // CSP: font-src 'self' (no data: fonts)
  },
  server: {
    host: "127.0.0.1",
    port: 5173,
    strictPort: true,
    proxy: {
      "/api": { target: "http://127.0.0.1:3000", changeOrigin: false },
    },
  },
})

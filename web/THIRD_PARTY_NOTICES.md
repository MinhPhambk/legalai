# Third-party notices – LegalAI web

## Reference projects (studied, not shipped)

The UI was redesigned after studying the layout, interaction and component patterns of these open-source
projects. They were cloned into `web/_refs/` (git-ignored, never built or served):

| Project | License | What was studied |
|---|---|---|
| [vercel/ai-chatbot](https://github.com/vercel/ai-chatbot) | Apache-2.0 | Split-pane artifact panel (width transition, full-screen on mobile), auth page structure, sidebar history grouping, message actions |
| [assistant-ui/assistant-ui](https://github.com/assistant-ui/assistant-ui) | MIT | Branch picker pattern (`‹ n/m ›`) for message versions, action bar / edit composer placement |
| [danny-avila/LibreChat](https://github.com/danny-avila/LibreChat) | MIT | Login / registration flow and validation states |

**No source code, styles, icons, logos or fonts were copied from these projects.** All components, CSS and
icons in `web/client/src` were written for this project. No OpenAI or Anthropic assets are used.

## Bundled / runtime dependencies

| Package | Version | License | Used for |
|---|---|---|---|
| react, react-dom | 19.3 | MIT | UI |
| marked | 18.0 | MIT | Markdown rendering |
| dompurify | 3.4 | MPL-2.0 OR Apache-2.0 (used under Apache-2.0) | HTML sanitising |
| docx | 9.7 | MIT | .docx export of reports (loaded on demand) |
| express | 5.2 | MIT | HTTP server |
| busboy | 1.6 | MIT | Multipart uploads |
| mammoth | 1.12 | BSD-2-Clause | .docx text extraction |
| pdfjs-dist | 6.3 | Apache-2.0 | .pdf text extraction |
| jszip | 3.10 | MIT OR GPL-3.0-or-later (used under MIT) | Data export (.zip) |
| mermaid | 12.0.0 (exact) | MIT | ```mermaid blocks in answers, rendered in the browser (lazy chunk, `securityLevel: "strict"`, no HTML labels). Its bundled dependencies are MIT / ISC / Apache-2.0 / BSD (d3, dagre-d3-es, cytoscape, katex, dompurify, khroma, marked…), `robust-predicates` (Unlicense) and **`elkjs` (EPL-2.0**, unmodified, only in the lazily loaded ELK-layout chunk – used only by diagrams that ask for `layout: elk`). Installed with `npm install --ignore-scripts`; none of the 114 added packages declares an install script |

## Vendored agent component (not an npm dependency)

| Component | Version | License | Where / what |
|---|---|---|---|
| [Archify](https://github.com/tt-a1i/archify) (tt-a1i; based on Cocoon-AI/architecture-diagram-generator) | 2.16.0 – tag `v2.16.0`, commit `c826e6c3a7abad19c0f3cd1ca57207d54b1ad8de` | MIT (© 2026 tt-a1i, © 2025 Cocoon AI) – `../.opencode/vendor/archify/LICENSE` | `../.opencode/vendor/archify/`: the JSON-IR → SVG diagram compiler behind the agent tool `diagram_create`. Only the renderer subset is vendored (file list + SHA-256 in `VENDORED.json`); the CLI, the preview server, the Chrome visual-check and the **remote update checker were removed**. Zero runtime dependencies, nothing installed. Runs as a child process with network / child-process APIs disabled (`../.opencode/lib/archify-netblock.mjs`), an empty environment and a timeout. The skill `../.opencode/skills/archify/SKILL.md` is our own adaptation (tool-based, legal templates); upstream `SKILL.md` kept as `SKILL.upstream.md` |

Images shown in answers come only from official domains (credited to the issuing body) or Wikimedia Commons files under CC0 / public domain / CC BY / CC BY-SA, each with author + license + source recorded and shown under the image (tools `image_search` / `image_fetch`, `../.opencode/lib/image-sources.ts`).
| vite, @vitejs/plugin-react | 8.3 / 6.1 | MIT | Build tooling (not shipped) |

Fonts: **Be Vietnam Pro** and **JetBrains Mono** are loaded from Google Fonts (SIL Open Font License 1.1).

The full license texts are in each package's folder under `node_modules/`.

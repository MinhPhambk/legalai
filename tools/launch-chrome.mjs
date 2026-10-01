// Sandbox Chrome launcher: one Chrome instance with the project's own profile and a local-only DevTools
// port that the chrome MCP (chrome-devtools-mcp --browserUrl) and the custom tools attach to. Kept alive in
// the background by run.sh so the MCP never has to launch Chrome itself (avoids first-launch timeouts /
// profile locks).
// Relaunches itself if Chrome exits or crashes. CHROME_MODE:
//   offscreen (default) – a real, headed Chrome whose window sits outside the visible desktop, so it never
//                         covers the user's screen; background throttling is off so pages still load/render
//   headless            – no window at all
//   window              – normal visible window (debugging)
// Usage: node tools/launch-chrome.mjs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.CHROME_PORT ?? '9333';
const EXE = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const MODE = ['offscreen', 'headless', 'window'].includes(process.env.CHROME_MODE) ? process.env.CHROME_MODE : 'offscreen';
const HEADLESS = MODE === 'headless';
const MODE_ARGS = {
  offscreen: ['--window-position=-32000,-32000', '--window-size=1366,900'],
  headless: ['--window-size=1366,900', `--user-agent=${desktopUserAgent()}`],
  window: ['--start-maximized'],
};
// An off-screen/occluded window must not be throttled, otherwise pages load slowly or timers stall.
const NO_THROTTLE = ['--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling'];

// Headless Chrome announces itself as "HeadlessChrome" in its user agent, which some government sites
// block – present the regular desktop Chrome UA of the installed version instead.
function desktopUserAgent() {
  const dir = path.dirname(EXE);
  const version = fs.readdirSync(dir).filter((d) => /^\d+\.\d+\.\d+\.\d+$/.test(d)).sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];
  const major = version?.split('.')[0] ?? '140';
  return `Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${major}.0.0.0 Safari/537.36`;
}

let stopping = false;
let browser = null;

async function launch() {
  browser = await puppeteer.launch({
    executablePath: EXE,
    userDataDir: path.join(ROOT, '.sandbox', 'chrome-profile'),
    headless: HEADLESS,
    pipe: true,
    defaultViewport: null,
    args: [
      `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
      '--no-first-run', '--no-default-browser-check', '--disable-sync',
      ...MODE_ARGS[MODE], ...NO_THROTTLE,
    ],
  });
  console.log(`sandbox chrome ready on 127.0.0.1:${PORT} (pid ${browser.process()?.pid}, ${MODE})`);
  browser.on('disconnected', () => {
    if (stopping) return process.exit(0);
    console.log(`sandbox chrome exited – relaunching in 2 s (${new Date().toISOString()})`);
    setTimeout(() => launch().catch(retry), 2000);
  });
}

function retry(e) {
  console.error(`sandbox chrome launch failed: ${e?.message ?? e} – retrying in 5 s`);
  setTimeout(() => launch().catch(retry), 5000);
}

for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, async () => { stopping = true; await browser?.close().catch(() => {}); process.exit(0); });
await launch().catch(retry);

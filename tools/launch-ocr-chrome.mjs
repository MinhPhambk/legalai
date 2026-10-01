// Dedicated OCR Chrome: a SEPARATE Chrome instance (own profile .sandbox/ocr-chrome-profile, DevTools port
// 127.0.0.1:9334) used only by .opencode/lib/pdf-ocr.ts to OCR scanned PDFs with Chrome's built-in PDF OCR
// ("Screen AI" component, the "This PDF is inaccessible. Text extracted, powered by Google AI" feature).
// Never the shared sandbox Chrome (:9333) and never the user's normal Chrome.
//   - headed but off-screen (--window-position=-32000,-32000): headless Chrome does not run the PDF OCR
//   - --force-renderer-accessibility: the OCR text only exists in the accessibility tree of the PDF viewer
//   - Chrome is spawned directly (not puppeteer.launch: its default flags disable component loading /
//     extensions, which the PDF viewer and Screen AI need)
//   - relaunches itself when Chrome exits
// First run: the Screen AI component does not download into a fresh profile, so it is SEEDED by copying the
// user's installed component folder %LOCALAPPDATA%\Google\Chrome\User Data\screen_ai\<ver> (read-only copy of
// that one folder; nothing else of the user's Chrome data is read or modified) into <profile>\screen_ai\<ver>.
// Before every launch the profile's Local State gets accessibility.screen_ai.last_used_time = now (without it Chrome
// deletes the copied component at startup). If no installed component is found, the launcher reports
// "OCR unavailable" (exit code 3) and does not start. Normally started lazily by .opencode/lib/pdf-ocr.ts.
// Usage: node tools/launch-ocr-chrome.mjs            (keeps running; Ctrl+C stops Chrome)
//        node tools/launch-ocr-chrome.mjs --seed-only (only seed the component, print status JSON)
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = process.env.OCR_CHROME_PORT ?? '9334';
const EXE = process.env.OCR_CHROME_EXE ?? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const PROFILE = process.env.OCR_CHROME_PROFILE ?? path.join(ROOT, '.sandbox', 'ocr-chrome-profile'); // override only for experiments / extra instances
const DLL = 'chrome_screen_ai.dll';

const verDirs = (dir) => {
  try {
    return fs.readdirSync(dir).filter((d) => /^\d+(\.\d+)*$/.test(d) && fs.existsSync(path.join(dir, d, DLL)))
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
  } catch { return []; }
}

// Chrome deletes <profile>/screen_ai at startup unless Local State has accessibility.screen_ai.last_used_time
// (a fresh profile has none) – so it is set to "now" before every launch (Chrome time: µs since 1601-01-01).
// Only call while the OCR Chrome is NOT running (Chrome rewrites Local State on exit).
export function markScreenAiUsed() {
  const file = path.join(PROFILE, 'Local State');
  let st = {};
  try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {}
  st.accessibility ??= {};
  st.accessibility.screen_ai = { ...(st.accessibility.screen_ai ?? {}), last_used_time: String((Date.now() + 11644473600000) * 1000) };
  fs.mkdirSync(PROFILE, { recursive: true });
  fs.writeFileSync(file, JSON.stringify(st));
}

/** Ensure <profile>/screen_ai/<ver>/chrome_screen_ai.dll exists (copying the user's installed component once). */
export function seedScreenAi() {
  const own = path.join(PROFILE, 'screen_ai');
  const have = verDirs(own);
  if (have.length) return { ok: true, version: have[0], seeded: false, dir: path.join(own, have[0]) };
  const local = process.env.LOCALAPPDATA ?? (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, 'AppData', 'Local') : '');
  // parallel worker profiles (<profile>-wN) copy the primary OCR profile's component; otherwise the installed one
  const primary = path.join(ROOT, '.sandbox', 'ocr-chrome-profile', 'screen_ai');
  let src = path.join(local, 'Google', 'Chrome', 'User Data', 'screen_ai');
  if (path.resolve(own) !== path.resolve(primary) && verDirs(primary).length) src = primary;
  const vers = verDirs(src);
  if (!vers.length) return { ok: false, reason: `OCR unavailable: Chrome "Screen AI" component not found (${path.join(src, '<ver>', DLL)}). Open any scanned PDF once in your normal Chrome (it downloads the component), then retry.` };
  const tmp = path.join(own, `.seed-${process.pid}`);
  fs.mkdirSync(own, { recursive: true });
  fs.cpSync(path.join(src, vers[0]), tmp, { recursive: true }); // read-only copy of that one folder
  fs.renameSync(tmp, path.join(own, vers[0]));
  if (!fs.existsSync(path.join(own, vers[0], DLL))) return { ok: false, reason: `OCR unavailable: copy of the Screen AI component is incomplete (${DLL} missing).` };
  return { ok: true, version: vers[0], seeded: true, from: src === primary ? 'primary OCR profile' : 'installed Chrome', dir: path.join(own, vers[0]) };
}

const up = async () => { try { return (await fetch(`http://127.0.0.1:${PORT}/json/version`, { signal: AbortSignal.timeout(1500) })).ok; } catch { return false; } };

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const seed = seedScreenAi();
  if (process.argv.includes('--seed-only')) { console.log(JSON.stringify(seed)); process.exit(seed.ok ? 0 : 3); }
  if (!seed.ok) { console.error(seed.reason); process.exit(3); }
  console.log(`screen_ai component ${seed.version} ${seed.seeded ? `seeded (copied from the ${seed.from})` : 'present'} in ${PROFILE}`);
  if (await up()) { console.log(`ocr chrome already running on 127.0.0.1:${PORT} – nothing to do (ready)`); process.exit(0); }

  let stopping = false;
  let child = null;
  const ARGS = [
    `--user-data-dir=${PROFILE}`, `--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1',
    '--window-position=-32000,-32000', '--window-size=1200,1600', '--force-renderer-accessibility',
    '--no-first-run', '--no-default-browser-check', '--disable-sync',
    '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding', '--disable-background-timer-throttling',
    'about:blank',
  ];
  const launch = async () => {
    const s = seedScreenAi(); // Chrome may have removed it (e.g. after a crash): re-seed, then mark it used
    if (!s.ok) { console.error(s.reason); process.exit(3); }
    markScreenAiUsed();
    child = spawn(EXE, ARGS, { stdio: 'ignore', windowsHide: false });
    child.on('exit', (code) => {
      if (stopping) return process.exit(0);
      console.log(`ocr chrome exited (code ${code}) – relaunching in 2 s (${new Date().toISOString()})`);
      setTimeout(() => launch().catch(retry), 2000);
    });
    for (let i = 0; i < 60 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
    if (!(await up())) throw new Error(`DevTools port ${PORT} did not open`);
    console.log(`ocr chrome ready on 127.0.0.1:${PORT} (pid ${child.pid}, offscreen, screen_ai ${seed.version})`);
  };
  const retry = (e) => { console.error(`ocr chrome launch failed: ${e?.message ?? e} – retrying in 5 s`); setTimeout(() => launch().catch(retry), 5000); };
  // Parallel workers (started by pdf-ocr.ts with OCR_CHROME_IDLE_EXIT_MIN) stop after that many idle minutes: each
  // idle OCR Chrome keeps the Screen AI model resident (~450–650 MB). The main OCR Chrome has no idle exit.
  const idleMin = +(process.env.OCR_CHROME_IDLE_EXIT_MIN ?? 0);
  if (idleMin > 0) {
    let lastBusy = Date.now();
    setInterval(async () => {
      try {
        const tabs = await (await fetch(`http://127.0.0.1:${PORT}/json/list`, { signal: AbortSignal.timeout(3000) })).json();
        if (tabs.some((t) => t.type === 'page' && !/^(about:blank|chrome:\/\/newtab)/.test(t.url))) lastBusy = Date.now();
      } catch {}
      if (Date.now() - lastBusy > idleMin * 60_000) { console.log(`idle ${idleMin} min – stopping ocr chrome ${PORT}`); stopping = true; try { child?.kill(); } catch {} setTimeout(() => process.exit(0), 1000); }
    }, 30_000);
  }
  for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { stopping = true; try { child?.kill(); } catch {} setTimeout(() => process.exit(0), 500); });
  await launch().catch(retry);
}

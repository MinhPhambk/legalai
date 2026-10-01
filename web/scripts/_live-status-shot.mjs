// Temporary: screenshot the live tool status while a prompt runs, and the finished state.
import puppeteer from 'puppeteer-core';
import fs from 'node:fs';
const pw = fs.readFileSync(new URL('../../.sandbox/web/admin-password.txt', import.meta.url), 'utf8').trim();
const b = await puppeteer.connect({ browserURL: 'http://127.0.0.1:9333', defaultViewport: null });
const p = await b.newPage();
await p.setViewport({ width: 1280, height: 860 });
await p.goto('http://127.0.0.1:3000/', { waitUntil: 'networkidle2' });
if (await p.$('input[type=email]')) {
  await p.type('input[type=email]', 'admin@legalai.local');
  await p.type('input[type=password]', pw);
  await p.keyboard.press('Enter');
  await p.waitForSelector('textarea', { timeout: 20000 });
}
await p.type('textarea', 'Thép mạ kẽm của Việt Nam xuất sang Úc có đang bị điều tra phòng vệ thương mại không?');
await p.keyboard.press('Enter');
const shots = [8, 25, 50];
let t0 = Date.now();
for (const s of shots) {
  await new Promise((r) => setTimeout(r, s * 1000 - (Date.now() - t0)));
  await p.screenshot({ path: `web/screenshots/10-live-status-${s}s.png` });
  const line = await p.$eval('.steps-current', (e) => e.innerText).catch(() => '(no status line)');
  console.log(`${s}s:`, line);
}
await p.waitForFunction(() => !document.querySelector('.steps.running') && document.querySelector('.msg-actions'), { timeout: 420000 }).catch(() => console.log('not finished in time'));
console.log('done after', ((Date.now() - t0) / 1000).toFixed(0), 's');
await p.screenshot({ path: 'web/screenshots/11-live-status-done.png' });
const [head] = await p.$$('.steps-head'); await head?.click(); await new Promise((r) => setTimeout(r, 800));
await p.screenshot({ path: 'web/screenshots/12-steps-expanded.png' });
await p.close(); b.disconnect();

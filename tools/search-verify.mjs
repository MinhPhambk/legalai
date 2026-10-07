// Let the owner pass a search engine's bot check ONCE by hand inside the sandbox Chrome (its cookies then live in
// .sandbox/chrome-profile, so web_search works again). We never solve or bypass the check ourselves.
//   node tools/search-verify.mjs          → opens an on-screen window of the sandbox Chrome with Bing + DuckDuckGo
//   node tools/search-verify.mjs --close  → closes those tabs (the sandbox Chrome itself keeps running off-screen)
import puppeteer from 'puppeteer-core';
const PORT = process.env.CHROME_PORT ?? '9333';
const MARK = 'legalai-verify';
const URLS = [
  `https://www.bing.com/search?q=lu%E1%BA%ADt+th%C6%B0%C6%A1ng+m%E1%BA%A1i+2005&setlang=vi#${MARK}`,
  `https://html.duckduckgo.com/html/?q=lu%E1%BA%ADt+th%C6%B0%C6%A1ng+m%E1%BA%A1i+2005#${MARK}`,
];
const browser = await puppeteer.connect({ browserURL: `http://127.0.0.1:${PORT}`, defaultViewport: null });
try {
  if (process.argv.includes('--close')) {
    let n = 0;
    for (const p of await browser.pages()) if (p.url().includes(MARK) || /bing\.com\/search|duckduckgo\.com\/(html|lite)/.test(p.url())) { await p.close().catch(() => {}); n++; }
    console.log(`đã đóng ${n} tab xác minh`);
  } else {
    const cdp = await browser.target().createCDPSession();
    // a new window (not a tab of the off-screen one), moved onto the screen
    const { targetId } = await cdp.send('Target.createTarget', { url: URLS[0], newWindow: true });
    const { windowId } = await cdp.send('Browser.getWindowForTarget', { targetId });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
    await cdp.send('Browser.setWindowBounds', { windowId, bounds: { left: 80, top: 60, width: 1150, height: 820 } });
    const page = (await browser.pages()).find((p) => p.target()._targetId === targetId) || (await browser.pages()).at(-1);
    await page.bringToFront().catch(() => {});
    // second tab in the same window
    const page2 = await browser.newPage();
    await page2.goto(URLS[1], { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(() => {});
    await page.bringToFront().catch(() => {});
    console.log('Đã mở cửa sổ trình duyệt sandbox (Bing + DuckDuckGo). Nếu trang hỏi xác minh / CAPTCHA, hãy tự bấm cho qua; thấy kết quả tìm kiếm là xong.');
  }
} finally { browser.disconnect(); }

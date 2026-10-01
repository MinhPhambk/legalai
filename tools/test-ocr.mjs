// Tests for the scanned-PDF OCR fallback (.opencode/lib/pdf-ocr.ts, dedicated OCR Chrome on 127.0.0.1:9334 started
// lazily by the lib via tools/launch-ocr-chrome.mjs). Short on purpose: ≤ 2 PDFs, ≤ 3 pages each.
//   node tools/test-ocr.mjs [dir-with-TAND377340.pdf-and-TAND377305.pdf]   (án lệ 90/2026 and 84/2026 scans)
// Without the PDFs (or with ND45_OCR_TEST_OFFLINE=1) only the offline unit tests run.
// The court_anle_document step needs the sandbox Chrome (:9333) for the download from anle.toaan.gov.vn.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import crypto from 'node:crypto';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
process.env.XDG_CACHE_HOME ??= path.join(ROOT, '.sandbox', 'cache');
const PDF_DIR = process.argv[2] ?? process.env.ND45_OCR_TEST_PDFS ?? '';
const AL90 = path.join(PDF_DIR, 'TAND377340.pdf'), AL84 = path.join(PDF_DIR, 'TAND377305.pdf');
const online = PDF_DIR && fs.existsSync(AL90) && process.env.ND45_OCR_TEST_OFFLINE !== '1';

const o = await import('../.opencode/lib/pdf-ocr.ts');
const g = await import('../.opencode/tools/grounding.ts');
const ev = await import('../.opencode/lib/evidence.ts');
let failed = 0;
const step = async (label, f) => {
  const t = Date.now();
  try { const r = await f(); console.log(`ok   ${label} (${((Date.now() - t) / 1000).toFixed(1)}s)${r ? ` – ${r}` : ''}`); }
  catch (e) { failed++; console.log(`FAIL ${label} (${((Date.now() - t) / 1000).toFixed(1)}s): ${e?.stack ?? e}`); }
};
const CYR = /[Ѐ-ӿͰ-Ͽ]/;

// ---------------------------------------------------------------- offline
await step('normalize: Cyrillic/Greek look-alikes → Latin inside Latin words', () => {
  const { text } = o.normalizeOcrText('CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAМ\nQuyết định số 1О/2024 của Сhánh án\nΑSEAN và Tòa án\nthành phố Москва'); // М, О, С, Greek Α; "Москва" = real Cyrillic
  assert.match(text, /VIỆT NAM$/m); assert.ok(!/VIỆT NAМ/.test(text));
  assert.match(text, /\b1O\/2024 của Chánh án/); // O not 0: only the look-alike is replaced, no guessing
  assert.match(text, /^ASEAN và Tòa án$/m);
  assert.match(text, /Москва/, 'a real Cyrillic word without Latin letters on a mixed line is kept when the line is not Latin-dominated');
  const s = o.normalizeOcrText('Chánh ản Tòa án nhân dân tối cao М');
  assert.ok(!CYR.test(s.text), 'standalone look-alike on a Latin line');
});
await step('normalize: NFC, spacing, merged two-column header, stamp noise (conservative)', () => {
  const nfd = 'Tòa án'.normalize('NFD');
  const { text, dropped } = o.normalizeOcrText(`TÒA ÁN NHÂN DÂN TỐI CAO CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM\n${nfd}  nhân   dân , tối cao .\nTOA\nNHAN\nWTO\nFTA EU\nQUYẾT ĐỊNH\nAL`);
  assert.equal(text.split('\n')[0], 'TÒA ÁN NHÂN DÂN TỐI CAO'); assert.equal(text.split('\n')[1], 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM');
  assert.match(text, /^Tòa án nhân dân, tối cao\.$/m);
  assert.deepEqual(dropped, ['TOA', 'NHAN']);
  for (const keep of ['WTO', 'FTA EU', 'QUYẾT ĐỊNH', 'AL']) assert.match(text, new RegExp(`^${keep}$`, 'm'));
});
await step('parseAxTree: pdfRoot → region Page N → staticText', () => {
  const tree = [
    "id#=5 rootWebArea name='x.pdf'", "++id#=9 pdfRoot name='PDF document containing 2 pages'",
    "++++id#=11 banner name='This PDF is inaccessible. Text extracted, powered by Google AI'",
    "++++id#=-1000000006 region name='Page 1'", "++++++id#=-7 staticText name='Start of extracted text'",
    "++++++id#=-8 paragraph", "++++++++id#=-9 staticText name='Nguồn án lệ:'", "++++++++id#=-10 staticText name='Quyết định giám đốc thẩm'",
    "++++id#=-1000000020 region name='Page 2'", "++++++id#=-21 staticText name='Người ta nói: 'x' là y<newline>dòng 2'",
    "++id#=30 staticText name='ngoài trang'",
  ].join('\n');
  const p = o.parseAxTree(tree);
  assert.equal(p.total, 2); assert.match(p.banner, /Text extracted/);
  assert.equal(p.pages.get(1), 'Nguồn án lệ:\nQuyết định giám đốc thẩm');
  assert.equal(p.pages.get(2), "Người ta nói: 'x' là y\ndòng 2");
});
await step('grounding: quote found only in OCR evidence → supported but TRUNG BÌNH', async () => {
  const url = 'https://anle.toaan.gov.vn/webcenter/portal/anle/chitietanle?dDocName=TANDTEST';
  const quote = 'Toà án phải xác định giấy chứng nhận quyền sử dụng đất là quyết định hành chính và có thẩm quyền xem xét tính hợp pháp';
  const body = `${o.OCR_LABEL}\nÁn lệ số 90/2026/AL\nGiải pháp pháp lý: Trường hợp này, ${quote} của giấy chứng nhận.`;
  const answer = `Theo Án lệ số 90/2026/AL: "${quote}". Nguồn: ${url}`;
  const S1 = { sessionID: 'ocr-grounding-' + Date.now() };
  ev.recordEvidence(S1.sessionID, { url, title: 'Án lệ số 90/2026/AL', text: body, source: 'anle.toaan.gov.vn', meta: { ocr: true, engine: o.OCR_ENGINE } });
  const r1 = await g.check.execute({ answer }, S1);
  assert.match(r1, /ĐỘ TIN CẬY \(tính từ bằng chứng\): TRUNG BÌNH/, r1);
  assert.match(r1, /chỉ có trong văn bản nhận dạng OCR/); assert.doesNotMatch(r1, /KHÔNG có nguyên văn/);
  const S2 = { sessionID: 'ocr-grounding-plain-' + Date.now() };
  ev.recordEvidence(S2.sessionID, { url, title: 'Án lệ số 90/2026/AL', text: body, source: 'anle.toaan.gov.vn', meta: {} });
  const r2 = await g.check.execute({ answer }, S2);
  assert.match(r2, /ĐỘ TIN CẬY \(tính từ bằng chứng\): CAO/, r2);
  return 'OCR → TRUNG BÌNH, same text without meta.ocr → CAO';
});

// ---------------------------------------------------------------- live OCR (dedicated OCR Chrome)
await step('grounding: OCR\'d upload (artifact evidence, meta.ocr) → supported but TRUNG BÌNH', async () => {
  const url = 'https://vbpl.vn/van-ban/chi-tiet/luat-thuong-mai-so-36-2005-qh11--26117';
  const law = 'Mức phạt đối với vi phạm nghĩa vụ hợp đồng hoặc tổng mức phạt đối với nhiều vi phạm do các bên thoả thuận trong hợp đồng';
  const clause = 'Bên B phải thanh toán toàn bộ giá trị hợp đồng trong vòng ba mươi ngày kể từ ngày nhận hàng';
  const answer = `Điều 301 Luật Thương mại 36/2005/QH11: "${law}". Hợp đồng của bạn ghi: "${clause}". Nguồn: ${url}`;
  const run = async (ocr) => {
    const S = { sessionID: `ocr-upload-${ocr}-${Date.now()}` };
    ev.recordEvidence(S.sessionID, { url, title: 'Luật Thương mại 36/2005/QH11 – Điều 301', text: `Luật Thương mại số 36/2005/QH11\nĐiều 301. ${law}, nhưng không quá 8%.`, source: 'vbpl_article' });
    ev.recordEvidence(S.sessionID, { url: 'artifact://20260927000000-abcdef', title: 'Hợp đồng (bản scan)', text: `${o.OCR_LABEL}\nĐiều 5. ${clause}.`, source: 'artifact', meta: ocr ? { ocr: true, engine: o.OCR_ENGINE } : {} });
    return g.check.execute({ answer }, S);
  };
  const plain = await run(false), ocr = await run(true);
  assert.match(plain, /ĐỘ TIN CẬY \(tính từ bằng chứng\): CAO/, plain);
  assert.match(ocr, /ĐỘ TIN CẬY \(tính từ bằng chứng\): TRUNG BÌNH/, ocr);
  assert.match(ocr, /1 căn cứ chỉ có trong văn bản nhận dạng OCR/); assert.doesNotMatch(ocr, /KHÔNG có nguyên văn/);
  return 'upload without OCR → CAO, OCR\'d upload → TRUNG BÌNH (ocr_evidence)';
});
await step('doc-store: importDocument({ocr}) persists meta.ocr, evidence meta.ocr=true, kept by the next version', async () => {
  const ds = await import('../.opencode/lib/doc-store.ts');
  const sid = 'ocr-docstore-' + Date.now();
  try {
    const ocrMeta = { engine: o.OCR_ENGINE, pages: [1, 2], totalPages: 9 };
    const v1 = await ds.importDocument({ sessionID: sid, title: 'Bản scan thử', markdown: `${o.OCR_LABEL}\n\nĐiều 1. Nội dung thử nghiệm của văn bản nhận dạng.`, formats: ['docx'], ocr: ocrMeta });
    assert.deepEqual(v1.ocr, ocrMeta);
    const onDisk = ds.findDocument([sid], v1.id); assert.deepEqual(onDisk.ocr, ocrMeta);
    const e1 = ev.loadEvidence(sid).find((e) => e.url === `artifact://${v1.id}`); assert.equal(e1?.meta?.ocr, true); assert.equal(e1.meta.engine, o.OCR_ENGINE);
    const v2 = await ds.saveDocument({ sessionID: sid, title: v1.title, markdown: ds.readMarkdown(v1) + '\nĐiều 2. Thêm.', kind: v1.kind, formats: ['docx'], parent: v1, origin: 'upload' });
    assert.equal(v2.version, 2); assert.deepEqual(v2.ocr, ocrMeta, 'carried forward to the edited version');
    assert.equal(ev.loadEvidence(sid).find((e) => e.url === `artifact://${v2.id}`)?.meta?.ocr, true);
    const plain = await ds.importDocument({ sessionID: sid, title: 'Không OCR', markdown: 'Điều 1. Văn bản thường có lớp chữ.', formats: ['docx'] });
    assert.equal(plain.ocr, undefined); assert.notEqual(ev.loadEvidence(sid).find((e) => e.url === `artifact://${plain.id}`)?.meta?.ocr, true);
    return `v1 ${v1.id} → v2 ${v2.id}, ocr kept`;
  } finally {
    fs.rmSync(ds.outDir(sid), { recursive: true, force: true });
  }
});

if (!online) {
  console.log(`(live OCR tests skipped: pass the folder with TAND377340.pdf / TAND377305.pdf – got "${PDF_DIR}")`);
} else {
  const cacheOf = (buf) => path.join(process.env.XDG_CACHE_HOME, 'legalai', 'ocr', `${crypto.createHash('sha256').update(buf).digest('hex')}.json`);
  await step('health check (starts the OCR Chrome lazily)', async () => {
    const h = await o.ocrHealth();
    assert.ok(h.ok, h.reason); assert.equal(h.port, '9334'); assert.ok(h.component);
    return `port ${h.port}, screen_ai ${h.component}`;
  });
  const buf90 = fs.readFileSync(AL90);
  fs.rmSync(cacheOf(buf90), { force: true });
  let first;
  await step('án lệ 90/2026 pages 1–2 (fresh OCR)', async () => {
    first = await o.ocrPdf(buf90, { pages: [1, 2] });
    assert.deepEqual(first.pages.map((p) => p.n), [1, 2]); assert.equal(first.totalPages, 9); assert.equal(first.cached, false);
    const all = first.pages.map((p) => p.text).join('\n');
    for (const k of ['Nguồn án lệ', 'Tình huống án lệ', 'Giải pháp pháp lý', 'ÁN LỆ SỐ 90/2026/AL', 'CỘNG HÒA XÃ HỘI CHỦ NGHĨA VIỆT NAM']) assert.ok(all.includes(k), `missing "${k}"`);
    assert.ok(!CYR.test(all), 'Cyrillic look-alikes left in the text');
    assert.ok(o.ocrBlock(first).startsWith(o.OCR_LABEL));
    return `${first.ms} ms, ${all.length} chars, warnings: ${first.warnings.join(' | ') || '-'}`;
  });
  await step('cache: same PDF again → cached, fast, same text', async () => {
    const again = await o.ocrPdf(buf90, { pages: [1, 2] });
    assert.equal(again.cached, true); assert.ok(again.ms < 1000, `${again.ms} ms`);
    assert.deepEqual(again.pages, first?.pages);
    return `${again.ms} ms`;
  });
  if (fs.existsSync(AL84)) await step('án lệ 84/2026 page 1 (from a file path)', async () => {
    const r = await o.ocrPdf(AL84, { pages: [1] });
    assert.match(r.pages[0].text, /Nguồn án lệ/); assert.match(r.pages[0].text, /84\/2026\/AL/);
    return `${r.ms} ms${r.cached ? ' (cached)' : ''}`;
  });
  if (fs.existsSync(AL84)) await step('parallel (ND45_OCR_PARALLEL=2, 4 pages of 84/2026 in 2 OCR Chromes) = sequential text', async () => {
    const b84 = fs.readFileSync(AL84);
    const fresh = (tag) => Buffer.concat([b84, Buffer.from(`\n%test-${tag}-${Date.now()}\n`)]); // unique sha → no cache
    const saved = process.env.ND45_OCR_PARALLEL;
    try {
      process.env.ND45_OCR_PARALLEL = '1'; const t1 = Date.now(); const seq = await o.ocrPdf(fresh('seq'), { pages: [1, 2, 3, 4] }); const s1 = Date.now() - t1;
      process.env.ND45_OCR_PARALLEL = '2'; const t2 = Date.now(); const par = await o.ocrPdf(fresh('par'), { pages: [1, 2, 3, 4] }); const s2 = Date.now() - t2;
      assert.deepEqual(par.pages.map((p) => p.n), [1, 2, 3, 4]); assert.equal(par.totalPages, 5);
      assert.deepEqual(par.pages, seq.pages, 'parallel text differs from sequential');
      return `sequential ${s1} ms, parallel ${s2} ms (incl. worker start on first use)`;
    } finally { if (saved === undefined) delete process.env.ND45_OCR_PARALLEL; else process.env.ND45_OCR_PARALLEL = saved; }
  });
  await step('graceful failure when the OCR Chrome is down', async () => {
    const saved = { p: process.env.OCR_CHROME_PORT, a: process.env.ND45_OCR_AUTOSTART };
    process.env.OCR_CHROME_PORT = '9399'; process.env.ND45_OCR_AUTOSTART = '0';
    try {
      const h = await o.ocrHealth({ start: false });
      assert.equal(h.ok, false); assert.match(h.reason, /không chạy/);
      const other = Buffer.concat([buf90, Buffer.from(`\n%test-${Date.now()}\n`)]); // different sha → not cached
      await assert.rejects(o.ocrPdf(other, { pages: [1] }), (e) => e instanceof o.OcrUnavailable && /OCR Chrome không chạy/.test(e.message));
    } finally {
      if (saved.p === undefined) delete process.env.OCR_CHROME_PORT; else process.env.OCR_CHROME_PORT = saved.p;
      if (saved.a === undefined) delete process.env.ND45_OCR_AUTOSTART; else process.env.ND45_OCR_AUTOSTART = saved.a;
    }
    return 'OcrUnavailable thrown, no hang';
  });
  // court_anle_document on the scanned 90/2026: needs the sandbox Chrome (:9333) for the download
  const sandboxUp = await fetch(`http://127.0.0.1:${process.env.CHROME_PORT ?? 9333}/json/version`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);
  if (!sandboxUp) console.log('(court_anle_document step skipped: sandbox Chrome :9333 not running)');
  else await step('court_anle_document 90/2026 → OCR text instead of "bản scan"', async () => {
    process.env.ND45_OCR_MAX_PAGES = '3'; // keep the test short; the anle cache entry is restored afterwards
    const court = await import('../.opencode/tools/court.ts');
    const file = path.join(process.env.XDG_CACHE_HOME, 'legalai', 'anle', 'TAND377340.json');
    const before = fs.existsSync(file) ? fs.readFileSync(file) : null;
    const S = { sessionID: 'ocr-court-' + Date.now(), messageID: 'm-test' };
    try {
      // force the scan path (download → OCR) even when an OCR'd entry is cached; restored in finally
      if (before) { const d = JSON.parse(before); fs.writeFileSync(file, JSON.stringify({ id: d.id, kind: 'scan', text: '', pages: d.pages ?? 9, title: d.title ?? '', fetched: Date.now() })); }
      const r = await court.anle_document.execute({ ref: '90/2026' }, S);
      const out = r.output;
      assert.ok(out.includes(o.OCR_LABEL), out.slice(0, 600));
      assert.doesNotMatch(out, /không trích được nội dung/);
      assert.match(out, /Tình huống án lệ:/); assert.match(out, /Giải pháp pháp lý:/);
      const ui = r.metadata.ui;
      assert.equal(ui.ocr, true); assert.equal(ui.engine, 'chrome-screen-ai'); assert.deepEqual(ui.pages, [1, 2, 3]);
      const e = ev.loadEvidence(S.sessionID).find((x) => /TAND377340/.test(x.url));
      assert.equal(e?.meta?.ocr, true); assert.ok(e.text.startsWith(o.OCR_LABEL));
      console.log(out.split('\n').slice(0, 16).join('\n'));
      return `${out.length} chars`;
    } finally {
      if (before) fs.writeFileSync(file, before); else fs.rmSync(file, { force: true });
      delete process.env.ND45_OCR_MAX_PAGES;
    }
  });
}
console.log(failed ? `\n${failed} FAILED` : '\nall OCR tests passed');
process.exit(failed ? 1 : 0);

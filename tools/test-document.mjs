// Smoke test for document_create (needs the sandbox Chrome for PDF: node tools/launch-chrome.mjs).
process.env.XDG_CACHE_HOME ??= new URL('../.sandbox/cache', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1');
const d = await import('../.opencode/tools/document.ts');
const md = `# Hợp đồng phân phối độc quyền\n\nSố: 01/2026/HĐPP\n\nHôm nay, ngày ... tháng ... năm 2026, tại Hà Nội, chúng tôi gồm:\n\n**BÊN GIAO ĐẠI LÝ (Bên A):** Công ty A\n\n**BÊN PHÂN PHỐI (Bên B):** Công ty B\n\n## Điều 1. Đối tượng\n\nBên A giao cho Bên B quyền phân phối **độc quyền** sản phẩm cà phê rang xay tại khu vực miền Bắc.\n\n## Điều 2. Chỉ tiêu doanh số\n\n| Năm | Doanh số tối thiểu |\n|---|---|\n| 2027 | 5.000.000.000 đồng |\n| 2028 | 6.000.000.000 đồng |\n\n1. Bên B cam kết đạt chỉ tiêu trên.\n2. Nếu không đạt 80% chỉ tiêu, Bên A có quyền chấm dứt quyền độc quyền.\n\n> Căn cứ Điều 301 Luật Thương mại 2005: mức phạt không quá 8% giá trị phần nghĩa vụ bị vi phạm.\n`;
const s = Date.now();
const r = await d.create.execute({ title: 'Hợp đồng phân phối độc quyền (thử)', markdown: md, kind: 'hop-dong', sign_a: 'ĐẠI DIỆN BÊN A', sign_b: 'ĐẠI DIỆN BÊN B' }, { sessionID: 'document-smoke' });
console.log(r, '\n', ((Date.now() - s) / 1000).toFixed(1) + 's');

// API test for Admin → Lab thử nghiệm (web/server/lab.mjs) against the running web app (default http://127.0.0.1:7889).
import assert from 'node:assert/strict';
import fs from 'node:fs';
const U = process.env.U || 'http://127.0.0.1:7889';
const login = async (email, pw) => { const r = await fetch(U + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: U }, body: JSON.stringify({ email, password: pw }) }); return r.headers.getSetCookie().map((c) => c.split(';')[0]).join('; ') };
const call = async (ck, m, p, b) => { const r = await fetch(U + p, { method: m, headers: { 'Content-Type': 'application/json', Origin: U, Cookie: ck }, body: b && JSON.stringify(b) }); return { s: r.status, j: await r.json().catch(() => ({})) } };
const admin = await login('admin@legalai.local', fs.readFileSync(new URL('../.sandbox/web/admin-password.txt', import.meta.url), 'utf8').trim());
const userPw = fs.readFileSync(new URL('../THONG-TIN-TRUY-CAP.txt', import.meta.url), 'utf8').match(/Tài khoản thường[^\n]*\nMật khẩu\s*:\s*(\S+)/)?.[1];
assert.equal((await call(admin, 'POST', '/api/admin/lab', { name: '  ' })).s, 400, 'name required');
const c = await call(admin, 'POST', '/api/admin/lab', { name: 'Test lab product', tagline: 'tagline', status: 'idea', tools: ['tariff_vn', 'tariff_vn', 'x'.repeat(200)], evil: { a: 1 } });
assert.equal(c.s, 200); const id = c.j.product.id;
assert.deepEqual(c.j.product.tools, ['tariff_vn', 'x'.repeat(80)], 'tools deduped and bounded');
assert.equal(c.j.product.evil, undefined, 'unknown fields dropped');
const u = await call(admin, 'PATCH', `/api/admin/lab/${id}`, { status: 'pilot', notes: 'n', examples: ['a', '', 'b'], status2: 'x' });
assert.equal(u.j.product.status, 'pilot'); assert.deepEqual(u.j.product.examples, ['a', 'b']); assert.deepEqual(u.j.product.tools, ['tariff_vn', 'x'.repeat(80)], 'patch keeps other fields');
assert.equal((await call(admin, 'PATCH', `/api/admin/lab/${id}`, { status: 'nonsense' })).j.product.status, 'pilot', 'invalid status ignored');
assert.ok((await call(admin, 'GET', '/api/admin/lab')).j.products.some((p) => p.id === id));
if (userPw) { const user = await login('user@legalai.local', userPw); assert.equal((await call(user, 'GET', '/api/admin/lab')).s, 403, 'normal user forbidden') }
assert.equal((await call('', 'GET', '/api/admin/lab')).s, 401, 'anonymous forbidden');
assert.equal((await call(admin, 'DELETE', `/api/admin/lab/${id}`)).s, 200);
assert.equal((await call(admin, 'GET', `/api/admin/lab/${id}`)).s, 404, 'deleted');
console.log('lab API tests pass');

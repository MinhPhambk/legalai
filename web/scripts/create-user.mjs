#!/usr/bin/env node
// Usage: node scripts/create-user.mjs <email> <password> [--admin]
//        (or: npm run create-user -- <email> <password> [--admin])
// Creates the account in nd45-platform/.sandbox/web/app.db. If the email exists, the password
// (and admin flag, when given) is updated instead.
import { createUser, findUserByEmail, hashPassword, validateCredentials } from "../server/auth.mjs"
import { q } from "../server/db.mjs"

const args = process.argv.slice(2)
const admin = args.includes("--admin")
const [email, password] = args.filter((a) => a !== "--admin")
if (!email || !password) {
  console.error("Cách dùng: node scripts/create-user.mjs <email> <mật khẩu> [--admin]")
  process.exit(2)
}
const invalid = validateCredentials(email, password)
if (invalid) {
  console.error(invalid)
  process.exit(2)
}
const existing = findUserByEmail(email)
if (existing) {
  const { salt, hash } = await hashPassword(password)
  q("UPDATE users SET password_hash = ?, salt = ?, is_admin = CASE WHEN ? THEN 1 ELSE is_admin END WHERE id = ?").run(hash, salt, admin ? 1 : 0, existing.id)
  q("DELETE FROM sessions WHERE user_id = ?").run(existing.id)
  console.log(`Đã cập nhật mật khẩu cho ${existing.email}${admin ? " (admin)" : ""}; các phiên đăng nhập cũ đã bị huỷ.`)
} else {
  const u = await createUser(email, password, { admin })
  console.log(`Đã tạo tài khoản ${u.email}${admin ? " (admin)" : ""} – id ${u.id}`)
}

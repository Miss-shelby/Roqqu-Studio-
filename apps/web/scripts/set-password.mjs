// Give an existing business a password (accounts made before email + password sign-in).
//   DATABASE_URL=... node scripts/set-password.mjs owner@example.com "new password"
import { randomBytes, scrypt } from "node:crypto";
import postgres from "postgres";

const [email, password] = process.argv.slice(2);
if (!process.env.DATABASE_URL || !email || !password || password.length < 8) {
  console.error('Usage: DATABASE_URL=... node scripts/set-password.mjs <email> "<password, 8+ chars>"');
  process.exit(1);
}
const salt = randomBytes(16);
const key = await new Promise((resolve, reject) =>
  scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 }, (e, k) => (e ? reject(e) : resolve(k))),
);
const sql = postgres(process.env.DATABASE_URL, { prepare: false, max: 1 });
const rows = await sql`update businesses set password_hash = ${`scrypt$${salt.toString("hex")}$${key.toString("hex")}`},
                         failed_logins = 0, locked_until = null
                       where email = ${email.trim().toLowerCase()} returning business_name`;
await sql.end();
console.log(rows.length ? `Password set for ${rows[0].business_name}.` : `No business with email ${email}.`);

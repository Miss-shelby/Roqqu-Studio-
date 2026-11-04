/**
 * Password hashing with Node's built-in scrypt (no extra dependency).
 * Stored as "scrypt$<salt hex>$<hash hex>"; compared in constant time.
 */
import { randomBytes, scrypt as scryptCb, timingSafeEqual, type BinaryLike, type ScryptOptions } from "node:crypto";

const KEYLEN = 64;
const OPTS: ScryptOptions = { N: 16384, r: 8, p: 1, maxmem: 64 * 1024 * 1024 };

function scrypt(password: BinaryLike, salt: BinaryLike): Promise<Buffer> {
  return new Promise((resolve, reject) =>
    scryptCb(password, salt, KEYLEN, OPTS, (err, key) => (err ? reject(err) : resolve(key))),
  );
}

export const MIN_PASSWORD = 8;

/** Why a password is not acceptable, or null when it is. */
export function passwordProblem(password: string): string | null {
  if (password.length < MIN_PASSWORD) return `Use a password of at least ${MIN_PASSWORD} characters.`;
  if (password.length > 200) return "That password is too long.";
  return null;
}

export async function hashPassword(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString("hex")}$${(await scrypt(password, salt)).toString("hex")}`;
}

export async function verifyPassword(password: string, stored: string | null | undefined): Promise<boolean> {
  const [kind, saltHex, hashHex] = String(stored ?? "").split("$");
  if (kind !== "scrypt" || !saltHex || !hashHex) {
    await scrypt(password, "no-such-user"); // same cost either way, so timing says nothing
    return false;
  }
  const expected = Buffer.from(hashHex, "hex");
  const actual = await scrypt(password, Buffer.from(saltHex, "hex"));
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

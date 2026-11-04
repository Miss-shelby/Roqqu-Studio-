/**
 * Businesses, their RAS wallets and balances. A business is created from four
 * fields (owner name, business name, email, password); its wallets are
 * generated right after, on every network a payment link uses.
 */
import { randomBytes, randomUUID } from "node:crypto";

import { db } from "./db";
import { generateWallet, NETWORKS, type Customer, type Network } from "./ras";
import { slugify } from "./money";
import { hashPassword, passwordProblem, verifyPassword } from "./password";

export interface Business {
  id: string;
  slug: string;
  owner_name: string;
  business_name: string;
  email: string;
  wallet_status: "pending" | "ready" | "failed";
  wallet_error: string | null;
  created_at: Date;
}

export interface Wallet {
  network: Network;
  token: string;
  address: string;
}

export class BizError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

/** Everything about a business except its password hash: never select `*`. */
const COLS = "id, slug, owner_name, business_name, email, wallet_status, wallet_error, created_at";
export const MAX_FAILED_LOGINS = 5;
export const LOCK_MINUTES = 15;

export function cleanOnboarding(input: { owner_name?: unknown; business_name?: unknown; email?: unknown; password?: unknown }) {
  const owner = String(input.owner_name ?? "").trim().replace(/\s+/g, " ");
  const business = String(input.business_name ?? "").trim().replace(/\s+/g, " ");
  const email = String(input.email ?? "").trim().toLowerCase();
  if (owner.length < 2 || owner.length > 80) throw new BizError("Enter your name (2 to 80 characters).");
  if (business.length < 2 || business.length > 80) throw new BizError("Enter your business name (2 to 80 characters).");
  if (!EMAIL_RE.test(email) || email.length > 120) throw new BizError("Enter a valid email address.");
  const password = String(input.password ?? "");
  const problem = passwordProblem(password);
  if (problem) throw new BizError(problem);
  return { owner_name: owner, business_name: business, email, password };
}

/** RAS customer details for the owner: first word is the first name, the rest the last. */
export function ownerAsCustomer(b: Pick<Business, "owner_name" | "email">): Customer {
  const [first, ...rest] = b.owner_name.split(" ");
  return { email: b.email, first_name: first, last_name: rest.join(" ") || first };
}

export async function createBusiness(input: { owner_name: string; business_name: string; email: string; password: string }): Promise<Business> {
  const sql = db();
  const [existing] = await sql<{ id: string }[]>`select id from businesses where email = ${input.email}`;
  if (existing) throw new BizError("This email already has a business. Use “Sign in” instead.", 409);
  const passwordHash = await hashPassword(input.password);
  const base = slugify(input.business_name);
  for (let attempt = 0; attempt < 5; attempt++) {
    const slug = attempt === 0 ? base : `${base}-${randomBytes(2).toString("hex")}`;
    const rows = await sql<Business[]>`
      insert into businesses (id, slug, owner_name, business_name, email, password_hash)
      values (${randomUUID()}, ${slug}, ${input.owner_name}, ${input.business_name}, ${input.email}, ${passwordHash})
      on conflict do nothing
      returning ${sql.unsafe(COLS)}`;
    if (rows[0]) return rows[0];
  }
  throw new BizError("Could not reserve a store name. Try a slightly different business name.", 409);
}

export async function getBusiness(id: string): Promise<Business | null> {
  const [row] = await db()<Business[]>`select ${db().unsafe(COLS)} from businesses where id = ${id}`;
  return row ?? null;
}

export async function getBusinessBySlug(slug: string): Promise<Business | null> {
  const [row] = await db()<Business[]>`select ${db().unsafe(COLS)} from businesses where slug = ${slug.toLowerCase()}`;
  return row ?? null;
}

export async function getWallets(businessId: string): Promise<Wallet[]> {
  return db()<Wallet[]>`select network, token, address from wallets where business_id = ${businessId} order by network`;
}

/**
 * Create any missing wallets. Never throws: a failure is recorded on the
 * business so the dashboard can offer "Retry wallet setup".
 */
export async function setupWallets(business: Business): Promise<Business> {
  const sql = db();
  const have = new Set((await getWallets(business.id)).map((w) => w.network));
  try {
    for (const n of NETWORKS) {
      if (have.has(n.network)) continue;
      const address = await generateWallet(n.network, ownerAsCustomer(business));
      await sql`insert into wallets (business_id, network, token, address)
                values (${business.id}, ${n.network}, ${n.token}, ${address})
                on conflict do nothing`;
    }
    const [row] = await sql<Business[]>`update businesses set wallet_status = 'ready', wallet_error = null
                                         where id = ${business.id} returning ${sql.unsafe(COLS)}`;
    return row;
  } catch (err) {
    const message = err instanceof Error ? err.message : "wallet setup failed";
    const [row] = await sql<Business[]>`update businesses set wallet_status = 'failed', wallet_error = ${message}
                                         where id = ${business.id} returning ${sql.unsafe(COLS)}`;
    return row;
  }
}

/** Balance per token, from the ledger. */
export async function balances(businessId: string): Promise<Record<string, string>> {
  const rows = await db()<{ token: string; total: string }[]>`
    select token, coalesce(sum(amount), 0)::text as total from ledger where business_id = ${businessId} group by token`;
  const out: Record<string, string> = { usdt: "0", btc: "0" };
  for (const r of rows) out[r.token] = r.total;
  return out;
}

export async function recentLedger(businessId: string, limit = 20) {
  return db()<{ token: string; amount: string; kind: string; ref: string; created_at: Date }[]>`
    select token, amount::text, kind, ref, created_at from ledger
    where business_id = ${businessId} order by created_at desc, id desc limit ${limit}`;
}

/* --- passwords ------------------------------------------------------------------ */

const WRONG = "Wrong email or password.";

/**
 * Email + password sign-in. The answer is the same for an unknown email and a
 * wrong password, and five wrong tries lock the account for a few minutes.
 */
export async function signIn(emailInput: unknown, passwordInput: unknown): Promise<Business> {
  const sql = db();
  const email = String(emailInput ?? "").trim().toLowerCase();
  const password = String(passwordInput ?? "");
  const [row] = await sql<{ id: string; password_hash: string | null; locked: boolean }[]>`
    select id, password_hash, coalesce(locked_until > now(), false) as locked from businesses where email = ${email}`;
  if (row?.locked) throw new BizError(`Too many wrong passwords. Try again in ${LOCK_MINUTES} minutes.`, 429);
  const ok = await verifyPassword(password, row?.password_hash);
  if (!row || !ok) {
    if (row) {
      await sql`update businesses set
                  failed_logins = failed_logins + 1,
                  locked_until = case when failed_logins + 1 >= ${MAX_FAILED_LOGINS}
                                      then now() + make_interval(mins => ${LOCK_MINUTES}) else locked_until end
                where id = ${row.id}`;
    }
    throw new BizError(WRONG, 401);
  }
  const [business] = await sql<Business[]>`
    update businesses set failed_logins = 0, locked_until = null where id = ${row.id} returning ${sql.unsafe(COLS)}`;
  return business;
}

/** Check the signed-in owner's password again (before money moves). */
export async function checkPassword(businessId: string, password: unknown): Promise<boolean> {
  const [row] = await db()<{ password_hash: string | null }[]>`select password_hash from businesses where id = ${businessId}`;
  return verifyPassword(String(password ?? ""), row?.password_hash);
}

/** Set a new password (used by the owner, and by scripts/set-password.mjs for older accounts). */
export async function setPassword(businessId: string, password: string): Promise<void> {
  const problem = passwordProblem(password);
  if (problem) throw new BizError(problem);
  await db()`update businesses set password_hash = ${await hashPassword(password)}, failed_logins = 0, locked_until = null
             where id = ${businessId}`;
}

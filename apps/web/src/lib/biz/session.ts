/**
 * Business sign-in: a signed, httpOnly cookie holding the business id, set
 * after onboarding or an email + password sign-in.
 */
import { createHmac } from "node:crypto";

import { jwtVerify, SignJWT } from "jose";
import { cookies } from "next/headers";

export const SESSION_COOKIE = "rs_biz";
const MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

/**
 * The cookie-signing key: SESSION_SECRET when set; otherwise derived from
 * DATABASE_URL (itself a server-only secret), so a deploy works as soon as the
 * database is connected. Rotating either one signs everyone out.
 */
function secret(): Uint8Array {
  const value = process.env.SESSION_SECRET;
  if (value && value.length >= 32) return new TextEncoder().encode(value);
  const dbUrl = process.env.DATABASE_URL;
  if (dbUrl) return createHmac("sha256", dbUrl).update("roqqu-studio session v1").digest();
  if (process.env.NODE_ENV === "production") {
    throw new Error("Set SESSION_SECRET (32+ random characters) or DATABASE_URL in production");
  }
  return new TextEncoder().encode("dev-only-session-secret-change-me-0123456789");
}

export async function signSession(businessId: string): Promise<string> {
  return new SignJWT({})
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(businessId)
    .setIssuedAt()
    .setExpirationTime(`${MAX_AGE_S}s`)
    .sign(secret());
}

export async function verifySession(token: string | undefined): Promise<string | null> {
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: ["HS256"] });
    return typeof payload.sub === "string" ? payload.sub : null;
  } catch {
    return null;
  }
}

export async function setSessionCookie(businessId: string) {
  (await cookies()).set(SESSION_COOKIE, await signSession(businessId), {
    httpOnly: true,
    sameSite: "lax",
    secure: process.env.NODE_ENV === "production",
    path: "/",
    maxAge: MAX_AGE_S,
  });
}

export async function clearSessionCookie() {
  (await cookies()).delete(SESSION_COOKIE);
}

/** The signed-in business id, or null. */
export async function currentBusinessId(): Promise<string | null> {
  return verifySession((await cookies()).get(SESSION_COOKIE)?.value);
}


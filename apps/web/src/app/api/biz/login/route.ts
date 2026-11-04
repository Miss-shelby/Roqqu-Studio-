import { NextResponse } from "next/server";

import { signIn } from "@/lib/biz/business";
import { handle, readJson } from "@/lib/biz/route";
import { setSessionCookie } from "@/lib/biz/session";

/** Email + password sign-in. */
export async function POST(req: Request) {
  return handle(async () => {
    const body = await readJson(req);
    const business = await signIn(body.email, body.password);
    await setSessionCookie(business.id);
    return NextResponse.json({ business });
  });
}

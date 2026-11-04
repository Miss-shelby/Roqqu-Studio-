import { NextResponse } from "next/server";

import { handle, readJson, requireBusiness } from "@/lib/biz/route";
import { startSend } from "@/lib/biz/sends";

/** Step 1 of a send: every check, then a summary the owner confirms with their password. */
export async function POST(req: Request) {
  return handle(async () => {
    const business = await requireBusiness();
    const { send, fee } = await startSend(business.id, await readJson(req));
    return NextResponse.json({ send, fee }, { status: 201 });
  });
}

/**
 * Sending crypto out of a business balance. Two steps: start (every check,
 * then a summary to review) and confirm (the account password again ->
 * ledger debit -> RAS send). If RAS refuses, the debit is reversed at once.
 */
import { randomUUID } from "node:crypto";

import { BizError, balances, checkPassword } from "./business";
import { db } from "./db";
import { decimalGte } from "./money";
import { networkFee, NETWORKS, RasError, sendCoin, usdPrice, whatNetwork, type Network } from "./ras";
export const CONFIRM_MINUTES = 10;
export const MAX_ATTEMPTS = 5;
export const dailyCapUsd = () => Number(process.env.BIZ_DAILY_SEND_USD || 500);

export interface Send {
  id: string;
  business_id: string;
  network: Network;
  token: string;
  to_address: string;
  amount: string;
  amount_usd: string;
  status: string;
  refid: string | null;
  error: string | null;
  created_at: Date;
}

const AMOUNT_RE = /^\d+(\.\d{1,8})?$/;

export async function startSend(
  businessId: string,
  input: { network?: unknown; to?: unknown; amount?: unknown },
): Promise<{ send: Send; fee: string }> {
  const net = NETWORKS.find((n) => n.network === input.network);
  if (!net) throw new BizError("Pick a network.");
  const to = String(input.to ?? "").trim();
  const amount = String(input.amount ?? "").trim();
  if (!AMOUNT_RE.test(amount) || Number(amount) <= 0) throw new BizError("Enter an amount greater than 0.");
  if (!to) throw new BizError("Enter the destination address.");

  const networks = (await whatNetwork(to)) as string[];
  if (!networks.includes(net.network)) {
    throw new BizError(
      networks.length
        ? `That address is on ${networks.join(", ").toUpperCase()}, not ${net.network.toUpperCase()}.`
        : "That is not a valid address on any network Roqqu supports.",
    );
  }

  const fee = await networkFee(net.network);
  const balance = (await balances(businessId))[net.token] ?? "0";
  const needed = (Number(amount) + fee).toFixed(8);
  if (!decimalGte(balance, needed)) {
    throw new BizError(`Not enough ${net.token.toUpperCase()}: you have ${balance}, this send needs ${needed} including the ${fee} network fee.`);
  }

  const usd = (Number(amount) * (await usdPrice(net.token))).toFixed(2);
  const sql = db();
  const [{ today }] = await sql<{ today: string }[]>`
    select coalesce(sum(amount_usd), 0)::text as today from sends
    where business_id = ${businessId} and status in ('queued', 'sent') and created_at > now() - interval '1 day'`;
  if (Number(today) + Number(usd) > dailyCapUsd()) {
    throw new BizError(`This would pass your daily send limit of $${dailyCapUsd()} (already sent $${today} today).`);
  }

  const [send] = await sql<Send[]>`
    insert into sends (id, business_id, network, token, to_address, amount, amount_usd, code_expires)
    values (${randomUUID()}, ${businessId}, ${net.network}, ${net.token}, ${to}, ${amount}, ${usd},
            now() + make_interval(mins => ${CONFIRM_MINUTES}))
    returning id, business_id, network, token, to_address, amount::text, amount_usd::text, status, refid, error, created_at`;
  return { send, fee: String(fee) };
}

export async function confirmSend(businessId: string, sendId: string, password: string): Promise<Send> {
  const sql = db();
  const [row] = await sql<(Send & { expired: boolean; attempts: number })[]>`
    select *, amount::text as amount, code_expires < now() as expired from sends
    where id = ${sendId} and business_id = ${businessId}`;
  if (!row) throw new BizError("Send not found.", 404);
  if (row.status !== "awaiting_code") throw new BizError("This send was already confirmed or cancelled.", 409);
  if (row.expired) {
    await sql`update sends set status = 'expired' where id = ${sendId}`;
    throw new BizError("This send waited too long. Start it again.", 410);
  }
  if (row.attempts >= MAX_ATTEMPTS) throw new BizError("Too many wrong passwords. Start the send again.", 429);
  if (!(await checkPassword(businessId, password))) {
    await sql`update sends set attempts = attempts + 1 where id = ${sendId}`;
    throw new BizError(`Wrong password. ${MAX_ATTEMPTS - row.attempts - 1} tries left.`, 401);
  }

  // Debit first (re-checking the balance inside the transaction), then send.
  await sql.begin(async (tx) => {
    const [{ bal }] = await tx<{ bal: string }[]>`
      select coalesce(sum(amount), 0)::text as bal from ledger
      where business_id = ${businessId} and token = ${row.token}`;
    if (!decimalGte(bal, row.amount)) throw new BizError("Your balance changed and no longer covers this send.");
    await tx`insert into ledger (business_id, token, amount, kind, ref)
             values (${businessId}, ${row.token}, ${"-" + row.amount}, 'send', ${sendId})`;
    await tx`update sends set status = 'queued' where id = ${sendId}`;
  });

  try {
    const refid = await sendCoin({ token: row.token as "usdt" | "btc", network: row.network, to: row.to_address, amount: row.amount });
    const [done] = await sql<Send[]>`
      update sends set refid = ${refid} where id = ${sendId}
      returning id, business_id, network, token, to_address, amount::text, amount_usd::text, status, refid, error, created_at`;
    return done;
  } catch (err) {
    const message = err instanceof RasError ? err.message : "Roqqu did not accept the send";
    await sql.begin(async (tx) => {
      await tx`insert into ledger (business_id, token, amount, kind, ref)
               values (${businessId}, ${row.token}, ${row.amount}, 'send_reversal', ${sendId})
               on conflict do nothing`;
      await tx`update sends set status = 'failed', error = ${message} where id = ${sendId}`;
    });
    throw new BizError(`Roqqu refused the send: ${message}. Nothing left your balance.`, 502);
  }
}

export async function recentSends(businessId: string): Promise<Send[]> {
  return db()<Send[]>`
    select id, business_id, network, token, to_address, amount::text, amount_usd::text, status, refid, error, created_at
    from sends where business_id = ${businessId} and status <> 'awaiting_code'
    order by created_at desc limit 20`;
}

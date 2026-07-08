// patrol stats — v0.2 telemetry: wake-ups, coalescing ratio, cache economics,
// and attribution layer per seat. This is the evidence layer for the
// README's cost claims (standing seats cheaper; coalesced wake-ups).
import type { StatsRequest, StatsResponse } from "../../shared/types.ts";
import { brokerPost, usd, renderTable, BrokerError } from "./_client.ts";

// 1 decimal; "-" rather than a divide-by-zero when the denominator is 0.
function ratio(num: number, den: number): string {
  return den > 0 ? (num / den).toFixed(1) : "-";
}

export default async function stats(args: string[]): Promise<number> {
  const body: StatsRequest = {};
  let json = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") json = true;
    else if (a === "--since") body.since = args[++i];
    else if (a === "--until") body.until = args[++i];
  }

  let res: StatsResponse;
  try {
    res = await brokerPost<StatsResponse>("/stats", body);
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }

  if (json) {
    console.log(JSON.stringify(res));
    return 0;
  }

  if (res.seats.length === 0) {
    console.log("no seat activity in window.");
  } else {
    const headers = ["SEAT", "ROLE", "MODEL", "LIVE", "BOUND", "WAKES", "MSGS", "MSG/WAKE", "CACHE R/W", "SPEND"];
    const rows = res.seats.map((s) => [
      s.seat_id.slice(0, 8),
      s.role ?? "-",
      s.model ?? "-",
      s.live ? "yes" : "no",
      s.bound_via ?? "-",
      String(s.notifications),
      String(s.messages),
      ratio(s.messages, s.notifications),
      ratio(s.cache_read, s.cache_write),
      usd(s.cost_usd),
    ]);
    console.log(renderTable(headers, rows, new Set([5, 6, 7, 8, 9])));
  }

  const t = res.totals;
  console.log(
    `\ntotals: ${t.notifications} wakes, ${t.messages} messages, ${ratio(t.messages, t.notifications)} msg/wake, ${usd(t.cost_usd)} spend, ${usd(t.unattributed_usd)} unattributed`,
  );

  // The coalescing claim in one sentence: how many paid wake-ups were avoided
  // by batching messages into fewer notification deliveries.
  const saved = t.messages - t.notifications;
  if (saved > 0) {
    console.log(`coalescing saved ~${saved} wake-ups (${t.messages} messages arrived in ${t.notifications} notifications)`);
  }

  return 0;
}

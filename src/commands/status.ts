// patrol status — the fleet board. Flagship view: per-seat spend is the
// differentiator no competitor peer tool has (see research/r2).
import type { Seat, CostsResponse } from "../../shared/types.ts";
import { brokerPost, gitRoot, relTime, truncate, usd, renderTable, BrokerError } from "./_client.ts";

export default async function status(_args: string[]): Promise<number> {
  const cwd = process.cwd();

  // The board is the point of the command; the seat list is what it needs and is
  // the only hard dependency. A failure here is fatal.
  let seats: Seat[];
  try {
    seats = await brokerPost<Seat[]>("/list-seats", { scope: "machine", cwd, git_root: gitRoot(cwd) });
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }

  // Spend is best-effort: /costs scans session jsonl and can be slow or wedged.
  // A failed/slow cost call degrades to "spend unavailable" — it must never hide
  // or block the board (the old Promise.all did exactly that).
  let costs: CostsResponse | null = null;
  try {
    costs = await brokerPost<CostsResponse>("/costs", {});
  } catch {
    costs = null;
  }

  const spendBySeat = new Map<string, number>();
  let unattributed = 0;
  if (costs) {
    for (const row of costs.rows) {
      if (row.seat_id == null) unattributed += row.cost_usd;
      else spendBySeat.set(row.seat_id, (spendBySeat.get(row.seat_id) ?? 0) + row.cost_usd);
    }
  }

  if (seats.length === 0) {
    console.log("no seats registered.");
  } else {
    const headers = ["SEAT", "ROLE", "MODEL", "PROFILE", "TTY", "SEEN", "SPEND", "SUMMARY"];
    const rows = seats.map((s) => [
      s.id.slice(0, 8),
      s.role ?? "-",
      s.model ?? "-",
      s.profile ?? "-",
      s.tty ?? "-",
      relTime(s.last_seen),
      costs ? usd(spendBySeat.get(s.id) ?? 0) : "—",
      truncate(s.summary, 40),
    ]);
    console.log(renderTable(headers, rows, new Set([6])));
  }

  if (!costs) {
    console.log("\nspend unavailable — broker /costs did not respond");
  } else {
    if (unattributed > 0) console.log(`\nunattributed: ${usd(unattributed)}`);
    console.log(`total spend: ${usd(costs.total_usd)}`);
  }
  return 0;
}

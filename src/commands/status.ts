// patrol status — the fleet board. Flagship view: per-seat spend is the
// differentiator no competitor peer tool has (see research/r2).
import type { Seat, CostsResponse } from "../../shared/types.ts";
import { brokerPost, gitRoot, relTime, truncate, usd, renderTable, BrokerError } from "./_client.ts";

export default async function status(_args: string[]): Promise<number> {
  try {
    const cwd = process.cwd();
    const [seats, costs] = await Promise.all([
      brokerPost<Seat[]>("/list-seats", { scope: "machine", cwd, git_root: gitRoot(cwd) }),
      brokerPost<CostsResponse>("/costs", {}),
    ]);

    const spendBySeat = new Map<string, number>();
    let unattributed = 0;
    for (const row of costs.rows) {
      if (row.seat_id == null) unattributed += row.cost_usd;
      else spendBySeat.set(row.seat_id, (spendBySeat.get(row.seat_id) ?? 0) + row.cost_usd);
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
        usd(spendBySeat.get(s.id) ?? 0),
        truncate(s.summary, 40),
      ]);
      console.log(renderTable(headers, rows, new Set([6])));
    }

    if (unattributed > 0) console.log(`\nunattributed: ${usd(unattributed)}`);
    console.log(`total spend: ${usd(costs.total_usd)}`);
    return 0;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}

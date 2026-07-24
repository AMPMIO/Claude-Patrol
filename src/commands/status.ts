// patrol status — the fleet board. Flagship view: per-seat spend is the
// differentiator no competitor peer tool has (see research/r2).
import type { Seat, CostsResponse, Worktree } from "../../shared/types.ts";
import { brokerPost, gitRoot, relTime, truncate, usd, renderTable, seatLabel, BrokerError } from "./_client.ts";

// v0.2.6: /list-seats now carries the seat's spend cap (a REAL column added to the
// seats table). The frozen Seat contract predates it, so read it off a widened view
// rather than editing shared/types.ts.
type SeatWithBudget = Seat & { budget_usd?: number | null };

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

  // v0.2.6 active task branch per seat. Best-effort like /costs: a failed call just
  // renders "-" in the BRANCH column, it must never block the board.
  const branchBySeat = new Map<string, string>();
  try {
    for (const w of await brokerPost<Worktree[]>("/worktree-list", {})) {
      const prev = branchBySeat.get(w.seat_id);
      branchBySeat.set(w.seat_id, prev ? `${prev},${w.branch}` : w.branch);
    }
  } catch {
    /* worktree tracking unavailable — leave the column blank */
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
    // Handle is the primary identifier; the hex id stays as a secondary column
    // (disambiguator + fallback). BRANCH (v0.2.6) is the seat's active task worktree.
    // SPEND is column 8, BUDGET column 9 — both right-aligned. An OVER marker rides in
    // the SPEND cell (v0.2.6 observe-only cap; the broker has already pinged the
    // recipient, this just surfaces it on the board).
    const headers = ["SEAT", "ID", "ROLE", "MODEL", "PROFILE", "TTY", "BRANCH", "SEEN", "SPEND", "BUDGET", "SUMMARY"];
    const rows = seats.map((s) => {
      const budget = (s as SeatWithBudget).budget_usd ?? null;
      const spend = spendBySeat.get(s.id) ?? 0;
      const over = costs != null && budget != null && spend >= budget;
      return [
        seatLabel(s),
        s.id.slice(0, 8),
        s.role ?? "-",
        s.model ?? "-",
        s.profile ?? "-",
        s.tty ?? "-",
        truncate(branchBySeat.get(s.id) ?? "-", 24),
        relTime(s.last_seen),
        costs ? `${usd(spend)}${over ? " OVER" : ""}` : "—",
        budget != null ? usd(budget) : "—",
        truncate(s.summary, 40),
      ];
    });
    console.log(renderTable(headers, rows, new Set([8, 9])));
  }

  if (!costs) {
    console.log("\nspend unavailable — broker /costs did not respond");
  } else {
    if (unattributed > 0) console.log(`\nunattributed: ${usd(unattributed)}`);
    // Three wallets, NEVER summed into one number — they bill different accounts.
    // subscription + agent-sdk come from the ledger's by_source; codex "external"
    // has no ledger row (no transcript), so it renders "$—" (unknown, not a made-up 0).
    const by = costs.by_source ?? {};
    const sub = by.subscription ?? 0;
    const sdk = by["agent-sdk"] ?? 0;
    console.log(
      `\nby wallet:  subscription ${usd(sub)}   agent-sdk ${usd(sdk)}   external $—`
    );
    console.log(`total spend: ${usd(costs.total_usd)}  (subscription + agent-sdk; external billed separately)`);
  }
  return 0;
}

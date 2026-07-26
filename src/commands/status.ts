// patrol status — the fleet board. Flagship view: per-seat spend is the
// differentiator no competitor peer tool has (see research/r2).
import type { Seat, CostsResponse, Worktree } from "../../shared/types.ts";
import { brokerPost, gitRoot, relTime, truncate, usd, renderTable, seatLabel, detectFleet, BrokerError } from "./_client.ts";

// v0.2.6: /list-seats now carries the seat's spend cap (a REAL column added to the
// seats table). The frozen Seat contract predates it, so read it off a widened view
// rather than editing shared/types.ts.
type SeatWithBudget = Seat & { budget_usd?: number | null };

// v0.2.9: /worktree-list joins the checkpoint lease in (additive, same reasoning as above).
// A held lease means the seat's guard hook is DENYING its writes right now — without this
// column, a checkpoint that died before releasing looks like a seat that inexplicably
// stopped working until the TTL burns down.
type WorktreeWithLease = Worktree & { lease_expires_at?: string | null };

// Token counts in the tax line are read at a glance, not audited — "412k" beats
// "412,318" for a figure whose input is a heuristic. Exact tokens stay in /costs.
function ktok(n: number): string {
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}k`;
  return String(n);
}

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
  const leasedUntil = new Map<string, string>();
  try {
    for (const w of await brokerPost<WorktreeWithLease[]>("/worktree-list", {})) {
      const prev = branchBySeat.get(w.seat_id);
      branchBySeat.set(w.seat_id, prev ? `${prev},${w.branch}` : w.branch);
      // Only a lease that has not expired is worth showing: past expires_at the guard hook
      // fails open, so the seat is writing again and a LEASED marker would be a lie.
      if (w.lease_expires_at && Date.parse(w.lease_expires_at) > Date.now()) {
        leasedUntil.set(w.seat_id, w.lease_expires_at);
      }
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
    // SPEND is column 9, BUDGET column 10 — both right-aligned (v0.3 added FLEET). An OVER marker rides in
    // the SPEND cell (v0.2.6 observe-only cap; the broker has already pinged the
    // recipient, this just surfaces it on the board).
    // v0.3 FLEET column: the board is machine-wide, so on a two-fleet machine the
    // rows are otherwise indistinguishable. The caller's own fleet carries "*".
    const mine = detectFleet();
    const headers = ["SEAT", "FLEET", "ID", "ROLE", "MODEL", "PROFILE", "TTY", "BRANCH", "SEEN", "SPEND", "BUDGET", "SUMMARY"];
    const rows = seats.map((s) => {
      const budget = (s as SeatWithBudget).budget_usd ?? null;
      const spend = spendBySeat.get(s.id) ?? 0;
      const over = costs != null && budget != null && spend >= budget;
      return [
        seatLabel(s),
        s.fleet ? `${s.fleet}${s.fleet === mine ? " *" : ""}` : "-",
        s.id.slice(0, 8),
        s.role ?? "-",
        s.model ?? "-",
        s.profile ?? "-",
        s.tty ?? "-",
        // The LEASED marker rides in the BRANCH cell (like OVER rides in SPEND) rather than
        // costing a column that is blank for every seat almost all of the time.
        `${truncate(branchBySeat.get(s.id) ?? "-", 24)}${leasedUntil.has(s.id) ? " LEASED" : ""}`,
        relTime(s.last_seen),
        costs ? `${usd(spend)}${over ? " OVER" : ""}` : "—",
        budget != null ? usd(budget) : "—",
        truncate(s.summary, 40),
      ];
    });
    console.log(renderTable(headers, rows, new Set([9, 10])));
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
    // Fleet-level, not a seat column: the tax is a property of how the fleet waits, and
    // a per-seat number would invite comparing seats on a heuristic. Silent at zero —
    // a fleet with nothing to report should not be told about a metric it doesn't have.
    // "took the write path" is deliberate: this is a heuristic over transcripts, which
    // record how tokens were billed but never why, so a legitimately new prefix (model
    // switch, changed tool set, a compaction) counts here too. Not "money you lost".
    const tax = costs.cache_tax;
    if (tax && tax.rebuilds > 0) {
      console.log(
        `cache tax:   ${tax.rebuilds} rebuild${tax.rebuilds === 1 ? "" : "s"} · ${ktok(tax.rebuild_tokens)} tokens · ${usd(tax.tax_usd)} (idle cache re-encodes; heuristic)`
      );
    }
  }
  return 0;
}

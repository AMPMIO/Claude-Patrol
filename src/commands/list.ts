// patrol list [machine|directory|repo] — compact seat list (default machine).
import type { Seat, ListSeatsRequest } from "../../shared/types.ts";
import { brokerPost, gitRoot, relTime, truncate, renderTable, seatLabel, detectFleet, BrokerError } from "./_client.ts";

const SCOPES = ["machine", "directory", "repo"] as const;

export default async function list(args: string[]): Promise<number> {
  const arg = args[0];
  const scope: ListSeatsRequest["scope"] =
    arg && (SCOPES as readonly string[]).includes(arg) ? (arg as ListSeatsRequest["scope"]) : "machine";
  try {
    const cwd = process.cwd();
    const seats = await brokerPost<Seat[]>("/list-seats", { scope, cwd, git_root: gitRoot(cwd) });
    if (seats.length === 0) {
      console.log("no seats.");
      return 0;
    }
    // v0.3: list stays MACHINE-wide on purpose — seeing every fleet is the point
    // of the command on a multi-project machine — so the fleet gets a column, with
    // the caller's own marked "*" so "which of these are mine" is one glance.
    // A seat with no fleet is pre-0.3 or hand-launched, not a fleet named "-".
    const mine = detectFleet();
    const rows = seats.map((s) => [
      seatLabel(s),
      s.fleet ? `${s.fleet}${s.fleet === mine ? " *" : ""}` : "-",
      s.id.slice(0, 8),
      s.role ?? "-",
      s.model ?? "-",
      relTime(s.last_seen),
      truncate(s.summary, 50),
    ]);
    console.log(renderTable(["SEAT", "FLEET", "ID", "ROLE", "MODEL", "SEEN", "SUMMARY"], rows));
    return 0;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}

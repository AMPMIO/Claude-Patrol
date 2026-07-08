// patrol list [machine|directory|repo] — compact seat list (default machine).
import type { Seat, ListSeatsRequest } from "../../shared/types.ts";
import { brokerPost, gitRoot, relTime, truncate, renderTable, BrokerError } from "./_client.ts";

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
    const rows = seats.map((s) => [
      s.id.slice(0, 8),
      s.role ?? "-",
      s.model ?? "-",
      relTime(s.last_seen),
      truncate(s.summary, 50),
    ]);
    console.log(renderTable(["SEAT", "ROLE", "MODEL", "SEEN", "SUMMARY"], rows));
    return 0;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}

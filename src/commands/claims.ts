// patrol claims [git-root] — list current advisory path claims (read-only). With a
// git-root, scopes to claims on paths under that repo.
import { brokerPost, BrokerError, renderTable, relTime } from "./_client.ts";
import type { PathClaim } from "../../shared/types.ts";

export default async function claims(args: string[]): Promise<number> {
  const [gitRoot] = args;
  try {
    const rows = await brokerPost<PathClaim[]>("/list-claims", gitRoot ? { git_root: gitRoot } : {});
    if (rows.length === 0) {
      console.log("no path claims");
      return 0;
    }
    console.log(
      renderTable(
        ["PATH", "OWNER", "ROLE", "CLAIMED"],
        rows.map((r) => [r.path, r.owner_id, r.owner_role ?? "-", relTime(r.claimed_at)])
      )
    );
    return 0;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}

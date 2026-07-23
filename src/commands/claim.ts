// patrol claim <seat-id> <path>... — advisory file claims over /claim-path. Takes
// an explicit owner seat id (admin/test surface). A denied path prints its current
// holder so the caller can coordinate; exit is nonzero if anything was denied.
import { brokerPost, BrokerError } from "./_client.ts";
import type { ClaimPathResponse } from "../../shared/types.ts";

export default async function claim(args: string[]): Promise<number> {
  const [id, ...paths] = args;
  if (!id || paths.length === 0) {
    console.error("usage: patrol claim <seat-id> <path>...");
    return 1;
  }
  try {
    const res = await brokerPost<ClaimPathResponse>("/claim-path", { id, paths });
    for (const g of res.granted) console.log(`granted  ${g}`);
    for (const d of res.denied) {
      console.log(`denied   ${d.path} (held by ${d.owner_id}${d.owner_role ? ` / ${d.owner_role}` : ""})`);
    }
    return res.denied.length > 0 ? 1 : 0;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}

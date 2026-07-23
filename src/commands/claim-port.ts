// patrol claim-port <seat-id> [count] — admin/test surface over /claim-port. Takes
// an EXPLICIT seat id (no "myself" resolution yet — that's WP-P's seat-facing path).
import { brokerPost, BrokerError } from "./_client.ts";
import type { ClaimPortResponse } from "../../shared/types.ts";

export default async function claimPort(args: string[]): Promise<number> {
  const [id, countStr] = args;
  if (!id) {
    console.error("usage: patrol claim-port <seat-id> [count]");
    return 1;
  }
  const count = countStr ? Number(countStr) : 1;
  if (countStr && (!Number.isInteger(count) || count < 1)) {
    console.error("count must be a positive integer");
    return 1;
  }
  try {
    const res = await brokerPost<ClaimPortResponse>("/claim-port", { id, count });
    console.log(res.ports.join(" "));
    return 0;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}

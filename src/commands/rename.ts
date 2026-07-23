// patrol rename <handle-or-id> <newname> — ask the broker to reassign a seat's
// readable handle. The broker slugifies + dedupes the name, so the ASSIGNED handle
// (printed) may differ from the requested one (a "-proj"/"-hex" suffix on collision).
import { brokerPost, BrokerError, resolveSeatTarget } from "./_client.ts";
import type { RenameRequest, RenameResponse } from "../../shared/types.ts";

export default async function rename(args: string[]): Promise<number> {
  const [target, ...rest] = args;
  const name = rest.join(" ");
  if (!target || name.length === 0) {
    console.error("usage: patrol rename <handle-or-id> <newname>");
    return 2;
  }
  try {
    const id = await resolveSeatTarget(target);
    const body: RenameRequest = { id, name };
    const res = await brokerPost<RenameResponse | { ok: false; error?: string }>("/rename", body);
    if (!res.ok) {
      console.error((res as { error?: string }).error ?? `rename of ${target} failed`);
      return 1;
    }
    const assigned = (res as RenameResponse).handle;
    console.log(assigned === name ? `renamed to ${assigned}` : `renamed to ${assigned} (adjusted from "${name}")`);
    return 0;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}

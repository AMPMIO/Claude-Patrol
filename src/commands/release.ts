// patrol release <seat-id> [path...] — release a seat's OWN path claims (the broker
// scopes the delete by owner_id). With paths, releases just those; without, all the
// seat holds. Idempotent — releasing something you don't hold is a no-op.
import { brokerPost, BrokerError } from "./_client.ts";

export default async function release(args: string[]): Promise<number> {
  const [id, ...paths] = args;
  if (!id) {
    console.error("usage: patrol release <seat-id> [path...]");
    return 1;
  }
  try {
    await brokerPost<{ ok: true }>("/release-claims", paths.length > 0 ? { id, paths } : { id });
    console.log(paths.length > 0 ? `released ${paths.length} claim(s) for ${id}` : `released all claims for ${id}`);
    return 0;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}

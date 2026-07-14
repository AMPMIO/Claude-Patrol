// patrol send <seat-id> <message> — thin broker call, from_id="cli".
//
// There is deliberately no `--as <seat-id>` flag: it would be a one-flag
// provenance-forgery primitive (anyone could speak as any seat), which contradicts
// the seat trust model — the [from ...] header is the ONLY trusted identity. The
// codex adapter doesn't need it either; it replies under its own real seat id.
// Returns in v0.3 with per-seat capability tokens, where ownership is proven.
import type { SendMessageRequest } from "../../shared/types.ts";
import { brokerPost, BrokerError } from "./_client.ts";

export default async function send(args: string[]): Promise<number> {
  const [to, ...rest] = args;
  const text = rest.join(" ");
  if (!to || text.length === 0) {
    console.error("usage: patrol send <seat-id> <message>");
    return 2;
  }
  try {
    const body: SendMessageRequest = { from_id: "cli", to_id: to, text };
    // The broker replies HTTP 200 with {ok:false, error} for app-level failures
    // (e.g. no such seat) — brokerPost only throws on transport/HTTP errors, so
    // a bare await here would report success on a message that was never queued.
    const res = await brokerPost<{ ok: boolean; error?: string }>("/send-message", body);
    if (!res.ok) {
      console.error(res.error ?? `send to ${to} failed`);
      return 1;
    }
    console.log(`sent to ${to}`);
    return 0;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}

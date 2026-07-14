// patrol send [--as <seat-id>] <seat-id> <message> — thin broker call.
import type { SendMessageRequest } from "../../shared/types.ts";
import { brokerPost, BrokerError } from "./_client.ts";

export default async function send(args: string[]): Promise<number> {
  let from: SendMessageRequest["from_id"] = "cli";
  if (args[0] === "--as") {
    if (!args[1]) {
      console.error("usage: patrol send [--as <seat-id>] <seat-id> <message>");
      return 2;
    }
    from = args[1]!;
    args = args.slice(2);
  }
  const [to, ...rest] = args;
  const text = rest.join(" ");
  if (!to || text.length === 0) {
    console.error("usage: patrol send [--as <seat-id>] <seat-id> <message>");
    return 2;
  }
  try {
    const body: SendMessageRequest = { from_id: from, to_id: to, text };
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

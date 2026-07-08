// patrol send <seat-id> <message> — thin broker call, from_id="cli".
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
    await brokerPost<unknown>("/send-message", body);
    console.log(`sent to ${to}`);
    return 0;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}

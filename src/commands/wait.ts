// patrol wait <handle-or-id> --until <state[,state]> [--timeout <seconds>]
// Blocks until the target seat reaches one of the given states, or the timeout
// elapses. Resolves the target via the shared handle/id resolver.
import { brokerPost, BrokerError, resolveSeatTarget } from "./_client.ts";
import type { WaitForRequest, WaitForResponse, SeatState } from "../../shared/types.ts";

const DEFAULT_TIMEOUT_S = 300;

export default async function wait(args: string[]): Promise<number> {
  let target: string | undefined;
  let untilRaw: string | undefined;
  let timeoutS = DEFAULT_TIMEOUT_S;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === "--until") untilRaw = args[++i];
    else if (a === "--timeout") timeoutS = Number(args[++i]);
    else if (!a.startsWith("--") && target === undefined) target = a;
  }
  if (!target || !untilRaw) {
    console.error("usage: patrol wait <handle-or-id> --until <state[,state]> [--timeout <seconds>]");
    return 2;
  }
  const until = untilRaw.split(",").map((s) => s.trim()).filter(Boolean) as SeatState[];
  if (until.length === 0) {
    console.error("--until needs at least one state (idle|working|blocked|done)");
    return 2;
  }
  if (!Number.isFinite(timeoutS) || timeoutS <= 0) {
    console.error("--timeout must be a positive number of seconds");
    return 2;
  }
  try {
    const targetId = await resolveSeatTarget(target);
    const timeoutMs = Math.round(timeoutS * 1000);
    const body: WaitForRequest = { id: "cli", target: targetId, until, timeout_ms: timeoutMs };
    // Let the request run for the FULL wait plus a buffer — this is a long-poll, not a
    // wedged broker, so the default 3s CLI abort would cut a legitimate wait short.
    const res = await brokerPost<WaitForResponse>("/wait-for", body, timeoutMs + 5000);
    if (res.reached) {
      console.log(`${target} reached state: ${res.state}`);
      return 0;
    }
    console.error(`timed out after ${timeoutS}s (last state: ${res.state})`);
    return 1;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}

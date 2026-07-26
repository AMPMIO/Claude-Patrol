// patrol send <seat-id> <message> — thin broker call, from_id="cli".
//
// There is deliberately no `--as <seat-id>` flag: it would be a one-flag
// provenance-forgery primitive (anyone could speak as any seat), which contradicts
// the seat trust model — the [from ...] header is the ONLY trusted identity. The
// codex adapter doesn't need it either; it replies under its own real seat id.
// Returns in v0.3 with per-seat capability tokens, where ownership is proven.
import { existsSync, statSync } from "node:fs";
import { resolve } from "node:path";
import type { SendMessageRequest } from "../../shared/types.ts";
import { brokerPost, BrokerError, resolveSeatTarget } from "./_client.ts";

// `--brief <path>` hands over a POINTER instead of the brief's bytes. A pasted
// brief enters the seat's context once and is then re-billed on every later turn of
// that session, which for a multi-KB task brief is the largest avoidable line in a
// fleet's own operating cost. Seats share this filesystem, so the cheap fix is the
// obvious one: hand over the path and let the seat read what it needs. It also
// sidesteps the broker's message size cap for long briefs.
//
// What this deliberately does NOT do is prove the seat read it. A path leaves no
// trace — no receipt, no coverage, no way to tell a seat that skipped its brief from
// one that absorbed it. That gap is real (it cost rework during the 0.2.x waves) and
// closing it needs a reference layer that records reads; it is on the roadmap, not
// solved here. Until then: pointer for the bytes, review for the assurance.
export function briefMessage(path: string): string {
  return [
    "TASK BRIEF — read this file first, in full, before doing anything:",
    `  ${path}`,
    "",
    "It is the complete brief (context, task, done-criteria, constraints, escalation).",
    "It was handed over as a path rather than pasted so it does not sit in your context",
    "being re-billed every turn — read it once, then re-read the parts you need.",
  ].join("\n");
}

export default async function send(args: string[]): Promise<number> {
  const briefAt = args.indexOf("--brief");
  let to: string | undefined;
  let text: string;

  if (briefAt !== -1) {
    const raw = args[briefAt + 1];
    to = args.filter((_, i) => i !== briefAt && i !== briefAt + 1)[0];
    if (!raw || !to) {
      console.error("usage: patrol send <handle-or-id> --brief <path-to-brief-file>");
      return 2;
    }
    // Verify BEFORE queueing. A pointer to a missing file is worse than a pasted
    // brief: the seat gets a task it cannot read, and nothing surfaces until it
    // tries. Fail here, while a human is still watching.
    const path = resolve(raw);
    if (!existsSync(path) || !statSync(path).isFile()) {
      console.error(`patrol send: brief not found (or not a file): ${path}`);
      return 1;
    }
    text = briefMessage(path);
  } else {
    const [target, ...rest] = args;
    to = target;
    text = rest.join(" ");
  }

  if (!to || text.length === 0) {
    console.error("usage: patrol send <handle-or-id> <message>\n       patrol send <handle-or-id> --brief <path>");
    return 2;
  }
  try {
    // Accept a readable handle (or an id / unique id-prefix) and resolve it to the
    // full seat id the broker keys on. Ambiguous/unknown targets error here, before
    // anything is queued, so a message never lands on the wrong seat.
    const toId = await resolveSeatTarget(to);
    const body: SendMessageRequest = { from_id: "cli", to_id: toId, text };
    // The broker replies HTTP 200 with {ok:false, error} for app-level failures
    // (e.g. no such seat) — brokerPost only throws on transport/HTTP errors, so
    // a bare await here would report success on a message that was never queued.
    const res = await brokerPost<{ ok: boolean; error?: string }>("/send-message", body);
    if (!res.ok) {
      console.error(res.error ?? `send to ${to} failed`);
      return 1;
    }
    console.log(briefAt !== -1 ? `sent brief pointer to ${to}` : `sent to ${to}`);
    return 0;
  } catch (e) {
    console.error(e instanceof BrokerError ? e.message : String(e));
    return 1;
  }
}

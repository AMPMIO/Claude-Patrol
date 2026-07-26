// patrol recall <seat> — what did this seat do before? Prints pointers to the seat's
// prior sessions (ids, time bounds, transcript paths) and, when `ctx` is installed,
// how to inspect them. Never prints transcript content: see src/ctx-history.ts.
//
// Read-only and broker-free ON PURPOSE. The history lives in seat_runs, which survives
// the seat, the broker restart, and `patrol down` — so recall answers even when there
// is no live fleet to ask.
import { ctxAvailable, priorSessions, recallBrief } from "../ctx-history.ts";

export default async function recall(args: string[]): Promise<number> {
  const [seat] = args;
  if (!seat) {
    console.error("usage: patrol recall <seat>");
    return 2;
  }

  const sessions = priorSessions(seat);
  if (sessions.length === 0) {
    // Nonzero: a script asking "does this seat have history" gets an answer it can
    // branch on, and the human gets the reason rather than a blank success.
    console.error(recallBrief(seat, sessions, ctxAvailable()));
    return 1;
  }

  console.log(recallBrief(seat, sessions, ctxAvailable()));
  return 0;
}

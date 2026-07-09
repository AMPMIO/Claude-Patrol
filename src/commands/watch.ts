// patrol watch — live fleet-overview TUI (ink). The heavy lifting (and JSX)
// lives in src/tui/watch-app.tsx; this wrapper keeps the house command shape
// ((args) => Promise<number>) and handles --help without entering the TUI.
export default async function watch(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`patrol watch — live fleet overview across all projects

A full-screen TUI: fleet board (seats, roles, models, live, spend), a running
log of inter-seat messages, and an interactive send bar.

Keys:
  Tab           cycle the send target through live seats
  ↑ ↓ PgUp PgDn scroll the message log (auto-follows newest unless scrolled up)
  Enter         send the typed message to the current target
  q / Ctrl-C    quit`);
    return 0;
  }
  const { runWatch } = await import("../tui/watch-app.tsx");
  await runWatch();
  return 0;
}

// patrol dash — open the command-center dashboard in the default browser.
// The broker serves the page at GET /dashboard (localhost, no token); this just
// resolves the URL from the same port the rest of the CLI uses and opens it.
import { brokerBase, brokerHealthy } from "./_client.ts";

export default async function dash(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`patrol dash — open the live command-center dashboard in your browser

The broker serves it at ${brokerBase()}/dashboard (localhost only). It polls the
broker for the question inbox, fleet board, spend, and message log.`);
    return 0;
  }

  const url = `${brokerBase()}/dashboard`;

  if (!(await brokerHealthy())) {
    console.error("broker not responding — run `patrol up` first");
    return 1;
  }

  console.log(url);

  // macOS `open`, Linux `xdg-open`. If neither exists (headless/CI), the URL is
  // already printed — a missing opener isn't a failure, the user can click it.
  const opener = process.platform === "darwin" ? "open" : "xdg-open";
  if (!Bun.which(opener)) {
    console.error(`no \`${opener}\` on PATH — open the URL above manually`);
    return 0;
  }
  try {
    Bun.spawn([opener, url], { stdout: "ignore", stderr: "ignore" });
  } catch {
    console.error(`could not launch \`${opener}\` — open the URL above manually`);
  }
  return 0;
}

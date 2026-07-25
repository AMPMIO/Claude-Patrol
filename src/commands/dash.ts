// patrol dash — open the command-center dashboard in the default browser.
// The broker serves the page at GET /dashboard, gated by a short-lived scoped nonce
// (v0.2.7): this mints one via POST /dash-token (full-secret authed) and opens the page
// at /dashboard?t=<nonce>. The page then authenticates its polls with the nonce, which
// the broker limits to the read set + /answer — a leaked page URL can't drive the fleet.
import { brokerBase, brokerHealthy, brokerPost } from "./_client.ts";

export default async function dash(args: string[]): Promise<number> {
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`patrol dash — open the live command-center dashboard in your browser

The broker serves it at ${brokerBase()}/dashboard, gated by a short-lived scoped token
this command mints for you. It polls the broker for the question inbox, fleet board,
spend, and message log (read-only + answering questions).`);
    return 0;
  }

  if (!(await brokerHealthy())) {
    console.error("broker not responding — run `patrol up` first");
    return 1;
  }

  // Mint a scoped dashboard nonce with the real secret. brokerPost reads the secret file
  // and sends it in x-patrol-token; a missing secret / unreachable broker throws.
  let token: string;
  try {
    token = (await brokerPost<{ token: string }>("/dash-token", {})).token;
  } catch (e) {
    console.error(`could not mint a dashboard token: ${e instanceof Error ? e.message : String(e)}`);
    return 1;
  }

  const url = `${brokerBase()}/dashboard?t=${encodeURIComponent(token)}`;
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

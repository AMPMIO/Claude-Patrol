// `patrol watch` — the live fleet-overview TUI. Header strip, fleet board,
// message log with auto-follow, and an interactive send bar. Fetching goes
// through brokerPost (src/commands/_client.ts); all transforms live in data.ts.
import { useState, useEffect, useRef, useMemo } from "react";
import { render, Box, Text, useInput, useApp, useStdout, useStdin } from "ink";
import type { Seat, SeatStats, SeatId, LogResponse, StatsResponse } from "../../shared/types.ts";
import { brokerPost, BrokerError, gitRoot, pidAlive, usd, truncate } from "../commands/_client.ts";
import {
  type LogState,
  emptyLog,
  mergeLog,
  indexStats,
  liveTargets,
  resolveTarget,
  cycleTarget,
  shortId,
  roleTag,
  shortenCwd,
  hhmmss,
  headerTotals,
} from "./data.ts";
import { Panel } from "./components/Panel.tsx";
import { Table, type Cell, type Column } from "./components/Table.tsx";
import { TextInput } from "./components/TextInput.tsx";
import { KeyHint } from "./components/KeyHint.tsx";
import { homedir } from "node:os";

const HOME = homedir();

// ---- hooks ------------------------------------------------------------------

function useTermSize(): { cols: number; rows: number } {
  const { stdout } = useStdout();
  const [size, setSize] = useState({ cols: stdout?.columns ?? 80, rows: stdout?.rows ?? 24 });
  useEffect(() => {
    if (!stdout) return;
    const on = () => setSize({ cols: stdout.columns ?? 80, rows: stdout.rows ?? 24 });
    stdout.on("resize", on);
    return () => void stdout.off("resize", on);
  }, [stdout]);
  return size;
}

// Interval poller with a wedge guard: a slow/wedged broker must not let ticks
// pile up (same pattern as seat-server's pollAndPushMessages). The latest `fn`
// is read through a ref so each tick sees fresh state without re-arming the
// timer.
function usePoll(fn: () => Promise<void>, intervalMs: number): void {
  const inFlight = useRef(false);
  const fnRef = useRef(fn);
  fnRef.current = fn;
  useEffect(() => {
    let stopped = false;
    const tick = async () => {
      if (inFlight.current) return;
      inFlight.current = true;
      try {
        await fnRef.current();
      } finally {
        inFlight.current = false;
      }
    };
    void tick();
    const t = setInterval(() => {
      if (!stopped) void tick();
    }, intervalMs);
    return () => {
      stopped = true;
      clearInterval(t);
    };
  }, [intervalMs]);
}

// ---- app --------------------------------------------------------------------

function WatchApp() {
  const { exit } = useApp();
  const { isRawModeSupported } = useStdin();
  const { cols, rows } = useTermSize();

  const [seats, setSeats] = useState<Seat[]>([]);
  const [statsBySeat, setStatsBySeat] = useState<Map<SeatId, SeatStats>>(new Map());
  const [totals, setTotals] = useState<StatsResponse["totals"] | null>(null);
  const [log, setLog] = useState<LogState>(emptyLog());
  const [targetId, setTargetId] = useState<SeatId | null>(null);
  const [brokerUp, setBrokerUp] = useState(true);
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string | null>(null);

  // Log scroll: `stick` follows the newest message; scrolling up releases it and
  // pins `topIndex`.
  const [stick, setStick] = useState(true);
  const [topIndex, setTopIndex] = useState(0);

  const live = useMemo(() => liveTargets(seats, pidAlive), [seats]);
  const liveKey = live.join(",");

  // Keep the send target pointed at a live seat (dead target auto-advances).
  useEffect(() => {
    setTargetId((cur) => resolveTarget(cur, live));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveKey]);

  // Polling: /log 1s, /list-seats 2s, /stats 5s. brokerUp reflects the core
  // /list-seats reachability only — /log and /stats can be absent (parallel
  // package) without flapping the health banner.
  usePoll(async () => {
    try {
      const res = await brokerPost<LogResponse>("/log", {
        after_id: log.cursor || undefined,
        limit: 200,
      });
      setLog((prev) => mergeLog(prev, res.messages, res.latest_id));
    } catch {
      /* soft: /log may not exist yet */
    }
  }, 1000);

  usePoll(async () => {
    try {
      const s = await brokerPost<Seat[]>("/list-seats", {
        scope: "machine",
        cwd: process.cwd(),
        git_root: gitRoot(),
      });
      setBrokerUp(true);
      setSeats(s);
    } catch {
      setBrokerUp(false);
    }
  }, 2000);

  usePoll(async () => {
    try {
      const st = await brokerPost<StatsResponse>("/stats", {});
      setStatsBySeat(indexStats(st.seats));
      setTotals(st.totals);
    } catch {
      /* soft: /stats is telemetry, not liveness */
    }
  }, 5000);

  // ---- layout budget ----
  const boardRows = seats.length === 0 ? 1 : seats.length;
  const chrome =
    1 /* header */ +
    boardRows +
    3 /* board title + top/bottom border */ +
    2 /* log top/bottom border */ +
    1 /* input */ +
    1 /* footer */ +
    (sendError ? 1 : 0) +
    (!brokerUp ? 1 : 0) +
    1 /* log status/hint line */;
  const logVisible = Math.max(3, rows - chrome);

  const messages = log.messages;
  const len = messages.length;
  const maxTop = Math.max(0, len - logVisible);
  const start = stick ? maxTop : Math.min(topIndex, maxTop);
  const visible = messages.slice(start, start + logVisible);
  const newBelow = stick ? 0 : len - (start + visible.length);

  // Scroll state mirrored into a ref so the key handler never reads a stale
  // closure regardless of ink's useInput re-subscription timing.
  const scrollRef = useRef({ len, logVisible, stick, topIndex });
  scrollRef.current = { len, logVisible, stick, topIndex };

  const scrollBy = (delta: number) => {
    const s = scrollRef.current;
    const mt = Math.max(0, s.len - s.logVisible);
    const base = s.stick ? mt : Math.min(s.topIndex, mt);
    const next = Math.max(0, Math.min(mt, base + delta));
    setTopIndex(next);
    setStick(next >= mt);
  };

  useInput(
    (input, key) => {
      if (key.ctrl && input === "c") { exit(); return; }
      if (input === "q" && draft.length === 0) { exit(); return; }
      if (key.tab) { setTargetId((cur) => cycleTarget(cur, live)); return; }
      if (key.upArrow) { scrollBy(-1); return; }
      if (key.downArrow) { scrollBy(1); return; }
      if (key.pageUp) { scrollBy(-scrollRef.current.logVisible); return; }
      if (key.pageDown) { scrollBy(scrollRef.current.logVisible); return; }
    },
    { isActive: isRawModeSupported },
  );

  const onSubmit = async (text: string) => {
    const t = text.trim();
    if (!t) return;
    if (!targetId) {
      setSendError("no live seat to send to");
      return;
    }
    try {
      const res = await brokerPost<{ ok: boolean; error?: string }>("/send-message", {
        from_id: "cli",
        to_id: targetId,
        text: t,
      });
      if (!res.ok) {
        setSendError(res.error ?? `send to ${shortId(targetId)} failed`);
        return;
      }
      setSendError(null);
      setDraft("");
    } catch (e) {
      setSendError(e instanceof BrokerError ? e.message : String(e));
    }
  };

  // ---- fleet board ----
  const fixed = 8 + 12 + 8 + 4 + 8; // SEAT ROLE MODEL LIVE SPEND
  const budget = Math.max(20, cols - 4 - 7 * 2 - fixed); // borders/pad + 7 gaps
  const cwdW = Math.max(10, Math.floor(budget * 0.45));
  const sumW = Math.max(10, budget - cwdW);
  const boardCols: Column[] = [
    { header: "SEAT", width: 8 },
    { header: "ROLE", width: 12 },
    { header: "MODEL", width: 8 },
    { header: "CWD", width: cwdW },
    { header: "LIVE", width: 4 },
    { header: "SPEND", width: 8, align: "right" },
    { header: "SUMMARY", width: sumW },
  ];
  const boardRowsData: Cell[][] = seats.map((s) => {
    const alive = pidAlive(s.pid);
    const st = statsBySeat.get(s.id);
    return [
      { text: shortId(s.id), dim: !alive },
      { text: roleTag(s.role), dim: !alive },
      { text: s.model ?? "-", dim: !alive },
      { text: shortenCwd(s.cwd, HOME), dim: !alive },
      { text: alive ? "yes" : "no", color: alive ? "green" : "red" },
      { text: usd(st?.cost_usd ?? 0), align: "right", dim: !alive },
      { text: s.summary || "-", dim: !alive },
    ];
  });

  const ht = headerTotals(totals);
  const targetRole = targetId ? seats.find((s) => s.id === targetId)?.role ?? null : null;
  const logRange = len > 0 ? `${start + 1}-${start + visible.length}/${len}` : "0";

  return (
    <Box flexDirection="column" width={cols}>
      {/* header strip */}
      <Box>
        <Text color={brokerUp ? "green" : "red"}>{brokerUp ? "●" : "○"}</Text>
        <Text bold> patrol watch </Text>
        <Text color="gray"> seats </Text>
        <Text bold>{seats.length}</Text>
        <Text color="gray"> fleet </Text>
        <Text bold color="cyan">{usd(ht.spendUsd)}</Text>
        <Text color="gray"> wakes </Text>
        <Text bold>{ht.wakes}</Text>
      </Box>

      {!brokerUp && <Text color="yellow">broker unreachable — retrying</Text>}

      {/* fleet board */}
      <Panel title="FLEET" width={cols}>
        {seats.length === 0 ? (
          <Text color="gray">no seats registered</Text>
        ) : (
          <Table columns={boardCols} rows={boardRowsData} />
        )}
      </Panel>

      {/* message log */}
      <Panel title={`MESSAGES ${logRange}`} width={cols}>
        {visible.length === 0 ? (
          <Text color="gray">no messages yet</Text>
        ) : (
          visible.map((m) => (
            <Box key={m.id}>
              <Text color="gray">{hhmmss(m.sent_at)} </Text>
              <Text color="cyan">{shortId(m.from_id)}</Text>
              <Text color="gray">({roleTag(m.from_role)}) → </Text>
              <Text color="magenta">{shortId(m.to_id)}</Text>
              <Text color="gray">({roleTag(m.to_role)})  </Text>
              <Text>{truncate(m.text.replace(/\s+/g, " "), Math.max(10, cols - 44))}</Text>
            </Box>
          ))
        )}
      </Panel>

      {/* scroll hint */}
      {!stick && newBelow > 0 ? (
        <Text color="yellow">  ↓ {newBelow} new — PgDn/↓ to follow</Text>
      ) : (
        <Text> </Text>
      )}

      {/* send error (verbatim broker text) */}
      {sendError && <Text color="red">{sendError}</Text>}

      {/* input bar */}
      <Box>
        <Text color="gray">→ </Text>
        <Text bold color="magenta">{targetId ? shortId(targetId) : "—"}</Text>
        <Text color="gray">{targetRole ? ` (${targetRole})` : ""} </Text>
        <TextInput value={draft} onChange={setDraft} onSubmit={onSubmit} placeholder="message… (Tab to switch seat)" />
      </Box>

      {/* footer */}
      <KeyHint
        keys={[
          { key: "Tab", label: "target" },
          { key: "↑↓ PgUp/Dn", label: "scroll" },
          { key: "Enter", label: "send" },
          { key: "q", label: "quit" },
        ]}
      />
    </Box>
  );
}

export async function runWatch(): Promise<void> {
  const app = render(<WatchApp />);
  await app.waitUntilExit();
}

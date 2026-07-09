// Hand-written (NOT the inkui `table`): the generated Table draws a full
// bordered grid and paints every cell one colour. The fleet board needs the
// opposite — a dense, borderless layout where each cell carries its own colour
// and dead seats render dimmed. Column widths are computed by the caller (it
// owns the terminal-width budget); this component only pads/truncates/paints.
import { Box, Text } from "ink";

export interface Cell {
  text: string;
  color?: string;
  dim?: boolean;
  bold?: boolean;
}

export interface Column {
  header: string;
  width: number;
  align?: "left" | "right";
}

function fit(raw: string, w: number, right?: boolean): string {
  // Collapse whitespace runs so a newline in a cell (e.g. a seat summary) can't
  // break the single-line row and desync the caller's height budget.
  const s = raw.replace(/\s+/g, " ");
  if (s.length > w) return w <= 1 ? s.slice(0, w) : s.slice(0, w - 1) + "…";
  return right ? s.padStart(w) : s.padEnd(w);
}

const GAP = "  ";

export function Table({
  columns,
  rows,
  headerColor = "cyan",
}: {
  columns: Column[];
  rows: Cell[][];
  headerColor?: string;
}) {
  return (
    <Box flexDirection="column">
      <Box>
        {columns.map((c, i) => (
          <Text key={i} color={headerColor} bold>
            {fit(c.header, c.width, c.align === "right") + GAP}
          </Text>
        ))}
      </Box>
      {rows.map((cells, ri) => (
        <Box key={ri}>
          {columns.map((col, ci) => {
            const cell = cells[ci] ?? { text: "" };
            return (
              <Text key={ci} color={cell.color} dimColor={cell.dim} bold={cell.bold}>
                {fit(cell.text, col.width, col.align === "right") + GAP}
              </Text>
            );
          })}
        </Box>
      ))}
    </Box>
  );
}

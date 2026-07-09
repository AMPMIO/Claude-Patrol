// Hand-written (NOT the inkui `panel`): the generated one depends on
// `string-width` — a dep this package is not allowed to add — and ships a
// SplitPane we don't use. Our titles are ASCII, so plain `.length` sizing is
// exact. Title is embedded in the top border, coloured independently.
//
// `width` is REQUIRED and must be the terminal column count: the custom top
// line is a fixed-length string and would visually desync from the native
// bordered box below if the box were allowed to auto-size.
import { Box, Text } from "ink";
import type { ReactNode } from "react";

const B = { topLeft: "╭", topRight: "╮", horiz: "─" };

export interface PanelProps {
  title?: string;
  /** Total columns including both border chars. Pass the terminal width. */
  width: number;
  /** Border colour (default gray). */
  color?: string;
  /** Title colour (default cyan). */
  titleColor?: string;
  children: ReactNode;
}

export function Panel({ title, width, color = "gray", titleColor = "cyan", children }: PanelProps) {
  const inner = Math.max(4, width - 2);

  let top: ReactNode;
  if (title) {
    const label = ` ${title} `;
    const lead = 1;
    const rest = Math.max(0, inner - lead - label.length);
    top = (
      <Box>
        <Text color={color}>{B.topLeft + B.horiz.repeat(lead)}</Text>
        <Text color={titleColor} bold>{label}</Text>
        <Text color={color}>{B.horiz.repeat(rest) + B.topRight}</Text>
      </Box>
    );
  } else {
    top = <Text color={color}>{B.topLeft + B.horiz.repeat(inner) + B.topRight}</Text>;
  }

  return (
    <Box flexDirection="column" width={width}>
      {top}
      <Box
        borderStyle="round"
        borderTop={false}
        borderColor={color}
        paddingX={1}
        flexDirection="column"
        width={width}
      >
        {children}
      </Box>
    </Box>
  );
}

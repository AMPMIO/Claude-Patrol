// Vendored from inkui (github.com/kamlesh723/inkui) `key-hint`.
// Local edit: import path -> ./theme.ts.
import React from "react";
import { Text, Box } from "ink";
import { darkTheme } from "./theme.ts";
import type { InkUITheme } from "./theme.ts";

export interface KeyHintItem {
  /** Displayed in brackets, e.g. "Enter", "↑↓", "Space" */
  key: string;
  /** Description label, e.g. "Select", "Navigate", "Toggle" */
  label: string;
}

export interface KeyHintProps {
  keys: KeyHintItem[];
  theme?: InkUITheme;
}

export const KeyHint: React.FC<KeyHintProps> = ({ keys, theme = darkTheme }) => (
  <Box gap={2}>
    {keys.map(({ key, label }) => (
      <Box key={key} gap={1}>
        <Text bold dimColor>[{key}]</Text>
        <Text color={theme.colors.muted}>{label}</Text>
      </Box>
    ))}
  </Box>
);

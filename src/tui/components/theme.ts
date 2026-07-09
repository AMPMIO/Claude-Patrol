// Minimal color palette for the watch TUI. Trimmed from inkui's generated
// _core.ts (github.com/kamlesh723/inkui) — we keep only the color keys the
// vendored components reference; the spinner/border-style tokens went unused.
export interface InkUITheme {
  colors: {
    primary: string;
    secondary: string;
    success: string;
    warning: string;
    error: string;
    info: string;
    muted: string;
    text: string;
    border: string;
    focus: string;
  };
}

export const darkTheme: InkUITheme = {
  colors: {
    primary: "cyan",
    secondary: "magenta",
    success: "green",
    warning: "yellow",
    error: "red",
    info: "blue",
    muted: "gray",
    text: "white",
    border: "gray",
    focus: "cyan",
  },
};

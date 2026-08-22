// Centralized glyph registry — the TUI's stand-ins for the web UI's lucide icons.
//
// A terminal can only spend whole columns, and most emoji are East-Asian-wide
// (two columns) which would shear every aligned row. So each glyph here MUST be a
// single display column; `icons.test.ts` enforces that with `Bun.stringWidth`.
// The decision was "hybrid — emoji only where reliably single-width": that gate is
// the width test, and today it resolves to single-column unicode symbols that read
// as icons. `webIcon` records the lucide name each glyph mirrors so the parity is
// documented and checkable, and so a future single-width emoji can drop in behind
// the same guard.

export interface IconGlyph {
  /** What the TUI renders — guaranteed one display column. */
  readonly glyph: string;
  /** The web (lucide-react) icon name this stands in for. */
  readonly webIcon: string;
}

/** Per-tool / per-activity icons (mirrors web MessagesTimeline tool-type icons). */
export const TOOL_ICONS = {
  terminal: { glyph: "$", webIcon: "terminal" },
  fileRead: { glyph: "◎", webIcon: "eye" },
  fileChange: { glyph: "✎", webIcon: "square-pen" },
  imageView: { glyph: "▣", webIcon: "image" },
  webSearch: { glyph: "⌕", webIcon: "globe" },
  mcp: { glyph: "⚙", webIcon: "wrench" },
  dynamic: { glyph: "⚒", webIcon: "hammer" },
  userInput: { glyph: "✦", webIcon: "message-circle" },
  thinking: { glyph: "✱", webIcon: "sparkles" },
  error: { glyph: "✗", webIcon: "x" },
  default: { glyph: "•", webIcon: "dot" },
} as const satisfies Record<string, IconGlyph>;

/** Tool-call lifecycle status icons (mirrors web Check / X / loader / Minus). */
export const STATUS_ICONS = {
  success: { glyph: "✓", webIcon: "check" },
  failure: { glyph: "✗", webIcon: "x" },
  progress: { glyph: "⟳", webIcon: "loader" },
  neutral: { glyph: "−", webIcon: "minus" },
} as const satisfies Record<string, IconGlyph>;

/** Every glyph the registry ships, for the single-column width guard in tests. */
export function allIconGlyphs(): ReadonlyArray<IconGlyph> {
  return [...Object.values(TOOL_ICONS), ...Object.values(STATUS_ICONS)];
}

// File-type → named ANSI colour for the changed-files tree's file glyph, echoing
// the web's PierreEntryIcon colouring at terminal-palette fidelity (a coarse map;
// unknown extensions fall back to the muted default).
const FILE_TYPE_COLORS: Record<string, string> = {
  ts: "blue",
  tsx: "blue",
  js: "yellow",
  jsx: "yellow",
  mjs: "yellow",
  cjs: "yellow",
  json: "yellow",
  css: "magenta",
  scss: "magenta",
  html: "red",
  md: "cyan",
  mdx: "cyan",
  py: "blue",
  rs: "red",
  go: "cyan",
  zig: "yellow",
  sh: "green",
  bash: "green",
  yml: "magenta",
  yaml: "magenta",
  toml: "magenta",
  lock: "gray",
  sql: "cyan",
};

/** Named ANSI colour for a path's file type, or null when unknown (caller dims it). */
export function fileTypeColor(path: string): string | null {
  const base = path.split("/").pop() ?? path;
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return null;
  return FILE_TYPE_COLORS[base.slice(dot + 1).toLowerCase()] ?? null;
}

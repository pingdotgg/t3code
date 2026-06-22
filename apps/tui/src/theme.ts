import { RGBA, type TerminalColors } from "@opentui/core";
import type { OrchestrationThreadShell } from "@t3tools/contracts";

/**
 * Shared visual vocabulary for the TUI, mirroring the web sidebar's status pills
 * (apps/web/src/components/Sidebar.logic.ts `resolveThreadStatusPill`) and
 * relative-time labels (apps/web/src/timestampFormat.ts). Web colours map to the
 * named ANSI colours Ink supports: amber→yellow, indigo/violet→magenta,
 * sky→cyan, emerald→green.
 */
export interface ThreadStatus {
  readonly key: string;
  /** Single-cell glyph for a status dot. */
  readonly glyph: string;
  readonly color: string;
  readonly bold: boolean;
  readonly label: string;
  /** Lower = higher priority (used to aggregate a project's status). */
  readonly rank: number;
}

const PENDING_APPROVAL: ThreadStatus = {
  key: "pending-approval",
  glyph: "◆",
  color: "red",
  bold: true,
  label: "Pending approval",
  rank: 0,
};
const AWAITING_INPUT: ThreadStatus = {
  key: "awaiting-input",
  glyph: "◆",
  color: "yellow",
  bold: true,
  label: "Awaiting input",
  rank: 1,
};
const PLAN_READY: ThreadStatus = {
  key: "plan-ready",
  glyph: "◇",
  color: "magenta",
  bold: false,
  label: "Plan ready",
  rank: 2,
};
const WORKING: ThreadStatus = {
  key: "working",
  glyph: "●",
  color: "green",
  bold: true,
  label: "Working",
  rank: 3,
};
const CONNECTING: ThreadStatus = {
  key: "connecting",
  glyph: "◌",
  color: "cyan",
  bold: false,
  label: "Connecting",
  rank: 4,
};
const ERRORED: ThreadStatus = {
  key: "error",
  glyph: "✕",
  color: "red",
  bold: true,
  label: "Error",
  rank: 5,
};
const READY: ThreadStatus = {
  key: "ready",
  glyph: "○",
  color: "cyan",
  bold: false,
  label: "Ready",
  rank: 6,
};
const COMPLETED: ThreadStatus = {
  key: "completed",
  glyph: "✓",
  color: "green",
  bold: false,
  label: "Completed",
  rank: 7,
};
const IDLE: ThreadStatus = {
  key: "idle",
  glyph: "○",
  color: "gray",
  bold: false,
  label: "Idle",
  rank: 8,
};

/** Every thread-status dot glyph, for the single-column width guard in tests. */
export const THREAD_STATUS_GLYPHS: ReadonlyArray<string> = [
  PENDING_APPROVAL,
  AWAITING_INPUT,
  PLAN_READY,
  WORKING,
  CONNECTING,
  ERRORED,
  READY,
  COMPLETED,
  IDLE,
].map((status) => status.glyph);

/**
 * Resolve a thread's status to a dot, in the same priority order the web sidebar
 * uses. Always returns a status (idle is the fallback) so list rows show a dot.
 */
export function resolveThreadStatus(thread: OrchestrationThreadShell): ThreadStatus {
  if (thread.hasPendingApprovals) return PENDING_APPROVAL;
  if (thread.hasPendingUserInput) return AWAITING_INPUT;
  if (thread.hasActionableProposedPlan) return PLAN_READY;
  switch (thread.session?.status) {
    case "running":
      return WORKING;
    case "starting":
      return CONNECTING;
    case "error":
      return ERRORED;
    case "ready":
      return READY;
    case "stopped":
      return COMPLETED;
    default:
      return IDLE;
  }
}

/**
 * Highest-priority non-idle status across a project's threads, or null when every
 * thread is idle (mirrors the web's `resolveProjectStatusIndicator`).
 */
export function resolveProjectStatus(
  threads: ReadonlyArray<OrchestrationThreadShell>,
): ThreadStatus | null {
  let best: ThreadStatus | null = null;
  for (const thread of threads) {
    const status = resolveThreadStatus(thread);
    if (status.key === IDLE.key) continue;
    if (best === null || status.rank < best.rank) best = status;
  }
  return best;
}

/** Colour for a bare session status label (used in the conversation header). */
export function sessionStatusColor(status: string | null | undefined): string {
  switch (status) {
    case "running":
    case "stopped":
      return "green";
    case "starting":
    case "ready":
      return "cyan";
    case "error":
      return "red";
    default:
      return "gray";
  }
}

/** Compact relative time (≤3 chars): now / 2m / 3h / 5d — same thresholds as web. */
export function relativeTime(iso: string): string {
  const diffMs = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(diffMs) || diffMs < 0) return "now";
  const seconds = Math.floor(diffMs / 1000);
  if (seconds < 60) return "now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return `${days}d`;
}

// ── Terminal-themed colours ──────────────────────────────────────────────────
//
// OpenTUI is a truecolor framebuffer renderer, but it can emit *indexed* and
// *default* colour intents that the terminal renders with ITS OWN palette. We use
// those exclusively so the UI borrows the user's theme (any dark/light scheme)
// instead of hardcoding hex that fights their background:
//   - `text`   → the terminal's default foreground (RGBA.defaultForeground)
//   - `bg`     → the terminal's default background (used for inverse cells)
//   - `dim`    → ANSI slot 8 ("bright black"), the theme's muted grey
//   - `accent` → ANSI slot 6 (cyan)
//   - status/role/border colours map their names to ANSI slots 0–15 via `ansi()`.
// The renderer itself is created with a transparent background, so the terminal's
// own backdrop shows through.

const ANSI_INDEX: Record<string, number> = {
  black: 0,
  red: 1,
  green: 2,
  yellow: 3,
  blue: 4,
  magenta: 5,
  cyan: 6,
  white: 7,
  gray: 8,
  grey: 8,
  brightblack: 8,
  brightred: 9,
  brightgreen: 10,
  brightyellow: 11,
  brightblue: 12,
  brightmagenta: 13,
  brightcyan: 14,
  brightwhite: 15,
};

// The terminal's actual colours, detected via `renderer.getPalette()` at startup
// (index.tsx). OpenTUI is a truecolor renderer: an indexed RGBA carries a SNAPSHOT
// rgb used whenever it must composite (and we render on a transparent background,
// so it always composites). Without a snapshot the indexed colours fall back to
// OpenTUI's built-in xterm palette — which is darker/different from a customised
// terminal theme. So once we know the real palette we pass each detected colour as
// the snapshot, making indexed/default intents render as the USER's theme.
let detected: TerminalColors | null = null;

/**
 * An indexed-intent RGBA carrying the user's detected colour for that ANSI slot as
 * its compositing snapshot (so it renders as their theme on our transparent
 * background). Falls back to OpenTUI's built-in palette for slots we haven't
 * detected (extended 16–255). Exported so the embedded terminal themes its cells
 * the same way the rest of the UI does.
 */
export function indexedColor(index: number): RGBA {
  const snapshot = detected?.palette[index];
  return snapshot ? RGBA.fromIndex(index, snapshot) : RGBA.fromIndex(index);
}

function defaultFg(): RGBA {
  const snapshot = detected?.defaultForeground;
  return snapshot ? RGBA.defaultForeground(snapshot) : RGBA.defaultForeground();
}

function defaultBg(): RGBA {
  const snapshot = detected?.defaultBackground;
  return snapshot ? RGBA.defaultBackground(snapshot) : RGBA.defaultBackground();
}

/** Resolve a named colour to an indexed RGBA the terminal themes itself. */
export function ansi(name: string): RGBA {
  const index = ANSI_INDEX[name.toLowerCase()];
  return index === undefined ? defaultFg() : indexedColor(index);
}

export interface Palette {
  readonly text: RGBA;
  readonly bg: RGBA;
  readonly dim: RGBA;
  readonly accent: RGBA;
  readonly selectedBg: RGBA;
}

export const THEME: { -readonly [K in keyof Palette]: Palette[K] } = {
  text: defaultFg(),
  bg: defaultBg(),
  dim: indexedColor(8),
  accent: indexedColor(6),
  selectedBg: indexedColor(8),
};

/**
 * Apply the terminal's detected palette so every theme colour snapshots the user's
 * real colours. Called once at startup after `renderer.getPalette()` resolves.
 */
export function applyTerminalColors(colors: TerminalColors): void {
  detected = colors;
  THEME.text = defaultFg();
  THEME.bg = defaultBg();
  THEME.dim = indexedColor(8);
  THEME.accent = indexedColor(6);
  THEME.selectedBg = indexedColor(8);
}

/** The active palette. Updated in place by applyTerminalColors at startup. */
export const usePalette = (): Palette => THEME;

/** Glyph + colour for a status-line tone (mirrors the web toast icon set). */
export function statusGlyphColor(
  kind: "info" | "success" | "error" | "busy",
): { readonly glyph: string; readonly color: RGBA } {
  switch (kind) {
    case "success":
      return { glyph: "✓", color: ansi("green") };
    case "error":
      return { glyph: "✗", color: ansi("red") };
    case "busy":
      return { glyph: "⟳", color: THEME.accent };
    default:
      return { glyph: "·", color: THEME.dim };
  }
}

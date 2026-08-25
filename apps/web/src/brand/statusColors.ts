/**
 * The only colors the interface is allowed to spend. Tangerine marks what
 * needs a person; the rest are semantic states. Everything else stays on the
 * neutral surface tokens.
 *
 * Each entry carries the CSS custom property to prefer in markup and the raw
 * hex for the places that cannot take a variable (canvas, SVG attributes,
 * favicon generation).
 */
export type StatusColor = Readonly<{
  /** The custom property name, e.g. `--primary`. */
  cssVar: string;
  hex: string;
}>;

export type StatusName = "needsYou" | "watching" | "done" | "failed" | "link";

export const statusColors: Readonly<Record<StatusName, StatusColor>> = {
  needsYou: { cssVar: "--primary", hex: "#FF5C1C" },
  watching: { cssVar: "--warning", hex: "#FFA81C" },
  done: { cssVar: "--success", hex: "#47C861" },
  failed: { cssVar: "--error", hex: "#FF474D" },
  link: { cssVar: "--info", hex: "#1490E8" },
};

/** `var(--primary)`, ready to drop into a style prop. */
export function brandColorVar(color: StatusColor): string {
  return `var(${color.cssVar})`;
}

export function statusColorVar(status: StatusName): string {
  return brandColorVar(statusColors[status]);
}

export type Priority = "P0" | "P1" | "P2" | "P3" | "P4";

const NEUTRAL_PRIORITY: StatusColor = { cssVar: "--muted-foreground", hex: "#63635B" };

const PRIORITY_COLORS: Readonly<Record<Priority, StatusColor>> = {
  P0: statusColors.failed,
  P1: statusColors.needsYou,
  P2: statusColors.watching,
  P3: NEUTRAL_PRIORITY,
  P4: NEUTRAL_PRIORITY,
};

/** P0 and P1 earn color; P3 and P4 recede into muted text. */
export function priorityColor(priority: Priority): StatusColor {
  return PRIORITY_COLORS[priority];
}

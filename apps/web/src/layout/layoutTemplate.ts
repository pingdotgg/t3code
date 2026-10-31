/**
 * Normalize every template edit to unit column widths and pane shares.
 * Retain a chat pane so the saved template always decodes.
 */
import type {
  LayoutPaneKind,
  LayoutTemplate,
  LayoutTemplateColumn,
  LayoutTemplatePane,
} from "@t3tools/contracts";

import type { LayoutCompanionKind, LayoutDirection } from "./layoutModel";

export interface LayoutTemplatePath {
  column: number;
  pane: number;
}

/** A pane or column never shrinks below this share. */
const LAYOUT_TEMPLATE_MIN_SHARE = 0.15;
/** What a pane dragged beside another takes of it (pen B4Wwa "Split right · 40%"). */
export const LAYOUT_TEMPLATE_SPLIT_SHARE = 0.4;
/** A pane dropped on the bottom edge runs under every column at this height. */
export const LAYOUT_TEMPLATE_BOTTOM_SHARE = 0.36;

const DETAIL_KINDS: ReadonlySet<LayoutPaneKind> = new Set(["diff", "files", "browser"]);

function round(value: number): number {
  return Math.round(value * 10_000) / 10_000;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

/** Shares rescaled to sum to 1, rounded so the stored JSON stays short. */
function rescale<T extends { size: number }>(entries: readonly T[]): T[] {
  const total = entries.reduce((sum, entry) => sum + entry.size, 0);
  if (total <= 0) return entries.map((entry) => ({ ...entry, size: round(1 / entries.length) }));
  return entries.map((entry) => ({ ...entry, size: round(entry.size / total) }));
}

/**
 * Sizes sum to 1 per column and across columns; only the last pane of the
 * first column may span the full width, and only while there is more than
 * one column to span.
 */
function normalizeLayoutTemplate(template: LayoutTemplate): LayoutTemplate {
  const columns = template.columns.filter((column) => column.panes.length > 0);
  if (columns.length === 0) return template;
  return {
    columns: rescale(columns).map((column, columnIndex) => ({
      ...column,
      panes: rescale(column.panes).map((pane, paneIndex) => ({
        ...pane,
        span:
          pane.span === "full" &&
          columnIndex === 0 &&
          paneIndex === column.panes.length - 1 &&
          columns.length > 1
            ? ("full" as const)
            : ("column" as const),
      })),
    })),
  };
}

function findLayoutTemplatePane(
  template: LayoutTemplate,
  path: LayoutTemplatePath,
): LayoutTemplatePane | null {
  return template.columns[path.column]?.panes[path.pane] ?? null;
}

export function countLayoutTemplatePanes(template: LayoutTemplate): number {
  return template.columns.reduce((sum, column) => sum + column.panes.length, 0);
}

/** The only chat pane can't be removed or turned into something else. */
export function isOnlyLayoutTemplateChat(
  template: LayoutTemplate,
  path: LayoutTemplatePath,
): boolean {
  const pane = findLayoutTemplatePane(template, path);
  if (pane?.kind !== "chat") return false;
  return (
    template.columns.flatMap((column) => column.panes).filter((entry) => entry.kind === "chat")
      .length === 1
  );
}

/** Whether "Spans" applies: the bottom pane of the first column, with columns to run under. */
export function canLayoutTemplatePaneSpan(
  template: LayoutTemplate,
  path: LayoutTemplatePath,
): boolean {
  const first = template.columns[0];
  return (
    template.columns.length > 1 &&
    path.column === 0 &&
    first !== undefined &&
    first.panes.length > 1 &&
    path.pane === first.panes.length - 1
  );
}

/** Below this a split or drop would leave a pane too small to show, so it is refused. */
const LAYOUT_TEMPLATE_MIN_ADDED_SHARE = 0.08;

/** The edit, or the original when it would squeeze a pane or column past the minimum. */
function unlessCramped(original: LayoutTemplate, next: LayoutTemplate): LayoutTemplate {
  const cramped = next.columns.some(
    (column) =>
      column.size < LAYOUT_TEMPLATE_MIN_ADDED_SHARE ||
      column.panes.some((pane) => pane.size < LAYOUT_TEMPLATE_MIN_ADDED_SHARE),
  );
  return cramped ? original : next;
}

function newPane(kind: LayoutPaneKind, size: number): LayoutTemplatePane {
  return { kind, size, span: "column" };
}

function newColumn(kind: LayoutPaneKind, size: number): LayoutTemplateColumn {
  return { size, panes: [newPane(kind, 1)] };
}

/** Put a pane of `kind` beside the pane at `path`, taking `share` of it. */
export function splitLayoutTemplatePane(
  template: LayoutTemplate,
  path: LayoutTemplatePath,
  side: LayoutDirection,
  kind: LayoutPaneKind,
  share = LAYOUT_TEMPLATE_SPLIT_SHARE,
): LayoutTemplate {
  const column = template.columns[path.column];
  const pane = column?.panes[path.pane];
  if (!column || !pane) return template;
  if (side === "up" || side === "down") {
    const panes = [...column.panes];
    const kept = { ...pane, size: pane.size * (1 - share) };
    const added = newPane(kind, pane.size * share);
    // A full-width pane stays the bottom one when something goes below it.
    if (side === "down" && pane.span === "full") {
      panes.splice(path.pane, 1, { ...kept, span: "column" }, { ...added, span: "full" });
    } else {
      panes.splice(path.pane, 1, ...(side === "up" ? [added, kept] : [kept, added]));
    }
    const columns = [...template.columns];
    columns[path.column] = { ...column, panes };
    return unlessCramped(template, normalizeLayoutTemplate({ columns }));
  }
  const columns = [...template.columns];
  columns[path.column] = { ...column, size: column.size * (1 - share) };
  columns.splice(
    side === "left" ? path.column : path.column + 1,
    0,
    newColumn(kind, column.size * share),
  );
  return unlessCramped(template, normalizeLayoutTemplate({ columns }));
}

/**
 * Drop a pane on an edge of the whole layout: the left or right edge adds a
 * column there, the bottom edge a pane that runs under every column.
 */
export function extendLayoutTemplate(
  template: LayoutTemplate,
  edge: "left" | "right" | "bottom",
  kind: LayoutPaneKind,
): LayoutTemplate {
  if (edge === "bottom") {
    const [first, ...rest] = template.columns;
    if (!first) return template;
    const share = LAYOUT_TEMPLATE_BOTTOM_SHARE;
    const panes = [
      ...first.panes.map((pane) => ({
        ...pane,
        size: pane.size * (1 - share),
        span: "column" as const,
      })),
      { ...newPane(kind, share), span: "full" as const },
    ];
    return unlessCramped(
      template,
      normalizeLayoutTemplate({ columns: [{ ...first, panes }, ...rest] }),
    );
  }
  const share = LAYOUT_TEMPLATE_SPLIT_SHARE;
  const scaled = template.columns.map((column) => ({ ...column, size: column.size * (1 - share) }));
  const added = newColumn(kind, share);
  return unlessCramped(
    template,
    normalizeLayoutTemplate({ columns: edge === "left" ? [added, ...scaled] : [...scaled, added] }),
  );
}

/** Remove a pane; its room goes to the pane above it (or below), or its column's to the left. */
export function removeLayoutTemplatePane(
  template: LayoutTemplate,
  path: LayoutTemplatePath,
): LayoutTemplate {
  const column = template.columns[path.column];
  const pane = column?.panes[path.pane];
  if (!column || !pane) return template;
  if (countLayoutTemplatePanes(template) <= 1 || isOnlyLayoutTemplateChat(template, path)) {
    return template;
  }
  const columns = [...template.columns];
  if (column.panes.length === 1) {
    columns.splice(path.column, 1);
    const heir = Math.max(0, path.column - 1);
    const neighbor = columns[heir];
    if (neighbor) columns[heir] = { ...neighbor, size: neighbor.size + column.size };
    return normalizeLayoutTemplate({ columns });
  }
  const panes = [...column.panes];
  panes.splice(path.pane, 1);
  const heir = path.pane > 0 ? path.pane - 1 : 0;
  const neighbor = panes[heir]!;
  panes[heir] = {
    ...neighbor,
    size: neighbor.size + pane.size,
    // The pane taking the bottom slot inherits a full-width span.
    span: pane.span === "full" && heir === panes.length - 1 ? "full" : neighbor.span,
  };
  columns[path.column] = { ...column, panes };
  return normalizeLayoutTemplate({ columns });
}

function mapPane(
  template: LayoutTemplate,
  path: LayoutTemplatePath,
  update: (pane: LayoutTemplatePane) => LayoutTemplatePane,
): LayoutTemplate {
  const pane = findLayoutTemplatePane(template, path);
  if (!pane) return template;
  return normalizeLayoutTemplate({
    columns: template.columns.map((column, columnIndex) =>
      columnIndex !== path.column
        ? column
        : {
            ...column,
            panes: column.panes.map((entry, paneIndex) =>
              paneIndex === path.pane ? update(entry) : entry,
            ),
          },
    ),
  });
}

export function setLayoutTemplatePaneKind(
  template: LayoutTemplate,
  path: LayoutTemplatePath,
  kind: LayoutPaneKind,
): LayoutTemplate {
  if (kind !== "chat" && isOnlyLayoutTemplateChat(template, path)) return template;
  return mapPane(template, path, (pane) => ({ ...pane, kind }));
}

export function setLayoutTemplatePaneSpan(
  template: LayoutTemplate,
  path: LayoutTemplatePath,
  span: "column" | "full",
): LayoutTemplate {
  if (span === "full" && !canLayoutTemplatePaneSpan(template, path)) return template;
  return mapPane(template, path, (pane) => ({ ...pane, span }));
}

/**
 * Set the divider after pane `index` of a column: `share` is the upper
 * pane's part of the pair, so the panes around the divider trade height
 * and the rest keep theirs.
 */
export function resizeLayoutTemplatePaneDivider(
  template: LayoutTemplate,
  columnIndex: number,
  index: number,
  share: number,
): LayoutTemplate {
  if (!Number.isFinite(share)) return template;
  const column = template.columns[columnIndex];
  const upper = column?.panes[index];
  const lower = column?.panes[index + 1];
  if (!column || !upper || !lower) return template;
  const total = upper.size + lower.size;
  const minimum = Math.min(LAYOUT_TEMPLATE_MIN_SHARE, total / 2);
  const size = clamp(share * total, minimum, total - minimum);
  const panes = [...column.panes];
  panes[index] = { ...upper, size };
  panes[index + 1] = { ...lower, size: total - size };
  const columns = [...template.columns];
  columns[columnIndex] = { ...column, panes };
  return normalizeLayoutTemplate({ columns });
}

/** Set the divider after column `index`; `share` is the left column's part of the pair. */
export function resizeLayoutTemplateColumnDivider(
  template: LayoutTemplate,
  index: number,
  share: number,
): LayoutTemplate {
  if (!Number.isFinite(share)) return template;
  const left = template.columns[index];
  const right = template.columns[index + 1];
  if (!left || !right) return template;
  const total = left.size + right.size;
  const minimum = Math.min(LAYOUT_TEMPLATE_MIN_SHARE, total / 2);
  const size = clamp(share * total, minimum, total - minimum);
  const columns = [...template.columns];
  columns[index] = { ...left, size };
  columns[index + 1] = { ...right, size: total - size };
  return normalizeLayoutTemplate({ columns });
}

/**
 * What the pane's size control changes: its height in its column when it
 * shares one, else its column's width, else nothing (a lone pane fills).
 */
export function layoutTemplatePaneMeasure(
  template: LayoutTemplate,
  path: LayoutTemplatePath,
): { axis: "height" | "width"; share: number } | null {
  const column = template.columns[path.column];
  const pane = column?.panes[path.pane];
  if (!column || !pane) return null;
  if (column.panes.length > 1) return { axis: "height", share: pane.size };
  if (template.columns.length > 1) return { axis: "width", share: column.size };
  return null;
}

/** Set a pane's height (or its column's width) and let its neighbor make room. */
export function setLayoutTemplatePaneShare(
  template: LayoutTemplate,
  path: LayoutTemplatePath,
  share: number,
): LayoutTemplate {
  const measure = layoutTemplatePaneMeasure(template, path);
  if (!measure) return template;
  if (measure.axis === "height") {
    const column = template.columns[path.column]!;
    const last = path.pane === column.panes.length - 1;
    const index = last ? path.pane - 1 : path.pane;
    const pair = column.panes[index]!.size + column.panes[index + 1]!.size;
    const upperSize = last ? pair - share : share;
    return resizeLayoutTemplatePaneDivider(template, path.column, index, upperSize / pair);
  }
  const last = path.column === template.columns.length - 1;
  const index = last ? path.column - 1 : path.column;
  const pair = template.columns[index]!.size + template.columns[index + 1]!.size;
  const leftSize = last ? pair - share : share;
  return resizeLayoutTemplateColumnDivider(template, index, leftSize / pair);
}

export function layoutTemplatesEqual(left: LayoutTemplate, right: LayoutTemplate): boolean {
  return (
    JSON.stringify(normalizeLayoutTemplate(left)) === JSON.stringify(normalizeLayoutTemplate(right))
  );
}

/**
 * The sizes the template gives the chat's companion panes, as their share
 * of the room they take from the chat: a terminal under the chat in its
 * column, and a column of diffs, files or a browser beside the chat's.
 * A kind the template doesn't place keeps the built-in size.
 */
export function layoutTemplateCompanionShares(
  template: LayoutTemplate,
): Partial<Record<LayoutCompanionKind, number>> {
  const chatColumnIndex = template.columns.findIndex((column) =>
    column.panes.some((pane) => pane.kind === "chat"),
  );
  const chatColumn = template.columns[chatColumnIndex];
  if (!chatColumn) return {};
  const chat = chatColumn.panes.find((pane) => pane.kind === "chat")!;
  const shares: Partial<Record<LayoutCompanionKind, number>> = {};
  const terminal = chatColumn.panes.find((pane) => pane.kind === "terminal");
  if (terminal) shares.terminal = terminal.size / (terminal.size + chat.size);
  const detailColumn = template.columns.find(
    (column, index) =>
      index !== chatColumnIndex && column.panes.some((pane) => DETAIL_KINDS.has(pane.kind)),
  );
  if (detailColumn) shares.panel = detailColumn.size / (detailColumn.size + chatColumn.size);
  return shares;
}

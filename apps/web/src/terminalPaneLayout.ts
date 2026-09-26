/**
 * Recursive split-pane tree for a terminal group. A flat "ids + one direction"
 * model cannot express a split nested inside another split: splitting a pane
 * in a different direction than its siblings has nowhere to go but the root,
 * which is why splitting vertically then horizontally used to re-split every
 * pane instead of just the active one. This tree lets a split live at any
 * depth, anchored at the pane that was actually active.
 */

export type TerminalSplitDirection = "horizontal" | "vertical";

export type TerminalPaneLayout =
  | { kind: "pane"; terminalId: string }
  | { kind: "split"; direction: TerminalSplitDirection; children: TerminalPaneLayout[] };

export function paneLayout(terminalId: string): TerminalPaneLayout {
  return { kind: "pane", terminalId };
}

export function layoutTerminalIds(layout: TerminalPaneLayout): string[] {
  if (layout.kind === "pane") return [layout.terminalId];
  return layout.children.flatMap(layoutTerminalIds);
}

export function layoutDirection(layout: TerminalPaneLayout): TerminalSplitDirection | null {
  return layout.kind === "split" ? layout.direction : null;
}

/** True once a tree nests both a horizontal and a vertical split, so no single direction describes it. */
export function layoutHasMixedDirections(layout: TerminalPaneLayout): boolean {
  const directions = new Set<TerminalSplitDirection>();
  const collect = (node: TerminalPaneLayout): void => {
    if (node.kind !== "split") return;
    directions.add(node.direction);
    node.children.forEach(collect);
  };
  collect(layout);
  return directions.size > 1;
}

export function terminalPaneLayoutEqual(
  left: TerminalPaneLayout,
  right: TerminalPaneLayout,
): boolean {
  if (left.kind === "pane" || right.kind === "pane") {
    return left.kind === "pane" && right.kind === "pane" && left.terminalId === right.terminalId;
  }
  if (left.direction !== right.direction || left.children.length !== right.children.length) {
    return false;
  }
  return left.children.every((child, index) =>
    terminalPaneLayoutEqual(child, right.children[index]!),
  );
}

/** Builds the layout the same way a legacy flat group rendered: one level, one direction. */
export function buildFlatLayout(
  terminalIds: readonly string[],
  direction: TerminalSplitDirection = "horizontal",
): TerminalPaneLayout {
  if (terminalIds.length <= 1) {
    return paneLayout(terminalIds[0] ?? "");
  }
  return { kind: "split", direction, children: terminalIds.map(paneLayout) };
}

/**
 * Resolves whatever layout a group carries into a valid tree over its current
 * terminal ids: a genuine tree is pruned/collapsed, anything else (missing,
 * corrupt, or a pre-nested-split group's bare id list) falls back to the flat
 * layout a legacy group would have rendered.
 */
/** True when a layout's leaves are exactly `terminalIds`, no duplicates or omissions. */
function layoutMatchesIds(layout: TerminalPaneLayout, terminalIds: readonly string[]): boolean {
  const layoutIds = layoutTerminalIds(layout);
  if (layoutIds.length !== terminalIds.length) return false;
  const seen = new Set<string>();
  for (const id of layoutIds) {
    if (seen.has(id)) return false;
    seen.add(id);
  }
  return terminalIds.every((id) => seen.has(id));
}

export function resolveTerminalPaneLayout(
  rawLayout: unknown,
  terminalIds: readonly string[],
  legacyDirection: TerminalSplitDirection = "horizontal",
): TerminalPaneLayout {
  if (isTerminalPaneLayout(rawLayout)) {
    const normalized = normalizePaneLayout(rawLayout, new Set(terminalIds));
    // A corrupt persisted layout (e.g. a duplicated leaf) can normalize to a
    // tree that drops one of `terminalIds` entirely; only trust it once its
    // leaves are a one-to-one match, otherwise fall through to a flat rebuild.
    if (normalized && layoutMatchesIds(normalized, terminalIds)) return normalized;
  }
  return buildFlatLayout(terminalIds, legacyDirection);
}

export function isTerminalPaneLayout(value: unknown): value is TerminalPaneLayout {
  if (!value || typeof value !== "object") return false;
  const kind = (value as { kind?: unknown }).kind;
  if (kind === "pane") {
    return typeof (value as { terminalId?: unknown }).terminalId === "string";
  }
  if (kind === "split") {
    const { direction, children } = value as { direction?: unknown; children?: unknown };
    return (
      (direction === "horizontal" || direction === "vertical") &&
      Array.isArray(children) &&
      children.length > 0 &&
      children.every(isTerminalPaneLayout)
    );
  }
  return false;
}

interface InsertResult {
  layout: TerminalPaneLayout;
  inserted: boolean;
}

function insertIntoLayout(
  node: TerminalPaneLayout,
  direction: TerminalSplitDirection,
  activeTerminalId: string,
  newTerminalId: string,
): InsertResult {
  if (node.kind === "pane") {
    if (node.terminalId !== activeTerminalId) return { layout: node, inserted: false };
    return {
      layout: { kind: "split", direction, children: [node, paneLayout(newTerminalId)] },
      inserted: true,
    };
  }
  const activeIndex = node.children.findIndex((child) =>
    layoutTerminalIds(child).includes(activeTerminalId),
  );
  if (activeIndex < 0) return { layout: node, inserted: false };
  const activeChild = node.children[activeIndex]!;
  // Same direction as the split the active pane already sits in: grow that
  // split with an equal sibling instead of nesting another level.
  if (activeChild.kind === "pane" && node.direction === direction) {
    const children = [...node.children];
    children.splice(activeIndex + 1, 0, paneLayout(newTerminalId));
    return { layout: { ...node, children }, inserted: true };
  }
  const childResult = insertIntoLayout(activeChild, direction, activeTerminalId, newTerminalId);
  const children = [...node.children];
  children[activeIndex] = childResult.layout;
  return { layout: { ...node, children }, inserted: childResult.inserted };
}

/**
 * Splits the active pane in place: a split in the same direction as the
 * active pane's siblings appends an equal sibling, a split in a different
 * direction nests a new split at that pane instead of touching the rest of
 * the tree.
 */
export function splitPaneLayout(
  layout: TerminalPaneLayout,
  activeTerminalId: string,
  newTerminalId: string,
  direction: TerminalSplitDirection,
): TerminalPaneLayout {
  const result = insertIntoLayout(layout, direction, activeTerminalId, newTerminalId);
  if (result.inserted) return result.layout;
  // Stale active id (should not normally happen): attach beside the whole
  // tree rather than silently dropping the new pane.
  return { kind: "split", direction, children: [layout, paneLayout(newTerminalId)] };
}

export function removePaneFromLayout(
  layout: TerminalPaneLayout,
  terminalId: string,
): TerminalPaneLayout | null {
  if (layout.kind === "pane") {
    return layout.terminalId === terminalId ? null : layout;
  }
  const children = layout.children
    .map((child) => removePaneFromLayout(child, terminalId))
    .filter((child): child is TerminalPaneLayout => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...layout, children };
}

/** Drops leaves outside `validTerminalIds` and collapses any split left with one child. */
export function normalizePaneLayout(
  layout: TerminalPaneLayout,
  validTerminalIds: ReadonlySet<string>,
): TerminalPaneLayout | null {
  if (layout.kind === "pane") {
    return validTerminalIds.has(layout.terminalId) ? layout : null;
  }
  const children = layout.children
    .map((child) => normalizePaneLayout(child, validTerminalIds))
    .filter((child): child is TerminalPaneLayout => child !== null);
  if (children.length === 0) return null;
  if (children.length === 1) return children[0]!;
  return { ...layout, children };
}

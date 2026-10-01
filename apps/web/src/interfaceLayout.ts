import type { InterfaceLayout, InterfaceSurfaceLayout } from "@t3tools/contracts";

/**
 * The surfaces Customize interface mode can arrange, and the elements each
 * one owns. Element order in each list is the app's default arrangement.
 *
 * `sortable` elements can be reordered among themselves; the rest keep their
 * built-in position. `required` elements can't be hidden, because the surface
 * would lose a control nothing else offers.
 */
export interface InterfaceElementDefinition {
  readonly id: string;
  readonly label: string;
  readonly description?: string;
  readonly sortable?: boolean;
  readonly required?: boolean;
}

export const INTERFACE_SURFACES = {
  threadRow: [
    { id: "project", label: "Project", description: "Icon and name above the title" },
    {
      id: "status",
      label: "Last activity time",
      description: "Attention states like Working or Approval always show",
    },
    { id: "branch", label: "Branch", sortable: true },
    { id: "terminal", label: "Terminal activity", sortable: true },
    {
      id: "pullRequest",
      label: "Pull request",
      description: "Badge and change counts",
      sortable: true,
    },
    { id: "environment", label: "Remote machine", sortable: true },
    { id: "provider", label: "Provider", sortable: true },
  ],
  composerToolbar: [
    {
      id: "traits",
      label: "Model options",
      description: "Effort, speed, and thinking",
      sortable: true,
    },
    { id: "mode", label: "Access and plan mode", sortable: true },
    { id: "attach", label: "Attach files" },
  ],
  composerContextBar: [
    { id: "workspace", label: "Environment and workspace", sortable: true },
    {
      id: "controls",
      label: "Model and mode",
      description: "Shown here while the composer is collapsed",
      sortable: true,
      required: true,
    },
    { id: "branch", label: "Branch", sortable: true },
  ],
  chatHeader: [
    { id: "scripts", label: "Project scripts", sortable: true },
    { id: "openIn", label: "Open in editor", sortable: true },
    { id: "git", label: "Git actions", sortable: true },
  ],
} as const satisfies Record<string, ReadonlyArray<InterfaceElementDefinition>>;

export type InterfaceSurfaceId = keyof typeof INTERFACE_SURFACES;
export type InterfaceElementId<S extends InterfaceSurfaceId> =
  (typeof INTERFACE_SURFACES)[S][number]["id"];

export interface ResolvedSurfaceLayout<S extends InterfaceSurfaceId> {
  /** Every element of the surface, sortable ones in the user's order. */
  readonly order: ReadonlyArray<InterfaceElementId<S>>;
  readonly hidden: ReadonlySet<InterfaceElementId<S>>;
}

function surfaceDefinitions(
  surface: InterfaceSurfaceId,
): ReadonlyArray<InterfaceElementDefinition> {
  return INTERFACE_SURFACES[surface];
}

/**
 * Applies a saved layout to a surface's current elements. Unknown and
 * duplicate ids are dropped, elements the saved order doesn't mention keep
 * their default slot relative to their default neighbours, and fixed
 * elements never move.
 */
export function resolveSurfaceLayout<S extends InterfaceSurfaceId>(
  surface: S,
  layout: InterfaceLayout | undefined,
): ResolvedSurfaceLayout<S> {
  const definitions = surfaceDefinitions(surface);
  const saved = layout?.[surface];
  const sortableIds = definitions
    .filter((element) => element.sortable)
    .map((element) => element.id);
  const sortableSet = new Set(sortableIds);

  const orderedSortable: string[] = [];
  for (const id of saved?.order ?? []) {
    if (sortableSet.has(id) && !orderedSortable.includes(id)) orderedSortable.push(id);
  }
  // Insert elements the saved order predates after the default neighbour
  // that precedes them, so a new element lands where the app would put it.
  sortableIds.forEach((id, defaultIndex) => {
    if (orderedSortable.includes(id)) return;
    const previous = sortableIds
      .slice(0, defaultIndex)
      .findLast((candidate) => orderedSortable.includes(candidate));
    orderedSortable.splice(
      previous === undefined ? 0 : orderedSortable.indexOf(previous) + 1,
      0,
      id,
    );
  });

  let nextSortable = 0;
  const order = definitions.map((element) =>
    element.sortable ? orderedSortable[nextSortable++]! : element.id,
  );
  const requiredIds = new Set(
    definitions.filter((element) => element.required).map((element) => element.id),
  );
  const knownIds = new Set(definitions.map((element) => element.id));
  const hidden = new Set(
    (saved?.hidden ?? []).filter((id) => knownIds.has(id) && !requiredIds.has(id)),
  );
  return {
    order: order as ReadonlyArray<InterfaceElementId<S>>,
    hidden: hidden as ReadonlySet<InterfaceElementId<S>>,
  };
}

/** Whether a surface still matches the app's default arrangement. */
export function isDefaultSurfaceLayout(
  surface: InterfaceSurfaceId,
  layout: InterfaceLayout | undefined,
): boolean {
  const resolved = resolveSurfaceLayout(surface, layout);
  return (
    resolved.hidden.size === 0 &&
    resolved.order.every((id, index) => id === surfaceDefinitions(surface)[index]!.id)
  );
}

function writeSurface(
  layout: InterfaceLayout,
  surface: InterfaceSurfaceId,
  next: InterfaceSurfaceLayout,
): InterfaceLayout {
  const { [surface]: _previous, ...rest } = layout;
  // A surface back at its defaults is removed, keeping the stored value sparse,
  // unless it still carries ids this build ignores (see `currentSurface`).
  const definitions = surfaceDefinitions(surface);
  const carriesIgnoredIds =
    next.order.some(
      (id) => !definitions.some((element) => element.id === id && element.sortable),
    ) ||
    next.hidden.some(
      (id) => !definitions.some((element) => element.id === id && !element.required),
    );
  if (!carriesIgnoredIds && isDefaultSurfaceLayout(surface, { [surface]: next })) return rest;
  return { ...rest, [surface]: next };
}

/**
 * The editable form of a surface: its sortable elements in order, its hidden
 * ids, and `stored`, which turns an edited order back into the stored one.
 * Ids this build ignores, such as elements a newer build added, pass through
 * so an edit here doesn't erase that build's layout: an unknown ordered id
 * stays right after the known element it followed, and unknown hidden ids
 * stay hidden.
 */
function currentSurface(layout: InterfaceLayout, surface: InterfaceSurfaceId) {
  const resolved = resolveSurfaceLayout(surface, layout);
  const saved = layout[surface];
  const sortable = new Set(
    surfaceDefinitions(surface)
      .filter((element) => element.sortable)
      .map((element) => element.id),
  );

  const leading: string[] = [];
  const following = new Map<string, string[]>();
  let anchor: string | null = null;
  for (const id of new Set(saved?.order ?? [])) {
    if (sortable.has(id)) anchor = id;
    else if (anchor === null) leading.push(id);
    else following.set(anchor, [...(following.get(anchor) ?? []), id]);
  }

  return {
    order: resolved.order.filter((id) => sortable.has(id)) as string[],
    // Saved hidden ids are the resolved ones plus the ids this build ignores.
    hidden: [...new Set(saved?.hidden ?? [])],
    stored: (order: ReadonlyArray<string>) => [
      ...leading,
      ...order.flatMap((id) => [id, ...(following.get(id) ?? [])]),
    ],
  };
}

export function setSurfaceElementHidden(
  layout: InterfaceLayout,
  surface: InterfaceSurfaceId,
  elementId: string,
  hidden: boolean,
): InterfaceLayout {
  const current = currentSurface(layout, surface);
  const nextHidden = hidden
    ? [...new Set([...current.hidden, elementId])]
    : current.hidden.filter((id) => id !== elementId);
  return writeSurface(layout, surface, {
    order: current.stored(current.order),
    hidden: nextHidden,
  });
}

/** Moves a sortable element to the position currently held by `overId`. */
export function moveSurfaceElement(
  layout: InterfaceLayout,
  surface: InterfaceSurfaceId,
  activeId: string,
  overId: string,
): InterfaceLayout {
  const current = currentSurface(layout, surface);
  const from = current.order.indexOf(activeId);
  const to = current.order.indexOf(overId);
  if (from === -1 || to === -1 || from === to) return layout;
  const order = [...current.order];
  order.splice(from, 1);
  order.splice(to, 0, activeId);
  return writeSurface(layout, surface, { order: current.stored(order), hidden: current.hidden });
}

/**
 * Moves a sortable element so it sits just before `beforeId`, or after every
 * other sortable element when `beforeId` is null. Drops and arrow keys both
 * describe a destination this way.
 */
export function moveSurfaceElementBefore(
  layout: InterfaceLayout,
  surface: InterfaceSurfaceId,
  activeId: string,
  beforeId: string | null,
): InterfaceLayout {
  const current = currentSurface(layout, surface);
  if (!current.order.includes(activeId) || activeId === beforeId) return layout;
  const order = current.order.filter((id) => id !== activeId);
  const index = beforeId === null ? order.length : order.indexOf(beforeId);
  if (index === -1) return layout;
  order.splice(index, 0, activeId);
  if (order.every((id, position) => id === current.order[position])) return layout;
  return writeSurface(layout, surface, { order: current.stored(order), hidden: current.hidden });
}

export function resetSurfaceLayout(
  layout: InterfaceLayout,
  surface: InterfaceSurfaceId,
): InterfaceLayout {
  const { [surface]: _previous, ...rest } = layout;
  return rest;
}

/**
 * Splits an order into runs, gathering adjacent members of `grouped` into one
 * array so a surface can keep tightly spaced elements in a shared wrapper.
 */
export function groupAdjacentElements<Id extends string>(
  order: ReadonlyArray<Id>,
  grouped: ReadonlySet<Id>,
): Array<Id | Id[]> {
  const runs: Array<Id | Id[]> = [];
  for (const id of order) {
    const last = runs.at(-1);
    if (!grouped.has(id)) runs.push(id);
    else if (Array.isArray(last)) last.push(id);
    else runs.push([id]);
  }
  return runs;
}

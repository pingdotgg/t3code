import {
  conversationSummarySourceIdentity,
  conversationSummarySourceKey,
  type ConversationSummaryRangeRef,
  type ConversationSummarySourceRef,
} from "@t3tools/contracts";

import { sourcesCoverWholeItems } from "./conversationSummarySources.ts";

/** One roll-up call absorbs exactly this many adjacent summaries. */
const CONDENSE_FAN_IN = 4;

/** What the tree needs from a stored row. Statements are not loaded. */
export interface StoredSummary {
  readonly id: string;
  readonly sources: ReadonlyArray<ConversationSummarySourceRef>;
  readonly scrubbed: boolean;
  readonly position: string;
}

/** A current summary with its derived structure. Depth and leaf ranges are never stored. */
export interface SummaryNode {
  readonly row: StoredSummary;
  readonly depth: number;
  readonly children: ReadonlyArray<SummaryNode>;
  /** The exact message and tool ranges beneath this summary, in conversation order. */
  readonly leafSources: ReadonlyArray<ConversationSummaryRangeRef>;
}

export interface SummaryTree {
  /** Current summaries that no current summary absorbs, in conversation order. */
  readonly roots: ReadonlyArray<SummaryNode>;
  /** Stored summaries that are not current: scrubbed, or with a missing or non-current child. */
  readonly dead: ReadonlyArray<StoredSummary>;
}

export const isRangeRef = (
  source: ConversationSummarySourceRef,
): source is ConversationSummaryRangeRef => source.kind !== "summary";

export const childIds = (row: StoredSummary): ReadonlyArray<string> =>
  row.sources.flatMap((source) => (source.kind === "summary" ? [source.summaryId] : []));

const DEPTH_WIDTH = 2;
const MAX_DEPTH = 10 ** DEPTH_WIDTH - 1;

/**
 * Conversation-order sort key: the first range's time, identity and offset, then coarse before
 * fine. Within one thread ISO times have a fixed width, so the key sorts as text.
 */
export function leafPosition(createdAt: string, first: ConversationSummaryRangeRef): string {
  const start = String(first.range?.start ?? 0).padStart(12, "0");
  return `${createdAt}\u0001${conversationSummarySourceIdentity(first)}\u0001${start}\u0001${MAX_DEPTH}`;
}

/** A parent starts where its first child starts and sorts before it. */
export function condensedPosition(firstChild: string, depth: number): string {
  return `${firstChild.slice(0, -DEPTH_WIDTH)}${String(MAX_DEPTH - depth).padStart(DEPTH_WIDTH, "0")}`;
}

const byPosition = (left: SummaryNode, right: SummaryNode) =>
  left.row.position < right.row.position
    ? -1
    : left.row.position > right.row.position
      ? 1
      : left.row.id < right.row.id
        ? -1
        : 1;

/**
 * The forest of current summaries. `isCurrentLeaf` is the caller's check of a leaf's ranges: the
 * pass compares digests, a read compares re-read sources. A child claimed by two current parents
 * (two passes that raced) stays with the parent seen first, and the other parent is dead.
 */
export function buildSummaryTree(
  rows: ReadonlyArray<StoredSummary>,
  isCurrentLeaf: (row: StoredSummary) => boolean,
): SummaryTree {
  const byId = new Map(rows.map((row) => [row.id, row]));
  const depths = new Map<string, number>();
  const depthOf = (row: StoredSummary, seen: ReadonlySet<string>): number => {
    const known = depths.get(row.id);
    if (known !== undefined) return known;
    let depth = 0;
    for (const id of childIds(row)) {
      const child = byId.get(id);
      if (child !== undefined && !seen.has(id))
        depth = Math.max(depth, depthOf(child, new Set([...seen, id])) + 1);
    }
    depths.set(row.id, depth);
    return depth;
  };
  const ordered = rows
    .map((row) => ({ row, depth: depthOf(row, new Set([row.id])) }))
    .toSorted((a, b) => a.depth - b.depth || (a.row.id < b.row.id ? -1 : 1));
  const current = new Map<string, SummaryNode>();
  const claimed = new Set<string>();
  for (const { row, depth } of ordered) {
    if (row.scrubbed) continue;
    const ids = childIds(row);
    if (ids.length === 0) {
      if (isCurrentLeaf(row))
        current.set(row.id, {
          row,
          depth: 0,
          children: [],
          leafSources: row.sources.filter(isRangeRef),
        });
      continue;
    }
    const children = ids.map((id) => current.get(id));
    if (children.some((child) => child === undefined || claimed.has(child.row.id))) continue;
    const present = children as ReadonlyArray<SummaryNode>;
    for (const child of present) claimed.add(child.row.id);
    current.set(row.id, {
      row,
      depth,
      children: present,
      leafSources: present.flatMap((child) => child.leafSources),
    });
  }
  return {
    roots: [...current.values()].filter((node) => !claimed.has(node.row.id)).toSorted(byPosition),
    dead: rows.filter((row) => !current.has(row.id)),
  };
}

/**
 * Current roots whose ranges all end before the first uncovered source. A gap splits the forest,
 * so a roll-up cannot join the neighbours of a missing leaf. Skipped sources will get no leaf, so
 * they split nothing.
 */
export function rootsBeforeFirstGap(input: {
  readonly roots: ReadonlyArray<SummaryNode>;
  readonly order: ReadonlyArray<string>;
  readonly covered: ReadonlySet<string>;
  readonly skipped: ReadonlySet<string>;
}): ReadonlyArray<SummaryNode> {
  const gapAt = input.order.findIndex((key) => !input.covered.has(key) && !input.skipped.has(key));
  if (gapAt === -1) return input.roots;
  const indexByKey = new Map(input.order.map((key, index) => [key, index]));
  const prefix: Array<SummaryNode> = [];
  for (const root of input.roots) {
    const positions = root.leafSources.map((source) =>
      indexByKey.get(conversationSummarySourceKey(source)),
    );
    if (
      positions.length === 0 ||
      positions.some((position) => position === undefined || position >= gapAt)
    )
      break;
    prefix.push(root);
  }
  return prefix;
}

/**
 * The next roots to condense, or null. It takes the oldest run of four adjacent roots in which at
 * least three share the run's greatest depth, preferring the lowest such depth. That keeps depth
 * near log4 of the leaf count. Three of four, rather than four of one depth, lets the odd root a
 * replaced leaf leaves behind join a coarser level instead of blocking it.
 */
export function planCondensation(
  roots: ReadonlyArray<SummaryNode>,
  accept: (group: ReadonlyArray<SummaryNode>) => boolean = () => true,
): ReadonlyArray<SummaryNode> | null {
  let best: { readonly start: number; readonly depth: number } | null = null;
  for (let start = 0; start + CONDENSE_FAN_IN <= roots.length; start++) {
    const run = roots.slice(start, start + CONDENSE_FAN_IN);
    const depth = Math.max(...run.map((node) => node.depth));
    if (
      run.filter((node) => node.depth === depth).length >= CONDENSE_FAN_IN - 1 &&
      accept(run) &&
      (best === null || depth < best.depth)
    )
      best = { start, depth };
  }
  return best === null ? null : roots.slice(best.start, best.start + CONDENSE_FAN_IN);
}

/** One handoff offer: summaries that must travel together, and the exact ranges beneath them. */
export interface CoverGroup {
  readonly nodes: ReadonlyArray<SummaryNode>;
  readonly identities: ReadonlySet<string>;
}

const identitiesOf = (nodes: ReadonlyArray<SummaryNode>) =>
  new Set(nodes.flatMap((node) => node.leafSources.map(conversationSummarySourceIdentity)));

// Summaries that share a split source form one offer. Omitting the item after only one of its
// ranges was summarized would silently discard the remaining evidence.
function groupBySharedSource(nodes: ReadonlyArray<SummaryNode>): Array<CoverGroup> {
  const groups: Array<{ nodes: Array<SummaryNode>; identities: Set<string> }> = [];
  for (const node of nodes) {
    const group = { nodes: [node], identities: identitiesOf([node]) };
    for (let index = groups.length - 1; index >= 0; index--) {
      const previous = groups[index]!;
      if (![...previous.identities].some((id) => group.identities.has(id))) continue;
      group.nodes.unshift(...previous.nodes);
      for (const id of previous.identities) group.identities.add(id);
      groups.splice(index, 1);
    }
    groups.push(group);
  }
  return groups;
}

/**
 * The coarsest current summaries a handoff may use, in conversation order. A summary citing an
 * ineligible item, or sharing an item that the cover does not complete, gives way to its
 * children. Every group cites at least one requested item.
 */
export function handoffCover(input: {
  readonly roots: ReadonlyArray<SummaryNode>;
  readonly eligible: (identity: string) => boolean;
  readonly requested: (identity: string) => boolean;
}): ReadonlyArray<CoverGroup> {
  const usable = (node: SummaryNode): ReadonlyArray<SummaryNode> =>
    node.leafSources.every((source) => input.eligible(conversationSummarySourceIdentity(source)))
      ? [node]
      : node.children.flatMap(usable);
  let frontier = input.roots
    .flatMap(usable)
    .filter((node) =>
      node.leafSources.some((source) => input.requested(conversationSummarySourceIdentity(source))),
    );
  while (true) {
    const groups = groupBySharedSource(frontier);
    const incomplete = new Set(
      groups
        .filter((group) => !sourcesCoverWholeItems(group.nodes.flatMap((node) => node.leafSources)))
        .flatMap((group) => group.nodes),
    );
    if (![...incomplete].some((node) => node.depth > 0))
      return groups.filter((group) => !group.nodes.some((node) => incomplete.has(node)));
    frontier = frontier.flatMap((node) =>
      incomplete.has(node) && node.depth > 0
        ? node.children.filter((child) =>
            child.leafSources.some((source) =>
              input.requested(conversationSummarySourceIdentity(source)),
            ),
          )
        : [node],
    );
  }
}

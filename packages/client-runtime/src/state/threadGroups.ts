// A thread renders under the thread it is grouped under: the thread whose
// agent launched it through T3 MCP tools, or one the user grouped it with.
// This is a view over `groupedUnderThreadId`: each thread keeps its own
// section, actions, and order. Web and mobile thread lists share it.

export interface ThreadGroupRow<T, S extends string> {
  readonly thread: T;
  readonly key: string;
  /** The thread's own section. It picks the row look and its actions. */
  readonly section: S;
  /** The group's top thread this row renders under; null for top-level rows. */
  readonly rootKey: string | null;
}

/** One top-level row, or a group's top thread followed by its other threads. */
export interface ThreadGroupBlock<T, S extends string> {
  /** The top thread's key. */
  readonly key: string;
  /** The row whose place in its section orders the block: the top thread,
      or the live thread the group moved to. */
  readonly leadKey: string;
  readonly rows: readonly ThreadGroupRow<T, S>[];
}

export type ThreadGroupLayout<T, S extends string> = Readonly<
  Record<S, readonly ThreadGroupBlock<T, S>[]>
>;

/**
 * Groups each section's threads into blocks. A group renders where its top
 * thread renders. When the top thread is in a parked section (snoozed,
 * settled) but a grouped thread is live, the group moves to one live
 * thread's place, so live work never hides in a shelf. Chains join the top group.
 * Threads grouped under a thread outside the given sections stay top-level.
 */
export function layoutThreadGroups<T, S extends string>(input: {
  /** Every section, in display order. */
  readonly sections: Readonly<Record<S, readonly T[]>>;
  readonly order: readonly S[];
  /** Sections a group may move to when its top thread is parked. */
  readonly live: ReadonlySet<S>;
  readonly keyOf: (thread: T) => string;
  readonly groupKeyOf: (thread: T) => string | null;
}): ThreadGroupLayout<T, S> {
  const ordered: ThreadGroupRow<T, S>[] = [];
  const rowByKey = new Map<string, ThreadGroupRow<T, S>>();
  for (const section of input.order) {
    for (const thread of input.sections[section]) {
      const row = { thread, key: input.keyOf(thread), section, rootKey: null };
      ordered.push(row);
      rowByKey.set(row.key, row);
    }
  }

  const rootOf = (key: string): string => {
    const seen = new Set([key]);
    let current = key;
    for (;;) {
      const parent = input.groupKeyOf(rowByKey.get(current)!.thread);
      if (parent === null || !rowByKey.has(parent)) return current;
      // A cycle has no top, so its threads stay top-level.
      if (seen.has(parent)) return key;
      seen.add(parent);
      current = parent;
    }
  };

  const childrenByRoot = new Map<string, ThreadGroupRow<T, S>[]>();
  const grouped = new Set<string>();
  for (const row of ordered) {
    const rootKey = rootOf(row.key);
    if (rootKey === row.key) continue;
    grouped.add(row.key);
    const children = childrenByRoot.get(rootKey) ?? [];
    children.push({ ...row, rootKey });
    childrenByRoot.set(rootKey, children);
  }

  // A parked top thread's group anchors to one live thread, picked by
  // section and then by key, never by order. Moving the anchor moves the
  // group; if order picked it, the next live thread would take its place.
  const sectionRank = new Map(input.order.map((section, index) => [section, index]));
  const rootByAnchor = new Map<string, string>();
  for (const [rootKey, children] of childrenByRoot) {
    let anchor = rootKey;
    if (!input.live.has(rowByKey.get(rootKey)!.section)) {
      let best: ThreadGroupRow<T, S> | undefined;
      for (const child of children) {
        if (!input.live.has(child.section)) continue;
        if (
          best === undefined ||
          sectionRank.get(child.section)! < sectionRank.get(best.section)! ||
          (child.section === best.section && child.key < best.key)
        ) {
          best = child;
        }
      }
      anchor = best?.key ?? rootKey;
    }
    rootByAnchor.set(anchor, rootKey);
  }

  const layout = {} as Record<S, ThreadGroupBlock<T, S>[]>;
  for (const section of input.order) layout[section] = [];
  for (const row of ordered) {
    const rootKey = rootByAnchor.get(row.key);
    if (rootKey !== undefined) {
      layout[row.section].push({
        key: rootKey,
        leadKey: row.key,
        rows: [rowByKey.get(rootKey)!, ...childrenByRoot.get(rootKey)!],
      });
    } else if (!grouped.has(row.key) && !childrenByRoot.has(row.key)) {
      layout[row.section].push({ key: row.key, leadKey: row.key, rows: [row] });
    }
  }
  return layout;
}

/** What a collapsed shelf shows: only the open thread's row, on its own. */
export function routeRowOnly<T, S extends string>(
  blocks: readonly ThreadGroupBlock<T, S>[],
  routeKey: string | null,
): ThreadGroupBlock<T, S>[] {
  if (routeKey === null) return [];
  for (const block of blocks) {
    const row = block.rows.find((candidate) => candidate.key === routeKey);
    if (row !== undefined) {
      return [{ key: row.key, leadKey: row.key, rows: [{ ...row, rootKey: null }] }];
    }
  }
  return [];
}

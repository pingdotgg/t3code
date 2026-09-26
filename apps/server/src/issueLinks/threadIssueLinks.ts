import {
  type IssueKey,
  type ThreadIssueLink,
  type ThreadIssueLinkSource,
  issueKeyString,
  issueUrlFor,
} from "@t3tools/contracts";

/** A stored row. `dismissed` is the tombstone left when a user or agent removes a link. */
export type StoredIssueLinkSource = "manual" | "agent" | "started" | "dismissed";

export interface StoredIssueLink {
  readonly key: IssueKey;
  readonly url: string;
  readonly source: StoredIssueLinkSource;
  readonly linkedAt: string;
}

export interface DerivedIssueLink {
  readonly key: IssueKey;
  readonly source: Extract<ThreadIssueLinkSource, "branch" | "closing-reference">;
}

/**
 * A thread's visible Issue links: stored links first, in link order, then derived ones. A link
 * holding for several reasons appears once with every source; a dismissed Issue does not appear,
 * whatever still derives it.
 */
export function combineThreadIssueLinks(
  stored: ReadonlyArray<StoredIssueLink>,
  derived: ReadonlyArray<DerivedIssueLink>,
): ReadonlyArray<ThreadIssueLink> {
  const dismissed = new Set(
    stored.filter((link) => link.source === "dismissed").map((link) => issueKeyString(link.key)),
  );
  const byKey = new Map<string, { -readonly [K in keyof ThreadIssueLink]: ThreadIssueLink[K] }>();
  const ordered = stored
    .filter((link) => link.source !== "dismissed")
    .toSorted((left, right) => left.linkedAt.localeCompare(right.linkedAt));
  for (const link of ordered) {
    const id = issueKeyString(link.key);
    if (dismissed.has(id) || byKey.has(id)) continue;
    byKey.set(id, {
      ...normalizeKey(link.key),
      url: link.url,
      sources: [link.source as ThreadIssueLinkSource],
      linkedAt: link.linkedAt,
    });
  }
  for (const link of derived) {
    const id = issueKeyString(link.key);
    if (dismissed.has(id)) continue;
    const existing = byKey.get(id);
    if (existing === undefined) {
      const key = normalizeKey(link.key);
      byKey.set(id, { ...key, url: issueUrlFor(key), sources: [link.source], linkedAt: null });
    } else if (!existing.sources.includes(link.source)) {
      existing.sources = [...existing.sources, link.source];
    }
  }
  return [...byKey.values()];
}

function normalizeKey(key: IssueKey): IssueKey {
  return {
    host: key.host.toLowerCase(),
    repository: key.repository.toLowerCase(),
    number: key.number,
  };
}

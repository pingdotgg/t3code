import type {
  LinkedPullRequestSort,
  LinkedPullRequestStatus,
  ThreadPullRequestLink,
} from "@t3tools/contracts";
import type {
  PullRequestListLine,
  ThreadPullRequestChain,
} from "@t3tools/client-runtime/thread-pull-requests";

export const LINKED_PULL_REQUEST_STATUS_ORDER: ReadonlyArray<LinkedPullRequestStatus> = [
  "draft",
  "open",
  "merged",
  "closed",
];

export const LINKED_PULL_REQUEST_STATUS_LABELS: Record<LinkedPullRequestStatus, string> = {
  draft: "Draft",
  open: "Open",
  merged: "Merged",
  closed: "Closed",
};

export interface LinkedPullRequestView {
  readonly sort: LinkedPullRequestSort;
  readonly hiddenStatuses: ReadonlyArray<LinkedPullRequestStatus>;
  readonly groupStacks: boolean;
}

export type LinkedPullRequestRow =
  | {
      readonly kind: "header";
      readonly key: string;
      readonly label: string;
      readonly count: number;
    }
  | {
      readonly kind: "line";
      readonly key: string;
      readonly line: PullRequestListLine;
      /** 1-based place in its stack when stacks are flattened. */
      readonly position: number | null;
      readonly dimmed: boolean;
    }
  | { readonly kind: "hidden"; readonly key: string; readonly count: number };

export function linkedPullRequestStatus(link: ThreadPullRequestLink): LinkedPullRequestStatus {
  const snapshot = link.snapshot;
  if (snapshot === null) return "open";
  if (snapshot.state === "open") return snapshot.isDraft ? "draft" : "open";
  return snapshot.state;
}

const isOpen = (link: ThreadPullRequestLink) =>
  link.snapshot === null || link.snapshot.state === "open";

const rank = (link: ThreadPullRequestLink) =>
  LINKED_PULL_REQUEST_STATUS_ORDER.indexOf(linkedPullRequestStatus(link));

function timeOf(value: string | null | undefined): number {
  const ms = value ? Date.parse(value) : Number.NaN;
  return Number.isNaN(ms) ? 0 : ms;
}

const linkKey = (link: ThreadPullRequestLink) => `${link.host}/${link.repository}#${link.number}`;

interface Unit {
  readonly chain: ThreadPullRequestChain;
  readonly key: string;
  readonly rank: number;
  readonly repository: string;
  readonly updatedAt: number;
  readonly linkedAt: number;
  /** Set when a stack is flattened into one unit per layer. */
  readonly layerOf: { readonly position: number; readonly size: number } | null;
}

export function linkedPullRequestRows(
  chains: ReadonlyArray<ThreadPullRequestChain>,
  view: LinkedPullRequestView,
): ReadonlyArray<LinkedPullRequestRow> {
  const hidden = new Set(view.hiddenStatuses);
  const isHidden = (link: ThreadPullRequestLink) => hidden.has(linkedPullRequestStatus(link));
  const units: Array<Unit> = [];
  let hiddenCount = 0;
  const addUnit = (chain: ThreadPullRequestChain, layerOf: Unit["layerOf"]) => {
    const shown = chain.layers.filter((link) => !isHidden(link));
    if (shown.length === 0) {
      hiddenCount += chain.layers.length;
      return;
    }
    const base = chain.layers[0]!;
    units.push({
      chain,
      key: linkKey(base),
      // A stack sorts with its least finished visible layer.
      rank: Math.min(...shown.map(rank)),
      repository: `${base.host}/${base.repository}`,
      updatedAt: Math.max(
        ...chain.layers.map((link) => timeOf(link.snapshot?.updatedAt ?? link.linkedAt)),
      ),
      linkedAt: Math.max(...chain.layers.map((link) => timeOf(link.linkedAt))),
      layerOf,
    });
  };
  for (const chain of chains) {
    if (view.groupStacks || chain.layers.length === 1) {
      addUnit(chain, null);
      continue;
    }
    chain.layers.forEach((link, index) =>
      addUnit(
        { kind: chain.kind, layers: [link], depths: [0] },
        { position: index + 1, size: chain.layers.length },
      ),
    );
  }

  const byUpdated = (left: Unit, right: Unit) => right.updatedAt - left.updatedAt;
  const compare: Record<LinkedPullRequestSort, (left: Unit, right: Unit) => number> = {
    status: (left, right) => left.rank - right.rank || byUpdated(left, right),
    updated: byUpdated,
    linked: (left, right) => right.linkedAt - left.linkedAt,
    repository: (left, right) =>
      left.repository.localeCompare(right.repository) || byUpdated(left, right),
  };
  units.sort(compare[view.sort]);

  const groupOf = (unit: Unit): { key: string; label: string } | null =>
    view.sort === "status"
      ? {
          key: LINKED_PULL_REQUEST_STATUS_ORDER[unit.rank]!,
          label: LINKED_PULL_REQUEST_STATUS_LABELS[LINKED_PULL_REQUEST_STATUS_ORDER[unit.rank]!],
        }
      : view.sort === "repository"
        ? { key: unit.repository, label: unit.repository.slice(unit.repository.indexOf("/") + 1) }
        : null;

  const rows: Array<LinkedPullRequestRow> = [];
  let header: { kind: "header"; key: string; label: string; count: number } | null = null;
  for (const unit of units) {
    const group = groupOf(unit);
    if (group !== null && header?.key !== `header:${group.key}`) {
      header = { kind: "header", key: `header:${group.key}`, label: group.label, count: 0 };
      rows.push(header);
    }
    if (header !== null) header.count += unit.chain.layers.length;
    const size = unit.layerOf?.size ?? unit.chain.layers.length;
    unit.chain.layers.forEach((link, index) => {
      rows.push({
        kind: "line",
        key: linkKey(link),
        line: {
          link,
          depth: unit.chain.depths[index]!,
          chainKey: unit.key,
          stack: index === 0 && size > 1 ? { kind: unit.chain.kind, size } : null,
        },
        position: unit.layerOf?.position ?? null,
        dimmed: isHidden(link) || (rank(link) > unit.rank && !isOpen(link)),
      });
    });
  }
  if (hiddenCount > 0) rows.push({ kind: "hidden", key: "hidden", count: hiddenCount });
  return rows;
}

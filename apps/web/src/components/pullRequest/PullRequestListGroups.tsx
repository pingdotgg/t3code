import type { EnvironmentId, PullRequestAction } from "@t3tools/contracts";
import { useMessages } from "gt-react";
import { useDeferredValue, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import {
  pullRequestEntryKey,
  scorePullRequestMatch,
  type EnvironmentPullRequestEntry,
  type PullRequestGroup,
} from "./pullRequestList.logic";
import { PullRequestRow, type PullRequestRowTarget } from "./PullRequestRow";
import {
  PullRequestSpeedModeProvider,
  type PullRequestSpeedActionResult,
} from "./PullRequestSpeedActions";

const MATCHED_ELSEWHERE_SCORE = 10;
const FIRST_PAINT_ROWS = 24;

function firstPaintGroups<Group extends { entries: ReadonlyArray<unknown> }>(
  groups: ReadonlyArray<Group>,
): ReadonlyArray<Group> {
  let left = FIRST_PAINT_ROWS;
  return groups.flatMap((group) => {
    const entries = group.entries.slice(0, left);
    left -= entries.length;
    return entries.length === 0 ? [] : [{ ...group, entries }];
  });
}

function PullRequestGroupHeader({
  group,
  count,
}: {
  group: { key: string; label: string };
  count: number;
}) {
  const resolve = useMessages();
  // Nick 2026-11-19: the section title is the label and count, no icon.
  return (
    // Label · count, one size and weight (Nick 2026-11-19); the dot is the rows' meta separator.
    <div className="flex items-center gap-1.5 px-3 pb-1.5 text-ui leading-5 font-medium text-muted-foreground">
      <h2 className="shrink-0">{resolve(group.label)}</h2>
      <span aria-hidden className="text-muted-foreground/50">
        ·
      </span>
      <span className="shrink-0 tabular-nums">{count}</span>
    </div>
  );
}

export function PullRequestListGroups({
  groups,
  environmentLabels,
  query,
  selected,
  showProvider,
  statsRef,
  onSelect,
  onIntent,
  hostActionsOf,
  onActed,
  closingKeys,
  sweepingKeys,
  onCloseSweepStart,
}: {
  groups: ReadonlyArray<PullRequestGroup<EnvironmentPullRequestEntry>>;
  /** Only when rows come from more than one server, so each says which. */
  environmentLabels: ReadonlyMap<EnvironmentId, string> | null;
  query: string;
  selected: {
    readonly environmentId: string | undefined;
    readonly repository: string;
    readonly host: string | undefined;
    readonly number: number;
  } | null;
  showProvider: boolean;
  statsRef: RefCallback<HTMLDivElement>;
  onSelect: (entry: PullRequestRowTarget) => void;
  onIntent: (entry: PullRequestRowTarget | null) => void;
  hostActionsOf: (entry: EnvironmentPullRequestEntry) => ReadonlySet<PullRequestAction>;
  onActed: (result: PullRequestSpeedActionResult) => void;
  closingKeys: ReadonlySet<string>;
  sweepingKeys: ReadonlySet<string>;
  onCloseSweepStart: (entry: EnvironmentPullRequestEntry, event: PointerEvent) => void;
}) {
  // Every row mounts tooltips and actions; painting a first screenful before the rest keeps
  // opening the page from blocking on the whole list.
  const shownGroups = useDeferredValue(groups, firstPaintGroups(groups));
  const counts = new Map(groups.map((group) => [group.key, group.entries.length]));
  return (
    <PullRequestSpeedModeProvider>
      {/* Sections run edge to edge of the card (-mx-2 undoes the page's side inset), each after the
          first under a full-width divider: 14px from the last row's text above, 14px to the heading. */}
      <div className={cn("-mx-2 flex flex-col", sweepingKeys.size > 0 && "**:pointer-events-none")}>
        {shownGroups.map((group, index) => (
          <div
            key={group.key}
            className={cn(
              "space-y-0.5 px-1",
              index > 0 && "mt-1 border-t border-(--shell-divider) pt-3.5",
            )}
          >
            {group.label ? (
              <PullRequestGroupHeader
                group={group}
                count={counts.get(group.key) ?? group.entries.length}
              />
            ) : null}
            {group.entries.map((entry) => {
              const entryKey = pullRequestEntryKey(entry);
              const environmentLabel = environmentLabels?.get(entry.environmentId);
              return (
                <PullRequestRow
                  key={entryKey}
                  statsKey={entryKey}
                  statsRef={statsRef}
                  entry={entry}
                  showProjectTitle
                  showProvider={showProvider}
                  {...(environmentLabel !== undefined ? { environmentLabel } : {})}
                  matchedElsewhere={
                    query.length > 0 &&
                    scorePullRequestMatch(entry, query) <= MATCHED_ELSEWHERE_SCORE
                  }
                  selected={
                    selected?.environmentId === entry.environmentId &&
                    selected.repository === entry.repository &&
                    selected.host?.toLowerCase() === entry.host.toLowerCase() &&
                    selected.number === entry.number
                  }
                  onSelect={onSelect}
                  onIntent={onIntent}
                  hostActions={hostActionsOf(entry)}
                  onActed={onActed}
                  closing={closingKeys.has(entryKey)}
                  sweeping={sweepingKeys.has(entryKey)}
                  onCloseSweepStart={onCloseSweepStart}
                />
              );
            })}
          </div>
        ))}
      </div>
    </PullRequestSpeedModeProvider>
  );
}

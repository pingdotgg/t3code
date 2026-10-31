import type { EnvironmentId, PullRequestAction } from "@t3tools/contracts";
import { EyeIcon, LayersIcon, PenLineIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { useDeferredValue, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import { Separator } from "../ui/separator";
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

const GROUP_ICONS: Record<string, LucideIcon> = {
  authored: PenLineIcon,
  reviewRequested: EyeIcon,
  others: UsersIcon,
};

const MATCHED_ELSEWHERE_SCORE = 10;
const FIRST_PAINT_ROWS = 24;

function firstPaintGroups<Group extends { entries: ReadonlyArray<unknown> }>(
  groups: ReadonlyArray<Group>,
): ReadonlyArray<Group> {
  let left = FIRST_PAINT_ROWS;
  return groups.map((group) => {
    const entries = group.entries.slice(0, left);
    left -= entries.length;
    return { ...group, entries };
  });
}

function PullRequestGroupHeader({
  group,
  count,
}: {
  group: { key: string; label: string };
  count: number;
}) {
  const Icon = GROUP_ICONS[group.key] ?? LayersIcon;
  return (
    <div className="flex items-center gap-2 px-3 pb-1 text-xs font-medium text-muted-foreground/70">
      <Icon aria-hidden className="size-3.5 shrink-0" />
      <h2 className="shrink-0">{group.label}</h2>
      <span className="shrink-0 tabular-nums text-muted-foreground/50">{count}</span>
      <Separator className="min-w-2 flex-1" />
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
      <div className={cn("space-y-3", sweepingKeys.size > 0 && "**:pointer-events-none")}>
        {shownGroups.map((group) => (
          <div key={group.key} className="space-y-0.5">
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

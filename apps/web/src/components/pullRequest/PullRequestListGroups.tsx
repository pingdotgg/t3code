import type { EnvironmentId, PullRequestAction } from "@t3tools/contracts";
import { EyeIcon, LayersIcon, PenLineIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { Fragment, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import { Separator } from "../ui/separator";
import {
  clusterPullRequestStacks,
  pullRequestEntryKey,
  scorePullRequestMatch,
  type EnvironmentPullRequestEntry,
  type PullRequestGroup,
} from "./pullRequestList.logic";
import { PullRequestStackGroup } from "./PullRequestStackGroup";
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

function PullRequestGroupHeader({
  group,
}: {
  group: { key: string; label: string; entries: ReadonlyArray<unknown> };
}) {
  const Icon = GROUP_ICONS[group.key] ?? LayersIcon;
  // The icon sits in the rows' 16px glyph column and the label on their title line.
  return (
    <div className="flex h-7 items-center gap-2 px-3 text-xs font-medium text-muted-foreground">
      <span className="me-1 flex w-4 shrink-0 justify-center">
        <Icon aria-hidden className="size-3.25" />
      </span>
      <h2 className="shrink-0">{group.label}</h2>
      <span className="shrink-0 tabular-nums font-normal text-dim-foreground">
        {group.entries.length}
      </span>
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
  hostActionsOf: (entry: EnvironmentPullRequestEntry) => ReadonlySet<PullRequestAction>;
  onActed: (result: PullRequestSpeedActionResult) => void;
  closingKeys: ReadonlySet<string>;
  sweepingKeys: ReadonlySet<string>;
  onCloseSweepStart: (entry: EnvironmentPullRequestEntry, event: PointerEvent) => void;
}) {
  const isSelectedEntry = (entry: EnvironmentPullRequestEntry) =>
    selected?.environmentId === entry.environmentId &&
    selected.repository === entry.repository &&
    selected.host?.toLowerCase() === entry.host.toLowerCase() &&
    selected.number === entry.number;
  const rowPropsFor = (entry: EnvironmentPullRequestEntry) => {
    const entryKey = pullRequestEntryKey(entry);
    const environmentLabel = environmentLabels?.get(entry.environmentId);
    return {
      statsKey: entryKey,
      statsRef,
      hostActions: hostActionsOf(entry),
      onActed,
      showProjectTitle: true,
      showProvider,
      ...(environmentLabel === undefined ? {} : { environmentLabel }),
      // Ten is the floor the ranking gives a row whose own fields say nothing about the
      // search: the host matched something this row cannot show.
      matchedElsewhere:
        query.length > 0 && scorePullRequestMatch(entry, query) <= MATCHED_ELSEWHERE_SCORE,
      onSelect,
      closing: closingKeys.has(entryKey),
      sweeping: sweepingKeys.has(entryKey),
      onCloseSweepStart,
    };
  };
  return (
    <PullRequestSpeedModeProvider>
      <div className={cn("flex flex-col gap-3", sweepingKeys.size > 0 && "**:pointer-events-none")}>
        {groups.map((group) => (
          <div key={group.key} className="flex flex-col">
            {group.label ? <PullRequestGroupHeader group={group} /> : null}
            {clusterPullRequestStacks(group.entries).map((item, index) => (
              <Fragment key={item.kind === "row" ? pullRequestEntryKey(item.entry) : item.key}>
                {index > 0 ? <Separator /> : null}
                {item.kind === "row" ? (
                  <PullRequestRow
                    {...rowPropsFor(item.entry)}
                    entry={item.entry}
                    selected={isSelectedEntry(item.entry)}
                  />
                ) : (
                  <PullRequestStackGroup
                    entries={item.entries}
                    isSelected={isSelectedEntry}
                    rowProps={rowPropsFor}
                  />
                )}
              </Fragment>
            ))}
          </div>
        ))}
      </div>
    </PullRequestSpeedModeProvider>
  );
}

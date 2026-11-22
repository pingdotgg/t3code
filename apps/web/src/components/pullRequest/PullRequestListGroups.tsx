import type { EnvironmentId, PullRequestAction } from "@t3tools/contracts";
import { EyeIcon, LayersIcon, PenLineIcon, UsersIcon, type LucideIcon } from "lucide-react";
import { useMessages } from "gt-react";
import { type ElementType, type ReactNode, type RefCallback } from "react";

import { cn } from "~/lib/utils";
import { Separator } from "../ui/separator";
import {
  clusterPullRequestStacks,
  pullRequestEntryKey,
  scorePullRequestMatch,
  type EnvironmentPullRequestEntry,
  type PullRequestGroup,
} from "./pullRequestList.logic";
import { WorkItemWindowedList, type WorkItemListItem } from "../workItem/WorkItemWindowedList";
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

/** A page list's group heading, shared by the pull request and issue lists. */
export function WorkItemGroupHeader({
  icon: Icon,
  label,
  count,
}: {
  icon: ElementType<{ className?: string; "aria-hidden"?: boolean }>;
  label: ReactNode;
  /** A number, or a short phrase such as how many projects a tracker serves. */
  count: ReactNode;
}) {
  // The icon sits in the rows' 16px glyph column and the label on their title line.
  return (
    <div className="flex h-7 items-center gap-2 px-3 text-xs font-medium text-muted-foreground">
      <span className="me-1 flex w-4 shrink-0 justify-center">
        <Icon aria-hidden className="size-3.25" />
      </span>
      <h2 className="flex min-w-0 shrink items-center gap-2 truncate">{label}</h2>
      <span className="shrink-0 tabular-nums font-normal text-dim-foreground">{count}</span>
      <Separator className="min-w-2 flex-1" />
    </div>
  );
}

function PullRequestGroupHeader({
  group,
  count,
}: {
  group: { key: string; label: string };
  count: number;
}) {
  const resolve = useMessages();
  return (
    <WorkItemGroupHeader
      icon={GROUP_ICONS[group.key] ?? LayersIcon}
      label={resolve(group.label)}
      count={count}
    />
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
  scrollElement,
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
  /** The page's scroller, which the windowed rows follow. */
  scrollElement: HTMLElement | null;
}) {
  const counts = new Map(groups.map((group) => [group.key, group.entries.length]));
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
      onIntent,
      closing: closingKeys.has(entryKey),
      sweeping: sweepingKeys.has(entryKey),
      onCloseSweepStart,
    };
  };

  // Flat, so only the rows near the view mount; a group's gap rides on its heading.
  const items: WorkItemListItem[] = groups.flatMap((group, groupIndex) => [
    ...(group.label
      ? [
          {
            key: `group:${group.key}`,
            type: groupIndex > 0 ? "header:gap" : "header",
            node: (
              <div className={groupIndex > 0 ? "pt-3" : undefined}>
                <PullRequestGroupHeader
                  group={group}
                  count={counts.get(group.key) ?? group.entries.length}
                />
              </div>
            ),
          },
        ]
      : []),
    ...clusterPullRequestStacks(group.entries).map((item, index) => ({
      key: `${group.key}:${item.kind === "row" ? pullRequestEntryKey(item.entry) : `stack:${item.key}`}`,
      // Each type is one height (the separator, the gap above a group), so the list's estimate
      // for a row it has not measured is exact and mounting one moves no other.
      type: `${item.kind}${index > 0 ? ":separated" : !group.label && groupIndex > 0 ? ":gap" : ""}`,
      node: (
        <div className={index === 0 && !group.label && groupIndex > 0 ? "pt-3" : undefined}>
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
        </div>
      ),
    })),
  ]);

  return (
    <PullRequestSpeedModeProvider>
      <div className={cn(sweepingKeys.size > 0 && "**:pointer-events-none")}>
        <WorkItemWindowedList items={items} scrollElement={scrollElement} estimatedItemSize={61} />
      </div>
    </PullRequestSpeedModeProvider>
  );
}

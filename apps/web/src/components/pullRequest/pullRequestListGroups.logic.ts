import type {
  PullRequestInvolvement,
  PullRequestListFilters,
  PullRequestListResult,
} from "@t3tools/contracts";

import type { PullRequestTabStatusSeed } from "~/components/RightPanelTabs";
import { pullRequestSurfaceId } from "~/rightPanelStore";
import {
  comparePullRequestsByRecency,
  filterPullRequestsByInvolvement,
  groupPullRequestsByInvolvement,
  matchesPullRequestFilters,
  matchesPullRequestQuery,
  partitionPullRequestsWithPriority,
  pullRequestEntryKey,
  pullRequestEntryViewer,
  type EnvironmentPullRequestEntry,
  type PullRequestPartitionsSnapshot,
} from "./pullRequestList.logic";

export const pullRequestListEntryId = (target: Parameters<typeof pullRequestSurfaceId>[0]) =>
  pullRequestSurfaceId({ ...target, repository: target.repository.toLowerCase() });

/** The held rows narrowed to what the reader asked for, in the groups the list shows. */
export function pullRequestGroups({
  known,
  providers,
  viewers,
  involvement,
  localFilters,
  hasLocalFilters,
  text,
  answeredLocally,
  baselineEmpty,
  held,
  authored,
  reviewing,
  partitionsWanted,
}: {
  known: ReadonlyArray<EnvironmentPullRequestEntry>;
  providers: PullRequestListResult["providers"];
  viewers: PullRequestListResult["viewers"];
  involvement: PullRequestInvolvement;
  localFilters: PullRequestListFilters;
  hasLocalFilters: boolean;
  text: string;
  answeredLocally: boolean;
  baselineEmpty: boolean;
  held: PullRequestPartitionsSnapshot | undefined;
  authored: ReadonlyArray<EnvironmentPullRequestEntry> | undefined;
  reviewing: ReadonlyArray<EnvironmentPullRequestEntry> | undefined;
  partitionsWanted: boolean;
}) {
  const searchingHosts = new Set(
    providers.flatMap((provider) => (provider.searchesOnHost ? [provider.host] : [])),
  );

  const entries = (() => {
    const involvementEntries = filterPullRequestsByInvolvement(known, viewers, involvement);
    // Host text searches cover fields absent from rows, so do not narrow their matches locally.
    // Filter text locally while results are pending or when the host has no text search.
    const narrowedEntries = hasLocalFilters
      ? involvementEntries.filter((entry) =>
          matchesPullRequestFilters(entry, localFilters, pullRequestEntryViewer(entry, viewers)),
        )
      : involvementEntries;
    if (text.length === 0) {
      return narrowedEntries.toSorted(comparePullRequestsByRecency);
    }
    return narrowedEntries.filter(
      (entry) =>
        (answeredLocally && searchingHosts.has(entry.host)) || matchesPullRequestQuery(entry, text),
    );
  })();

  const listedPullRequestTabStatuses: Record<string, PullRequestTabStatusSeed> = Object.fromEntries(
    entries.map((entry) => [
      pullRequestSurfaceId(entry),
      {
        state: entry.state,
        isDraft: entry.isDraft,
      },
    ]),
  );

  const groups = (() => {
    if (involvement !== "all") return [{ key: "others" as const, label: "", entries }];
    if (baselineEmpty) {
      return groupPullRequestsByInvolvement(entries, viewers);
    }
    const narrow = (rows: ReadonlyArray<EnvironmentPullRequestEntry> | undefined) =>
      rows === undefined || !hasLocalFilters
        ? rows
        : rows.filter((entry) =>
            matchesPullRequestFilters(entry, localFilters, pullRequestEntryViewer(entry, viewers)),
          );
    const narrowedAuthored = narrow(partitionsWanted ? (authored ?? held?.authored) : undefined);
    const narrowedReviewing = narrow(partitionsWanted ? (reviewing ?? held?.reviewing) : undefined);
    if (narrowedAuthored === undefined || narrowedReviewing === undefined) {
      return groupPullRequestsByInvolvement(entries, viewers);
    }
    return partitionPullRequestsWithPriority(entries, narrowedAuthored, narrowedReviewing);
  })();

  const entriesByStatsKey: ReadonlyMap<string, EnvironmentPullRequestEntry> = new Map(
    groups.flatMap((group) =>
      group.entries.map((entry) => [pullRequestEntryKey(entry), entry] as const),
    ),
  );
  const heldPullRequestsBySurface = new Map(
    groups.flatMap((group) =>
      group.entries.map((entry) => [pullRequestListEntryId(entry), entry] as const),
    ),
  );
  return {
    entries,
    listedPullRequestTabStatuses,
    groups,
    entriesByStatsKey,
    heldPullRequestsBySurface,
  };
}

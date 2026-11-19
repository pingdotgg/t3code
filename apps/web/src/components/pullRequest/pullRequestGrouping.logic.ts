import type { PullRequestListEntry } from "@t3tools/contracts";
import { msg } from "gt-react";

import type { PullRequestGroupBy } from "./pullRequestListPreferences";
import {
  comparePullRequestsByRecency,
  rankPullRequestMatches,
  type PullRequestGroup,
} from "./pullRequestList.logic";

/** A row under a heading; `entries` of a group is all of its rows, in sub-group order. */
export interface PullRequestSubgroup<Entry> {
  readonly key: string;
  readonly label: string;
  readonly entries: ReadonlyArray<Entry>;
}

export type PullRequestGrouped<Entry extends PullRequestListEntry> = PullRequestGroup<Entry> & {
  readonly subgroups?: ReadonlyArray<PullRequestSubgroup<Entry>>;
};

interface Bucket {
  readonly key: string;
  readonly label: string;
  /** Fixed order for known values; buckets sharing a rank sort by label. */
  readonly rank: number;
}

const LAST = Number.MAX_SAFE_INTEGER;
const DAY_MS = 24 * 60 * 60 * 1000;

export function poolPullRequestGroups<Entry extends PullRequestListEntry>(
  groups: ReadonlyArray<PullRequestGroup<Entry>>,
  text: string,
): ReadonlyArray<PullRequestGroup<Entry>> {
  const entries = groups.flatMap((group) => group.entries);
  return [
    {
      key: "others",
      label: "",
      entries:
        text.trim().length > 0
          ? rankPullRequestMatches(entries, text)
          : entries.toSorted(comparePullRequestsByRecency),
    },
  ];
}

const fixed = (rank: number, key: string, label: string): Bucket => ({ key, label, rank });
const named = (key: string, label: string, missing = false): Bucket => ({
  key: `${missing ? "~" : "="}${key.toLowerCase()}`,
  label,
  rank: missing ? LAST : 0,
});

const STATE_BUCKETS = {
  open: fixed(0, "open", msg("Open", { $context: "pull request state" })),
  merged: fixed(1, "merged", msg("Merged", { $context: "pull request state" })),
  closed: fixed(2, "closed", msg("Closed", { $context: "pull request state" })),
};

const REVIEW_BUCKETS = {
  approved: fixed(0, "approved", msg("Approved", { $context: "review outcome" })),
  "changes-requested": fixed(1, "changes-requested", msg("Changes requested")),
  "review-required": fixed(2, "review-required", msg("Awaiting review")),
  none: fixed(3, "none", msg("No reviews")),
};

const CHECKS_BUCKETS = {
  failing: fixed(0, "failing", msg("Failing", { $context: "checks filter" })),
  pending: fixed(1, "pending", msg("Pending", { $context: "checks group" })),
  passing: fixed(2, "passing", msg("Passing", { $context: "checks filter" })),
  none: fixed(3, "none", msg("No checks")),
};

const MERGEABILITY_BUCKETS = {
  conflicting: fixed(0, "conflicting", msg("Has conflicts")),
  mergeable: fixed(1, "mergeable", msg("Mergeable")),
  unknown: fixed(2, "unknown", msg("Merge state unknown")),
};

const AGE_BUCKETS = [
  fixed(0, "today", msg("Updated today")),
  fixed(1, "week", msg("Updated this week")),
  fixed(2, "month", msg("Updated this month")),
  fixed(3, "older", msg("Updated earlier")),
];

function ageBucket(updatedAt: string, now: number): Bucket {
  const updated = Date.parse(updatedAt);
  const age = Number.isNaN(updated) ? Infinity : now - updated;
  if (age < DAY_MS) return AGE_BUCKETS[0]!;
  if (age < 7 * DAY_MS) return AGE_BUCKETS[1]!;
  if (age < 30 * DAY_MS) return AGE_BUCKETS[2]!;
  return AGE_BUCKETS[3]!;
}

/** The labels sort alphabetically and a row sits under its first, so no row is listed twice. */
function firstLabel(entry: PullRequestListEntry): string | null {
  const names = entry.labels.map((label) => label.name.trim()).filter((name) => name.length > 0);
  return names.length === 0 ? null : names.toSorted((left, right) => left.localeCompare(right))[0]!;
}

function bucketOf(
  by: Exclude<PullRequestGroupBy, "involvement" | "none">,
  entry: PullRequestListEntry,
  now: number,
): Bucket {
  switch (by) {
    case "project":
      return named(entry.projectTitle, entry.projectTitle);
    case "repository":
      return named(entry.repository, entry.repository);
    case "host":
      return named(entry.host, entry.host);
    case "author":
      return entry.author === null
        ? named("", msg("Unknown author"), true)
        : named(entry.author.login, entry.author.login);
    case "state":
      return STATE_BUCKETS[entry.state];
    case "review":
      return REVIEW_BUCKETS[entry.reviewDecision ?? "none"];
    case "checks":
      return CHECKS_BUCKETS[entry.checksState ?? "none"];
    case "draft":
      return entry.isDraft
        ? fixed(1, "draft", msg("Drafts", { $context: "pull request group" }))
        : fixed(0, "ready", msg("Ready for review"));
    case "mergeability":
      return MERGEABILITY_BUCKETS[entry.mergeability];
    case "label": {
      const label = firstLabel(entry);
      return label === null ? named("", msg("No label"), true) : named(label, label);
    }
    case "base":
      return { key: `=${entry.baseBranch}`, label: entry.baseBranch, rank: 0 };
    case "updated":
      return ageBucket(entry.updatedAt, now);
  }
}

/** Splits rows into headed buckets; rows keep the order they came in within each bucket. */
function bucketPullRequests<Entry extends PullRequestListEntry>(
  entries: ReadonlyArray<Entry>,
  by: Exclude<PullRequestGroupBy, "involvement" | "none">,
  now: number,
): ReadonlyArray<{ readonly bucket: Bucket; readonly entries: ReadonlyArray<Entry> }> {
  const buckets = new Map<string, { bucket: Bucket; entries: Entry[] }>();
  for (const entry of entries) {
    const bucket = bucketOf(by, entry, now);
    const held = buckets.get(bucket.key);
    if (held === undefined) buckets.set(bucket.key, { bucket, entries: [entry] });
    else held.entries.push(entry);
  }
  return [...buckets.values()].toSorted(
    (left, right) =>
      left.bucket.rank - right.bucket.rank || left.bucket.label.localeCompare(right.bucket.label),
  );
}

/**
 * Regroups `groups` for the reader's grouping. `involvement` keeps the groups it was given
 * (the Authored / Review requested / Others split) and any sub-grouping applies inside each;
 * every other grouping pools the rows first, so the list's sort decides the order within
 * a bucket.
 */
export function regroupPullRequests<Entry extends PullRequestListEntry>(
  groups: ReadonlyArray<PullRequestGroup<Entry>>,
  groupBy: PullRequestGroupBy,
  subGroupBy: PullRequestGroupBy,
  now: number,
): ReadonlyArray<PullRequestGrouped<Entry>> {
  const split = (group: PullRequestGroup<Entry>): PullRequestGrouped<Entry> => {
    if (subGroupBy === "none" || subGroupBy === "involvement" || subGroupBy === groupBy) {
      return group;
    }
    const subgroups = bucketPullRequests(group.entries, subGroupBy, now).map(
      ({ bucket, entries }) => ({ key: bucket.key, label: bucket.label, entries }),
    );
    return {
      ...group,
      entries: subgroups.flatMap((subgroup) => subgroup.entries),
      subgroups,
    };
  };
  if (groupBy === "involvement") return groups.map(split);
  const pooled = groups.flatMap((group) => group.entries);
  if (groupBy === "none") return [{ key: "others", label: "", entries: pooled }];
  return bucketPullRequests(pooled, groupBy, now).map(({ bucket, entries }) =>
    split({ key: bucket.key, label: bucket.label, entries }),
  );
}

export function slicePullRequestGroups<Entry extends PullRequestListEntry>(
  groups: ReadonlyArray<PullRequestGrouped<Entry>>,
  limit: number,
): ReadonlyArray<PullRequestGrouped<Entry>> {
  let left = limit;
  return groups.flatMap((group) => {
    const entries = group.entries.slice(0, left);
    left -= entries.length;
    if (entries.length === 0) return [];
    // Sub-groups hold the same rows in the same order, so the shown prefix covers whole
    // sub-groups first and a part of the last one.
    let remaining = entries.length;
    const subgroups = group.subgroups?.flatMap((subgroup) => {
      const shown = subgroup.entries.slice(0, remaining);
      remaining -= shown.length;
      return shown.length === 0 ? [] : [{ ...subgroup, entries: shown }];
    });
    return [{ ...group, entries, ...(subgroups === undefined ? {} : { subgroups }) }];
  });
}

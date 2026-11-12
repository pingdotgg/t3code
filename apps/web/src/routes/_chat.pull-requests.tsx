import {
  type EnvironmentId,
  type ProjectId,
  PullRequestChecksFilter,
  PullRequestReviewFilter,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { createFileRoute } from "@tanstack/react-router";

import {
  MAX_EXCLUDED_REPOSITORIES,
  type PullRequestListSort,
} from "../components/pullRequest/pullRequestListPreferences";
import { SORT_OPTIONS } from "../components/pullRequest/pullRequestListOptions";
import { type PullRequestsSearch } from "../components/pullRequest/usePullRequestListView";
import { PullRequestsPage } from "../components/pullRequest/PullRequestsPage";

const MAX_SEARCH_LIST_CANDIDATES = 100;

function searchStringList(raw: unknown, limit: number): ReadonlyArray<string> {
  const values = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).slice(
    0,
    MAX_SEARCH_LIST_CANDIDATES,
  );
  const list: Array<string> = [];
  const seen = new Set<string>();
  for (const rawValue of values) {
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim().slice(0, 200);
    const key = value.toLowerCase();
    if (value.length === 0 || seen.has(key)) continue;
    list.push(value);
    seen.add(key);
    if (list.length === limit) break;
  }
  return list;
}

function pullRequestSearchList<Key extends "labels" | "excludedLabels" | "excludedAuthors">(
  key: Key,
  raw: unknown,
): Partial<Record<Key, ReadonlyArray<string>>> {
  const values = searchStringList(raw, 10);
  return values.length === 0 ? {} : ({ [key]: values } as Record<Key, ReadonlyArray<string>>);
}

const isReviewFilter = Schema.is(PullRequestReviewFilter);
const isChecksFilter = Schema.is(PullRequestChecksFilter);

function pullRequestSearchExcludedRepositories(
  raw: unknown,
): Partial<Pick<PullRequestsSearch, "excludedRepositories">> {
  const excludedRepositories = searchStringList(raw, MAX_EXCLUDED_REPOSITORIES).map((key) =>
    key.toLowerCase(),
  );
  return excludedRepositories.length === 0 ? {} : { excludedRepositories };
}

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (raw: Record<string, unknown>): PullRequestsSearch => ({
    ...(typeof raw.selectedUrl === "string" ? { selectedUrl: raw.selectedUrl.slice(0, 4096) } : {}),
    involvement:
      raw.involvement === "reviewing" || raw.involvement === "authored" ? raw.involvement : "all",
    state:
      raw.state === "closed" || raw.state === "merged" || raw.state === "all" ? raw.state : "open",
    ...(SORT_OPTIONS.some((option) => option.value === raw.sort)
      ? { sort: raw.sort as PullRequestListSort }
      : {}),
    ...(typeof raw.repository === "string" && raw.repository
      ? { repository: raw.repository.slice(0, 200) }
      : {}),
    ...(typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0
      ? { number: raw.number }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
    ...pullRequestSearchExcludedRepositories(raw.excludedRepositories),
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.host === "string" && raw.host ? { host: raw.host.slice(0, 200) } : {}),
    ...(typeof raw.selectedProjectId === "string" && raw.selectedProjectId
      ? { selectedProjectId: raw.selectedProjectId as ProjectId }
      : {}),
    ...(typeof raw.selectedHost === "string" && raw.selectedHost
      ? { selectedHost: raw.selectedHost.slice(0, 200) }
      : {}),
    ...(typeof raw.selectedEnvironmentId === "string" && raw.selectedEnvironmentId
      ? { selectedEnvironmentId: raw.selectedEnvironmentId as EnvironmentId }
      : {}),
    // Always include q to override numeric values in the parent route's unvalidated search.
    q: typeof raw.q === "string" && raw.q ? raw.q.slice(0, 200) : undefined,
    ...(raw.draft === "only" || raw.draft === "hide" ? { draft: raw.draft } : {}),
    ...(isReviewFilter(raw.review) ? { review: raw.review } : {}),
    ...(isReviewFilter(raw.excludedReview) ? { excludedReview: raw.excludedReview } : {}),
    ...(isChecksFilter(raw.checks) ? { checks: raw.checks } : {}),
    ...(isChecksFilter(raw.excludedChecks) ? { excludedChecks: raw.excludedChecks } : {}),
    ...(typeof raw.author === "string" && raw.author.trim()
      ? { author: raw.author.trim().slice(0, 200) }
      : {}),
    ...pullRequestSearchList("excludedAuthors", raw.excludedAuthors),
    ...pullRequestSearchList("labels", raw.labels),
    ...pullRequestSearchList("excludedLabels", raw.excludedLabels),
  }),
  component: PullRequestsPage,
});

import { registerBuiltinRoute, definePluginRouteRenderer } from "~/plugins/routing";
import { definePluginFeature } from "~/plugins/features";
import type { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { createFileRoute } from "@tanstack/react-router";
import * as Schema from "effect/Schema";

import { PullRequestListSort } from "../components/pullRequest/pullRequestListPreferences";
import { type PullRequestsSearch } from "../components/pullRequest/usePullRequestListView";
import { PullRequestsRouteView } from "../components/pullRequest/PullRequestsPage";

const isPullRequestListSort = Schema.is(PullRequestListSort);
const MAX_SEARCH_LABEL_CANDIDATES = 100;

function pullRequestSearchLabels(raw: unknown): PullRequestsSearch["labels"] {
  const values = (Array.isArray(raw) ? raw : typeof raw === "string" ? [raw] : []).slice(
    0,
    MAX_SEARCH_LABEL_CANDIDATES,
  );
  const labels: Array<string> = [];
  const seen = new Set<string>();
  for (const rawValue of values) {
    if (typeof rawValue !== "string") continue;
    const value = rawValue.trim().slice(0, 200);
    const key = value.toLowerCase();
    if (value.length === 0 || seen.has(key)) continue;
    labels.push(value);
    seen.add(key);
    if (labels.length === 10) break;
  }
  return labels.length === 0 ? undefined : labels;
}

export const Route = createFileRoute("/_chat/pull-requests")({
  validateSearch: (raw: Record<string, unknown>): PullRequestsSearch => ({
    ...(typeof raw.selectedUrl === "string" ? { selectedUrl: raw.selectedUrl.slice(0, 4096) } : {}),
    involvement:
      raw.involvement === "reviewing" || raw.involvement === "authored" ? raw.involvement : "all",
    state:
      raw.state === "closed" || raw.state === "merged" || raw.state === "all" ? raw.state : "open",
    ...(isPullRequestListSort(raw.sort) ? { sort: raw.sort } : {}),
    ...(typeof raw.repository === "string" && raw.repository
      ? { repository: raw.repository.slice(0, 200) }
      : {}),
    ...(typeof raw.number === "number" && Number.isInteger(raw.number) && raw.number > 0
      ? { number: raw.number }
      : {}),
    ...(typeof raw.projectId === "string" && raw.projectId
      ? { projectId: raw.projectId as ProjectId }
      : {}),
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
    // Always include free-text keys to override numeric values in the parent route's unvalidated search.
    q: typeof raw.q === "string" && raw.q ? raw.q.slice(0, 200) : undefined,
    ...(raw.draft === "only" || raw.draft === "hide" ? { draft: raw.draft } : {}),
    ...(raw.review === "approved" ||
    raw.review === "changes-requested" ||
    raw.review === "review-required" ||
    raw.review === "none"
      ? { review: raw.review }
      : {}),
    ...(raw.checks === "passing" || raw.checks === "failing" ? { checks: raw.checks } : {}),
    author:
      typeof raw.author === "string" && raw.author.trim()
        ? raw.author.trim().slice(0, 200)
        : undefined,
    labels: pullRequestSearchLabels(raw.labels),
  }),
  component: definePluginRouteRenderer(
    "/_chat/pull-requests",
    "component",
    definePluginFeature("pull-request.page", PullRequestsRouteView),
  ),
});

registerBuiltinRoute("/_chat/pull-requests", Route);

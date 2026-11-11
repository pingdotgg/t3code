import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { parsePullRequestQuery } from "@t3tools/client-runtime/pull-request-query";
import {
  type EnvironmentId,
  type ProjectId,
  type PullRequestInvolvement,
  type PullRequestListFilters,
  type PullRequestListResult,
  type PullRequestListState,
} from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { useAllEnvironmentShellsBootstrapped, useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import {
  applyPullRequestOverrides,
  displayPullRequestGroups,
  findProjectForRepository,
  findScopedProject,
  matchesPullRequestFilters,
  pullRequestEntryKey,
  pullRequestEntryViewer,
  pullRequestEnvironmentSetKey,
  pullRequestHostActions,
  resolveProjectScope,
  resolveSelectedEnvironmentId,
  type EnvironmentPullRequestEntry,
  type MergedPullRequestList,
  type PullRequestDiffStats,
  type PullRequestGroup,
  type PullRequestListOverride,
} from "./pullRequestList.logic";
import type { PullRequestExpectedHost } from "./PullRequestListFilters";
import type { PullRequestListPreferences, PullRequestListSort } from "./pullRequestListPreferences";
import {
  pullRequestProjectQueries,
  type PullRequestHostAvailability,
} from "./pullRequestProjectAssignment.logic";
import { useSidebarProjectGroups } from "~/hooks/useSidebarProjectGroups";
import {
  pullRequestFilterProjects,
  pullRequestProjectFilterQueries,
} from "@t3tools/client-runtime/pull-request-project-filter";
import { pullRequestListEntryId } from "./pullRequestListGroups.logic";
import { SORT_OPTIONS } from "./pullRequestListOptions";

export interface PullRequestsSearch extends PullRequestListPreferences {
  readonly selectedUrl?: string;
  readonly environmentId?: EnvironmentId;
  readonly projectId?: ProjectId;
  readonly host?: string;
  readonly repository?: string;
  readonly number?: number;
  readonly selectedProjectId?: ProjectId;
  readonly selectedHost?: string;
  readonly selectedEnvironmentId?: EnvironmentId;
}

const SEARCH_DEBOUNCE_MS = 250;

/** Which servers and projects the page reads, from the URL and what this client knows. */
export function usePullRequestScope(
  search: PullRequestsSearch,
  hostAvailability: PullRequestHostAvailability,
) {
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const projectsKnown = useAllEnvironmentShellsBootstrapped();
  const capableEnvironments = environments
    .filter((environment) => environment.serverConfig !== null)
    .toSorted((left, right) => left.environmentId.localeCompare(right.environmentId));
  const scopedEnvironmentId =
    capableEnvironments.find((environment) => environment.environmentId === search.environmentId)
      ?.environmentId ?? null;
  const knownEnvironmentIds = new Set(environments.map((environment) => environment.environmentId));
  const environmentIds = capableEnvironments
    .filter(
      (environment) =>
        scopedEnvironmentId === null || environment.environmentId === scopedEnvironmentId,
    )
    .map((environment) => environment.environmentId);
  const environmentKey = pullRequestEnvironmentSetKey(environmentIds);
  const capabilityKnown = environments.some((environment) => environment.serverConfig !== null);
  const pullRequestsSupported = environmentIds.length > 0;
  const projects = allProjects.filter(
    (project) => !project.isScratch && environmentIds.includes(project.environmentId),
  );
  const environmentLabels = new Map(
    environments.map((environment) => [environment.environmentId, environment.label] as const),
  );
  const scopedProjectId = resolveProjectScope(search.projectId, projects, projectsKnown);
  const scopedProject = findScopedProject(
    projects,
    search.projectEnvironmentId ?? scopedEnvironmentId,
    scopedProjectId,
  );
  const sidebarProjectGroups = useSidebarProjectGroups();
  const scopedProjects = pullRequestFilterProjects(
    projects,
    sidebarProjectGroups.map((group) => ({
      label: group.displayName,
      memberProjectRefs: group.memberProjectRefs,
    })),
    scopedProject,
  );

  const selectedHost = search.selectedHost ?? search.host;
  // A named server still connecting is kept named rather than falling back: falling back while it
  // is merely not ready yet would resolve the project against whatever other server has answered,
  // which can be the wrong one where two servers share a project id.
  const selectedEnvironmentId = resolveSelectedEnvironmentId(
    search.selectedEnvironmentId,
    knownEnvironmentIds,
    scopedEnvironmentId,
  );
  const projectForRepository =
    search.repository === undefined
      ? undefined
      : findProjectForRepository(projects, {
          repository: search.repository,
          host: selectedHost,
          selectedEnvironmentId,
          scopedProjectId,
          scopedEnvironmentId,
        });
  const linkedProjectId = resolveProjectScope(search.selectedProjectId, projects, projectsKnown);
  const selectedProject =
    linkedProjectId === undefined && search.repository !== undefined
      ? projectForRepository
      : findScopedProject(projects, selectedEnvironmentId, linkedProjectId ?? scopedProjectId);
  const selectedQueries = pullRequestProjectFilterQueries(
    scopedProjects,
    environmentIds,
    scopedProjectId === undefined
      ? undefined
      : {
          id: scopedProjectId,
          environmentId: scopedProject?.environmentId ?? search.projectEnvironmentId,
        },
  );
  const queryEnvironmentIds = selectedQueries.map((query) => query.environmentId);
  const queriesFor = (
    availability?: PullRequestHostAvailability,
  ): ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectIds?: ReadonlyArray<ProjectId>;
  }> => {
    const plain = queryEnvironmentIds.map((environmentId) => ({ environmentId }));
    if (!projectsKnown) return plain;
    if (scopedProjectId !== undefined) return selectedQueries;
    return pullRequestProjectQueries(projects, queryEnvironmentIds, availability);
  };
  const environmentQueries = queriesFor(hostAvailability);
  // What the page reads once a refresh forgets host reads; refresh must refetch these too.
  const preferredEnvironmentQueries = queriesFor();
  const assignmentKey = environmentQueries
    .map(({ environmentId, projectIds }) => `${environmentId}#${projectIds?.join("+") ?? "*"}`)
    .join("|");
  // The URL is user-controlled and stands in for the PR link until detail loads.
  const selectedLink = search.selectedUrl
    ? sourceControlClients.parseChangeRequestUrl(search.selectedUrl)?.link
    : undefined;
  const selectedUrl =
    selectedLink !== undefined &&
    selectedLink.number === search.number &&
    selectedLink.repository.toLowerCase() === search.repository?.toLowerCase()
      ? search.selectedUrl
      : undefined;
  const linkedSelection =
    search.repository && search.number && selectedProject
      ? {
          environmentId: selectedProject.environmentId,
          repository: search.repository,
          number: search.number,
          projectId: selectedProject.id,
          ...(selectedUrl ? { url: selectedUrl, revealUrl: selectedUrl } : {}),
          ...(selectedHost ? { host: selectedHost } : {}),
        }
      : null;
  const expectedHosts = (() => {
    const byHost = new Map<string, PullRequestExpectedHost>();
    for (const project of projects) {
      const kind = project.repositoryIdentity?.provider;
      if (kind === undefined) continue;
      const host = sourceControlClients.changeRequestHost(project.repositoryIdentity, kind);
      if (!byHost.has(host)) byHost.set(host, { host, kind });
    }
    return [...byHost.values()];
  })();

  return {
    capableEnvironments,
    scopedEnvironmentId,
    environmentKey,
    capabilityKnown,
    pullRequestsSupported,
    projects,
    environmentLabels,
    scopedProjectId,
    scopedProject,
    scopedProjects,
    selectedProject,
    queryEnvironmentIds,
    environmentQueries,
    preferredEnvironmentQueries,
    assignmentKey,
    linkedSelection,
    expectedHosts,
    projectsKnown,
  };
}

export function usePullRequestQueryFilters(search: PullRequestsSearch, typedQuery: string) {
  const [sentQuery, setSentQuery] = useState(typedQuery);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounce timer that sends the typed query after SEARCH_DEBOUNCE_MS
  useEffect(() => {
    const timer = window.setTimeout(() => setSentQuery(typedQuery), SEARCH_DEBOUNCE_MS);
    return () => window.clearTimeout(timer);
  }, [typedQuery]);
  const typedParsed = parsePullRequestQuery(typedQuery);
  const sentParsed = parsePullRequestQuery(sentQuery);

  const menuFilters = {
    ...(search.draft ? { draft: search.draft } : {}),
    ...(search.review ? { review: search.review } : {}),
    ...(search.checks ? { checks: search.checks } : {}),
    ...(search.author ? { author: search.author } : {}),
    ...(search.labels ? { labels: search.labels.map((label) => [label]) } : {}),
  };
  const menuFiltered = Object.keys(menuFilters).length > 0;
  const filters = { ...menuFilters, ...sentParsed.filters };
  const hasFilters = Object.keys(filters).length > 0;
  const localFilters = { ...menuFilters, ...typedParsed.filters };
  const hasLocalFilters = Object.keys(localFilters).length > 0;
  return {
    sentQuery,
    submitQuery: (query: string) => setSentQuery(query.trim()),
    querySettled: typedQuery === sentQuery,
    typedParsed,
    sentParsed,
    menuFilters,
    menuFiltered,
    filters,
    hasFilters,
    localFilters,
    hasLocalFilters,
  };
}

/**
 * The hosts the list has answered for (kept while a host filter narrows the answer), and the
 * groups as shown with measured sizes, optimistic actions, and the reader's sort.
 */
export function usePullRequestDisplayGroups({
  answered,
  host,
  groups,
  statsByRow,
  sortStatsByRow,
  overrides,
  state,
  localFilters,
  hasLocalFilters,
  viewers,
  sort,
  text,
  involvement,
}: {
  answered: MergedPullRequestList | null;
  host: string | undefined;
  groups: ReadonlyArray<PullRequestGroup<EnvironmentPullRequestEntry>>;
  statsByRow: PullRequestDiffStats;
  sortStatsByRow: PullRequestDiffStats;
  overrides: ReadonlyMap<string, PullRequestListOverride>;
  state: PullRequestListState;
  localFilters: PullRequestListFilters;
  hasLocalFilters: boolean;
  viewers: PullRequestListResult["viewers"];
  sort: PullRequestListSort;
  text: string;
  involvement: PullRequestInvolvement;
}) {
  const [hostsState, setHostsState] = useState<{
    readonly source: MergedPullRequestList | null;
    readonly host: string | undefined;
    readonly hosts: PullRequestListResult["providers"];
  }>({ source: null, host: undefined, hosts: [] });
  if (answered !== null && (hostsState.source !== answered || hostsState.host !== host)) {
    setHostsState({
      source: answered,
      host,
      hosts:
        host === undefined || hostsState.hosts.length === 0 ? answered.providers : hostsState.hosts,
    });
  }
  const hosts = hostsState.hosts;
  const displayGroups = (() => {
    const enriched = groups.map((group) => {
      const overridden = applyPullRequestOverrides(
        group.entries,
        overrides,
        pullRequestEntryKey,
        state,
      );
      return {
        ...group,
        entries:
          hasLocalFilters && overrides.size > 0
            ? overridden.filter(
                (entry) =>
                  !overrides.has(pullRequestEntryKey(entry)) ||
                  matchesPullRequestFilters(
                    entry,
                    localFilters,
                    pullRequestEntryViewer(entry, viewers),
                  ),
              )
            : overridden,
      };
    });
    return displayPullRequestGroups(enriched, sort, text, statsByRow, sortStatsByRow, involvement);
  })();
  const shownCount = displayGroups.reduce((count, group) => count + group.entries.length, 0);
  const hostActionsOf = pullRequestHostActions(hosts);
  const closeSweepRows = new Map(
    displayGroups.flatMap((group) =>
      group.entries.map(
        (entry) => [pullRequestEntryKey(entry), { entry, groupKey: group.key }] as const,
      ),
    ),
  );
  const listedPullRequestsBySurface = new Map(
    displayGroups.flatMap((group) =>
      group.entries.map((entry) => [pullRequestListEntryId(entry), entry] as const),
    ),
  );

  return {
    hosts,
    displayGroups,
    shownCount,
    hostActionsOf,
    closeSweepRows,
    listedPullRequestsBySurface,
  };
}

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

export function validatePullRequestsSearch(raw: Record<string, unknown>): PullRequestsSearch {
  return {
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
    ...(typeof raw.environmentId === "string" && raw.environmentId
      ? { environmentId: raw.environmentId as EnvironmentId }
      : {}),
    ...(typeof raw.projectEnvironmentId === "string" && raw.projectEnvironmentId
      ? { projectEnvironmentId: raw.projectEnvironmentId as EnvironmentId }
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
    // Keep every query as text and always own the free-text keys so an unvalidated parent value cannot leak.
    q:
      raw.q !== undefined && raw.q !== null && raw.q !== ""
        ? (typeof raw.q === "string" ? raw.q : JSON.stringify(raw.q)).slice(0, 200)
        : undefined,
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
  };
}

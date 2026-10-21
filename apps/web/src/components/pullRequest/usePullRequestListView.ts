import { parsePullRequestQuery } from "@t3tools/client-runtime/pull-request-query";
import { pullRequestFilterProjects } from "@t3tools/client-runtime/pull-request-project-filter";
import {
  pullRequestHostOf,
  type EnvironmentId,
  type ProjectId,
  type PullRequestInvolvement,
  type PullRequestListFilters,
  type PullRequestListResult,
  type PullRequestListState,
  type SourceControlProviderKind,
} from "@t3tools/contracts";
import { useState } from "react";

import { useAllEnvironmentShellsBootstrapped, useProjects } from "~/state/entities";
import { useEnvironments } from "~/state/environments";
import { useDebouncedValue } from "~/state/queries";
import {
  applyPullRequestOverrides,
  findProjectForRepository,
  findScopedProject,
  matchesPullRequestFilters,
  pullRequestDiffStatKey,
  pullRequestEntryKey,
  pullRequestEntryViewer,
  pullRequestEnvironmentSetKey,
  pullRequestHostActions,
  resolveProjectScope,
  resolveQueryEnvironmentIds,
  resolveSelectedEnvironmentId,
  sortPullRequestGroups,
  withDiffStat,
  type EnvironmentPullRequestEntry,
  type MergedPullRequestList,
  type PullRequestDiffStats,
  type PullRequestGroup,
  type PullRequestListOverride,
} from "./pullRequestList.logic";
import type { PullRequestExpectedHost } from "./PullRequestListFilters";
import type { PullRequestListPreferences, PullRequestListSort } from "./pullRequestListPreferences";
import { assignProjectsToEnvironments } from "./pullRequestProjectAssignment.logic";
import { pullRequestListEntryId } from "./pullRequestListGroups.logic";

export interface PullRequestsSearch extends PullRequestListPreferences {
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
export function usePullRequestScope(search: PullRequestsSearch) {
  const { environments } = useEnvironments();
  const allProjects = useProjects();
  const projectsKnown = useAllEnvironmentShellsBootstrapped();
  const capableEnvironments = environments
    .filter(
      (environment) => environment.serverConfig?.environment.capabilities.pullRequests === true,
    )
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
  const scopedProject = findScopedProject(projects, scopedEnvironmentId, scopedProjectId);
  const scopedProjects = pullRequestFilterProjects(projects, environmentLabels, scopedProject);

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
  const queryEnvironmentIds = resolveQueryEnvironmentIds(
    environmentIds,
    projects,
    scopedProject,
    scopedProjectId,
    projectsKnown,
  );
  const environmentQueries = ((): ReadonlyArray<{
    readonly environmentId: EnvironmentId;
    readonly projectIds?: ReadonlyArray<ProjectId>;
  }> => {
    const plain = queryEnvironmentIds.map((environmentId) => ({ environmentId }));
    if (!projectsKnown || scopedProjectId !== undefined) return plain;
    const assignment = assignProjectsToEnvironments(
      projects,
      queryEnvironmentIds,
      queryEnvironmentIds[0],
    );
    const totals = new Map<EnvironmentId, number>();
    for (const project of projects) {
      totals.set(project.environmentId, (totals.get(project.environmentId) ?? 0) + 1);
    }
    return queryEnvironmentIds.flatMap((environmentId) => {
      const projectIds = assignment.get(environmentId);
      if (projectIds === undefined) return [];
      if (projectIds.length === (totals.get(environmentId) ?? 0)) return [{ environmentId }];
      return [{ environmentId, projectIds }];
    });
  })();
  const assignmentKey = environmentQueries
    .map(({ environmentId, projectIds }) => `${environmentId}#${projectIds?.join("+") ?? "*"}`)
    .join("|");
  const linkedSelection =
    search.repository && search.number && selectedProject
      ? {
          environmentId: selectedProject.environmentId,
          repository: search.repository,
          number: search.number,
          projectId: selectedProject.id,
          ...(selectedHost ? { host: selectedHost } : {}),
        }
      : null;
  const expectedHosts = (() => {
    const byHost = new Map<string, PullRequestExpectedHost>();
    for (const project of projects) {
      const kind = project.repositoryIdentity?.provider as SourceControlProviderKind | undefined;
      if (kind === undefined) continue;
      const host = pullRequestHostOf(project.repositoryIdentity, kind);
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
    assignmentKey,
    linkedSelection,
    expectedHosts,
    projectsKnown,
  };
}

export function usePullRequestQueryFilters(search: PullRequestsSearch, typedQuery: string) {
  const sentQuery = useDebouncedValue(typedQuery, SEARCH_DEBOUNCE_MS);
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
        group.entries.map((entry) => withDiffStat(entry, statsByRow)),
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
    return sortPullRequestGroups(
      enriched,
      sort,
      text,
      (entry) =>
        entry.additions + entry.deletions > 0 || statsByRow.has(pullRequestDiffStatKey(entry)),
      involvement,
    );
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

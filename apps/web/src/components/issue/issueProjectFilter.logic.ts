import type {
  EnvironmentId,
  IssueListInput,
  IssueListResult,
  IssueScopeRef,
  ProjectId,
} from "@t3tools/contracts";

import { issueHostKey, issueListCursorKey, issueScopeKeyOf } from "@t3tools/contracts";

import { issueSourceMatchesList } from "@t3tools/client-runtime/state/issues";

import { findScopedProject } from "../pullRequest/pullRequestList.logic";

interface ScopedProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
}

export type IssueListSources = NonNullable<IssueListResult["sources"]>;

export function issueCreateSources(
  answer: Pick<IssueListResult, "trackers">,
  sources: IssueListSources,
): IssueListSources {
  return sources.filter(
    (source) =>
      source.capabilities.create &&
      answer.trackers.find(
        (tracker) =>
          tracker.connectionId === source.connectionId &&
          tracker.tracker === source.tracker &&
          issueHostKey(tracker.host) === issueHostKey(source.host),
      )?.configured !== false,
  );
}

export function issueListRefreshSource(
  environmentId: EnvironmentId,
  listedEnvironmentIds: ReadonlyArray<EnvironmentId>,
  input: IssueListInput,
  source: IssueScopeRef,
  held: Pick<IssueListResult, "entries" | "sources"> | undefined,
): IssueScopeRef | null {
  if (!listedEnvironmentIds.includes(environmentId)) return null;
  const matches = (candidate: IssueScopeRef) =>
    candidate.connectionId === source.connectionId &&
    candidate.tracker === source.tracker &&
    (candidate.host === undefined ? undefined : issueHostKey(candidate.host)) ===
      (source.host === undefined ? undefined : issueHostKey(source.host)) &&
    issueScopeKeyOf(candidate) === issueScopeKeyOf(source);
  const representative = held?.entries.find(matches) ?? held?.sources?.find(matches);
  const canonical = representative ? { ...source, projectId: representative.projectId } : source;
  return issueSourceMatchesList(input, canonical) ? canonical : null;
}

export function issueListProjectScope<Project extends ScopedProject>(
  projects: ReadonlyArray<Project>,
  filter: {
    readonly projectId?: ProjectId | undefined;
    readonly environmentId?: EnvironmentId | undefined;
  },
  projectsKnown: boolean,
): Project | "waiting" | null {
  if (filter.projectId === undefined) return null;
  const project = findScopedProject(projects, filter.environmentId, filter.projectId);
  if (project !== undefined) return project;
  return projectsKnown ? null : "waiting";
}

export function issueFilterProjects<Project extends ScopedProject>(
  projects: ReadonlyArray<Project>,
  sources: ReadonlyMap<EnvironmentId, IssueListSources>,
  selected: ScopedProject | null,
): ReadonlyArray<
  Project & { readonly repositoryIdentity: { readonly canonicalKey: string } | null }
> {
  return projects.flatMap((project) => {
    const scopes = sources
      .get(project.environmentId)
      ?.filter((source) => source.projectId === project.id)
      .map((source) => issueListCursorKey({ ...source, scope: issueScopeKeyOf(source) }))
      .toSorted();
    const isSelected =
      project.id === selected?.id && project.environmentId === selected.environmentId;
    if (scopes?.length === 0 && !isSelected) return [];
    const repositoryIdentity = scopes ? { canonicalKey: JSON.stringify(scopes) } : null;
    return [{ ...project, repositoryIdentity }];
  });
}

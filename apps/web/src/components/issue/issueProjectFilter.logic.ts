import type {
  EnvironmentId,
  IssueListInput,
  IssueListResult,
  IssueScopeRef,
  ProjectId,
} from "@t3tools/contracts";
import { issueScopeKeyOf } from "@t3tools/contracts";

import { findScopedProject } from "../pullRequest/pullRequestList.logic";

interface ScopedProject {
  readonly id: ProjectId;
  readonly environmentId: EnvironmentId;
}

export type IssueListSources = NonNullable<IssueListResult["sources"]>;

export function issuePanelEnvironmentId(
  projects: ReadonlyArray<ScopedProject>,
  target: {
    readonly environmentId?: EnvironmentId | undefined;
    readonly projectId?: string | undefined;
  } | null,
): EnvironmentId | null {
  return (
    target?.environmentId ??
    findScopedProject(projects, undefined, target?.projectId)?.environmentId ??
    null
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
    candidate.tracker === source.tracker &&
    candidate.host?.toLowerCase() === source.host?.toLowerCase() &&
    issueScopeKeyOf(candidate) === issueScopeKeyOf(source);
  const representative = held?.entries.find(matches) ?? held?.sources?.find(matches);
  const canonical = representative ? { ...source, projectId: representative.projectId } : source;
  return (input.projectId === undefined || input.projectId === canonical.projectId) &&
    (input.host === undefined || input.host.toLowerCase() === canonical.host?.toLowerCase())
    ? canonical
    : null;
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
      .map((source) => `${source.tracker} ${source.host.toLowerCase()} ${issueScopeKeyOf(source)}`)
      .toSorted();
    const isSelected =
      project.id === selected?.id && project.environmentId === selected.environmentId;
    if (scopes?.length === 0 && !isSelected) return [];
    const repositoryIdentity = scopes ? { canonicalKey: JSON.stringify(scopes) } : null;
    return [{ ...project, repositoryIdentity }];
  });
}

export function issueCreateSources(
  answer: Pick<IssueListResult, "trackers">,
  sources: IssueListSources,
): IssueListSources {
  return sources.filter(
    (source) =>
      source.capabilities.create &&
      answer.trackers.find(
        (tracker) =>
          tracker.tracker === source.tracker &&
          tracker.host.toLowerCase() === source.host.toLowerCase(),
      )?.configured !== false,
  );
}

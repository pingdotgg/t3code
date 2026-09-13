import type { EnvironmentProject } from "@t3tools/client-runtime/state/shell";
import type { EnvironmentId, ScopedProjectRef, TaskId } from "@t3tools/contracts";
import { scopedProjectKey } from "../../lib/scopedEntities";
import type { HomeProjectScope } from "../home/homeThreadList";

export type TaskCreateContext = {
  readonly environmentId?: string;
  readonly projectId?: string;
};

/** Carry a physical filter through navigation without guessing within a logical group. */
export function resolveTaskCreateContext(input: {
  readonly environmentId: EnvironmentId | null;
  readonly projectKey: string | null;
  readonly projectScope: HomeProjectScope | null;
}): TaskCreateContext {
  const projects = input.projectScope?.projects.filter(
    (project) => input.environmentId === null || project.environmentId === input.environmentId,
  );
  const project =
    projects?.find(
      (candidate) => scopedProjectKey(candidate.environmentId, candidate.id) === input.projectKey,
    ) ?? (projects?.length === 1 ? projects[0] : undefined);
  return project
    ? { environmentId: project.environmentId, projectId: project.id }
    : input.environmentId === null
      ? {}
      : { environmentId: input.environmentId };
}

export function taskCreateProjects(input: {
  readonly projects: readonly EnvironmentProject[];
  readonly capableIds: ReadonlySet<EnvironmentId>;
  readonly context: TaskCreateContext | undefined;
}) {
  return input.projects.filter(
    (project) =>
      input.capableIds.has(project.environmentId) &&
      (input.context?.environmentId === undefined ||
        project.environmentId === input.context.environmentId),
  );
}

export function resolveTaskCreateProject(input: {
  readonly projects: readonly EnvironmentProject[];
  readonly selection: ScopedProjectRef | null;
  readonly context: TaskCreateContext | undefined;
}) {
  const requested = input.selection ?? input.context;
  return (
    input.projects.find(
      (project) =>
        project.environmentId === requested?.environmentId && project.id === requested?.projectId,
    ) ?? null
  );
}

/** Validate current eligibility again at submission and capture one scoped command target. */
export function taskCreateCommand(input: {
  readonly projects: readonly EnvironmentProject[];
  readonly selection: ScopedProjectRef | null;
  readonly context: TaskCreateContext | undefined;
  readonly taskId: TaskId;
  readonly name: string;
  readonly description: string;
}) {
  const project = resolveTaskCreateProject(input);
  const name = input.name.trim();
  if (project === null || name.length === 0) return null;
  return {
    environmentId: project.environmentId,
    input: {
      taskId: input.taskId,
      name,
      description: input.description.trim() || null,
      primaryProjectId: project.id,
    },
  };
}

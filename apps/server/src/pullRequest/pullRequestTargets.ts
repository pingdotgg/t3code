import type { OrchestrationProjectShell, PullRequestReadTarget } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import { sourceControlDefinitions } from "../sourceControl/sourceControlDefinitions.ts";
import { type PullRequestTarget, resolveTarget, type ResolvedTarget } from "./pullRequestTarget.ts";
import { ownPullRequestRepositories, pullRequestSyncKey } from "./pullRequestSyncKey.ts";

export type { PullRequestTargetError } from "./pullRequestTarget.ts";

export class PullRequestProjectNotFoundError extends Schema.TaggedError<PullRequestProjectNotFoundError>()(
  "PullRequestProjectNotFoundError",
  { repository: Schema.String },
) {
  override get message(): string {
    return `No project in this environment is a checkout of ${this.repository}, so its pull requests cannot be read here. Add one with t3_project_create.`;
  }
}

export type ResolvedPullRequestTarget = ResolvedTarget;

/** `resolveTarget`, with a bare number naming a pull request in the project's own repository. */
export const resolvePullRequestTarget = Effect.fn("PullRequestTargets.resolve")(function* (
  input: PullRequestTarget,
  project: OrchestrationProjectShell | undefined,
) {
  const repository =
    input.repository ??
    (project?.repositoryIdentity == null
      ? undefined
      : (sourceControlDefinitions.repositorySelector(project.repositoryIdentity) ?? undefined));
  return yield* resolveTarget({ ...input, repository }, project);
});

/** The project whose checkout and credentials read this pull request, the caller's when it fits. */
export function projectForPullRequest(
  projects: ReadonlyArray<OrchestrationProjectShell>,
  target: { readonly host: string; readonly repository: string },
  preferred: OrchestrationProjectShell | undefined,
): OrchestrationProjectShell | undefined {
  // Match the guide service's host-level repository key, including Azure DevOps org/project/_git/repo.
  const matches = (project: OrchestrationProjectShell) => {
    const own = pullRequestSyncKey(
      { projectId: project.id, host: target.host, repository: target.repository, number: 1 },
      project.repositoryIdentity ?? undefined,
    );
    const origin = project.repositoryIdentity?.origin;
    if (
      origin !== undefined &&
      own !== null &&
      sourceControlDefinitions.canonicalRepositoryKey(origin.canonicalKey) ===
        sourceControlDefinitions.canonicalRepositoryKey(`${own.host}/${own.repository}`)
    )
      return true;
    return (
      own !== null &&
      ownPullRequestRepositories(project.repositoryIdentity).some(
        ({ key }) => own.host === key.host && own.repository === key.repository,
      )
    );
  };
  if (preferred !== undefined && matches(preferred)) return preferred;
  return projects.find(matches);
}

/**
 * Named targets, each resolved and placed in the project that reads it. A target that cannot be
 * resolved keeps its typed failure so a batch answers the others. A `host` without a `url` builds the
 * URL through the project that holds that repository, which need not be the caller's.
 */
export const locatePullRequestTargets = Effect.fn("PullRequestTargets.locate")(function* (
  targets: ReadonlyArray<PullRequestReadTarget>,
  projects: ReadonlyArray<OrchestrationProjectShell>,
  callerProject: OrchestrationProjectShell | undefined,
) {
  const urlProject = (input: PullRequestReadTarget) =>
    input.url === undefined && input.host !== undefined && input.repository !== undefined
      ? (projectForPullRequest(
          projects,
          { host: input.host, repository: input.repository },
          callerProject,
        ) ?? callerProject)
      : callerProject;
  return yield* Effect.forEach(targets, (input) =>
    resolvePullRequestTarget(input, urlProject(input)).pipe(
      Effect.map((target) => ({
        input,
        target,
        project: projectForPullRequest(projects, target, callerProject),
        failure: null,
      })),
      Effect.catch((failure) =>
        Effect.succeed({ input, target: null, project: undefined, failure }),
      ),
    ),
  );
});

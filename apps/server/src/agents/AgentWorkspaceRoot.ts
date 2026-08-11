import * as Effect from "effect/Effect";

import {
  AgentProfileInvalidError,
  type AgentProfileScope,
  type ProjectId,
} from "@t3tools/contracts";

/** Resolve project roots only for project-scoped agent documents. */
export const resolveAgentWorkspaceRootForScope = <E>(
  scope: AgentProfileScope,
  projectId: ProjectId | undefined,
  resolveProject: (projectId: ProjectId) => Effect.Effect<string | undefined, E>,
): Effect.Effect<string | undefined, E | AgentProfileInvalidError> =>
  scope === "environment"
    ? Effect.void.pipe(Effect.as(undefined))
    : projectId === undefined
      ? Effect.fail(
          new AgentProfileInvalidError({
            detail: "Project-scoped agent entries require a project.",
          }),
        )
      : resolveProject(projectId);

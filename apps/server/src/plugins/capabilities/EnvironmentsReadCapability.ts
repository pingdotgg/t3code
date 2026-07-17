import type { EnvironmentsReadCapability } from "@t3tools/plugin-sdk";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import * as ServerEnvironment from "../../environment/ServerEnvironment.ts";
import * as ProjectionSnapshotQuery from "../../orchestration/Services/ProjectionSnapshotQuery.ts";

export function makeEnvironmentsReadCapability(input: {
  readonly environment: ServerEnvironment.ServerEnvironment["Service"];
  readonly snapshots: ProjectionSnapshotQuery.ProjectionSnapshotQuery["Service"];
}): EnvironmentsReadCapability {
  return {
    getEnvironmentId: input.environment.getEnvironmentId,
    getDescriptor: input.environment.getDescriptor,
    listProjects: input.snapshots
      .getShellSnapshot()
      .pipe(Effect.map((snapshot) => snapshot.projects)),
    getProjectById: (projectId) =>
      input.snapshots.getProjectShellById(projectId).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (project) => project,
          }),
        ),
      ),
    resolveProjectByWorkspaceRoot: (workspaceRoot) =>
      input.snapshots.getActiveProjectByWorkspaceRoot(workspaceRoot).pipe(
        Effect.map(
          Option.match({
            onNone: () => null,
            onSome: (project) => project,
          }),
        ),
      ),
  };
}

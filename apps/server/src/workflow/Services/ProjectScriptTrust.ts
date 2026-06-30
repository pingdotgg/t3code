import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import type { WorkflowEventStoreError } from "./Errors.ts";

export interface ProjectScriptTrustShape {
  readonly isTrusted: (projectId: ProjectId) => Effect.Effect<boolean, WorkflowEventStoreError>;
  readonly setTrusted: (
    projectId: ProjectId,
    trusted: boolean,
  ) => Effect.Effect<void, WorkflowEventStoreError>;
}

export class ProjectScriptTrust extends Context.Service<
  ProjectScriptTrust,
  ProjectScriptTrustShape
>()("t3/workflow/Services/ProjectScriptTrust") {}

export const ProjectScriptTrustDenyAll = Layer.succeed(ProjectScriptTrust, {
  isTrusted: () => Effect.succeed(false),
  setTrusted: () => Effect.void,
} satisfies ProjectScriptTrustShape);

import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ProjectWorkspaceResolverError extends Schema.TaggedErrorClass<ProjectWorkspaceResolverError>()(
  "ProjectWorkspaceResolverError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {}

export interface ProjectWorkspaceResolverShape {
  readonly resolve: (projectId: ProjectId) => Effect.Effect<string, ProjectWorkspaceResolverError>;
}

export class ProjectWorkspaceResolver extends Context.Service<
  ProjectWorkspaceResolver,
  ProjectWorkspaceResolverShape
>()("t3/workflow/Services/ProjectWorkspaceResolver") {}

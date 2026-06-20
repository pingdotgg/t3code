/**
 * ProjectFaviconResolver - Effect service contract for project icon discovery.
 *
 * Resolves a representative favicon or app icon file for a workspace by
 * checking common file locations and project source metadata.
 *
 * @module ProjectFaviconResolver
 */
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class ProjectFaviconResolutionError extends Schema.TaggedErrorClass<ProjectFaviconResolutionError>()(
  "ProjectFaviconResolutionError",
  {
    operation: Schema.Literals([
      "normalize-workspace",
      "resolve-path",
      "stat-candidate",
      "read-source",
    ]),
    workspaceRoot: Schema.String,
    relativePath: Schema.optional(Schema.String),
    absolutePath: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to resolve project favicon during ${this.operation} for workspace ${this.workspaceRoot}.`;
  }
}

/**
 * ProjectFaviconResolverShape - Service API for project favicon lookup.
 */
export interface ProjectFaviconResolverShape {
  /**
   * Resolve a favicon or icon file path for the provided workspace root.
   *
   * Returns `null` when no candidate icon file can be found.
   */
  readonly resolvePath: (
    cwd: string,
  ) => Effect.Effect<string | null, ProjectFaviconResolutionError>;
}

/**
 * ProjectFaviconResolver - Service tag for project favicon resolution.
 */
export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  ProjectFaviconResolverShape
>()("t3/project/Services/ProjectFaviconResolver") {}
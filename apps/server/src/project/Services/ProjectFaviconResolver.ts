/**
 * ProjectFaviconResolver - Effect service contract for project icon discovery.
 *
 * Resolves a representative favicon or app icon file for a workspace by
 * checking common file locations and project source metadata.
 *
 * @module ProjectFaviconResolver
 */
import { Context } from "effect";
import type { Effect } from "effect";

/**
 * ProjectFaviconResolverShape - Service API for project favicon lookup.
 */
export interface ProjectFaviconResolverShape {
  /**
   * Resolve a favicon or icon file path for the provided workspace root.
   *
   * Returns `null` when no candidate icon file can be found.
   */
  readonly resolvePath: (cwd: string) => Effect.Effect<string | null>;
}

/**
 * ProjectFaviconResolver - Service tag for project favicon resolution.
 */
export class ProjectFaviconResolver extends Context.Service<
  ProjectFaviconResolver,
  ProjectFaviconResolverShape
>()("t3/project/Services/ProjectFaviconResolver") {}

import type { ProjectScript } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

export interface ProjectConfigResolverResult {
  readonly scripts?: ProjectScript[] | undefined;
  readonly browserPreviewUrl?: string | null | undefined;
}

export interface ProjectConfigResolverShape {
  readonly resolve: (input: { readonly cwd: string }) => Effect.Effect<ProjectConfigResolverResult>;
}

export class ProjectConfigResolver extends Context.Service<
  ProjectConfigResolver,
  ProjectConfigResolverShape
>()("t3/project/Services/ProjectConfigResolver") {}

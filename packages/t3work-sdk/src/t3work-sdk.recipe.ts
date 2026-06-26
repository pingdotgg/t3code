import { getRegistry } from "./t3work-sdk.internal.ts";
import type * as T from "./t3work-sdk.types.ts";

export function defineRecipe<RInputs, ROutputs>(opts: {
  readonly id: string;
  readonly version: string;
  readonly scope?: "project";
  readonly title: string;
  readonly shortDescription: string;
  readonly surfaces: ReadonlyArray<string>;
  readonly icon?: string;
  readonly rank?: number;
  readonly appliesTo?: T.RecipeApplicabilitySpec;
  readonly allowedToolGroups?: ReadonlyArray<string>;
  readonly slashAlias?: string;
  readonly defaultAction: T.WorkflowRef<RInputs, ROutputs>;
  readonly defaults?: Partial<RInputs>;
}): T.RecipeRef<RInputs, ROutputs> {
  if (opts.scope !== undefined && opts.scope !== "project") {
    throw new Error(`Recipe '${opts.id}': only project-scoped recipes are supported.`);
  }
  if (opts.id.trim().length === 0) {
    throw new Error("Recipe must include a non-empty id.");
  }
  if (opts.version.trim().length === 0) {
    throw new Error(`Recipe '${opts.id}' must include a non-empty version.`);
  }

  const ref = Object.freeze({
    kind: "recipe" as const,
    id: opts.id,
    version: opts.version,
    scope: "project" as const,
    title: opts.title,
    shortDescription: opts.shortDescription,
    surfaces: opts.surfaces,
    ...(opts.icon === undefined ? {} : { icon: opts.icon }),
    ...(opts.rank === undefined ? {} : { rank: opts.rank }),
    ...(opts.appliesTo === undefined ? {} : { appliesTo: opts.appliesTo }),
    ...(opts.allowedToolGroups === undefined ? {} : { allowedToolGroups: opts.allowedToolGroups }),
    ...(opts.slashAlias === undefined ? {} : { slashAlias: opts.slashAlias }),
    defaultAction: opts.defaultAction,
    ...(opts.defaults === undefined ? {} : { defaults: opts.defaults }),
  }) as T.RecipeRef<RInputs, ROutputs>;

  getRegistry().recipes.set(opts.id, ref as T.AnyRecipeRef);
  return ref;
}

export function getRegisteredRecipe(recipeId: string): T.AnyRecipeRef | undefined {
  return getRegistry().recipes.get(recipeId);
}

export function listRegisteredRecipes(): ReadonlyArray<T.AnyRecipeRef> {
  return Object.freeze(Array.from(getRegistry().recipes.values()));
}

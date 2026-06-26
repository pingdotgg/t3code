/**
 * Recipe-module discovery (Epic 16 §Plugin Modules): load a project-local `recipe.ts` — a typed
 * `defineRecipe(...)` plugin module — and map it onto the SAME {@link ProjectRecipeDiscovered}
 * shape the catalog/launcher already consumes for `recipe.json` recipes.
 *
 * This is the "import() a typed module" path the doc calls for, sitting alongside the legacy
 * "parse JSON + eval `{{ }}` strings" path in {@link ./t3work-projectRecipeDiscoveryRecipe.ts}.
 * The recipe's `defaultAction` is a typed `WorkflowRef`; its resolved `.workflow.ts` becomes the
 * discovery result's `workflowPath`, which the existing engine launch path
 * ({@link ./t3work-workflowEngineLaunch.ts} `launchWorkflowRecipe`) runs unchanged.
 *
 * Module loading mirrors `visible.ts` evaluation ({@link ./t3work-projectRecipeDiscoveryVisibility.ts}):
 * a `pathToFileURL` import with a millisecond cache-buster so an edited recipe re-imports fresh.
 */

import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { pathToFileURL } from "node:url";

import { queryableToReadonlyArray } from "@t3tools/project-context";
import {
  matchRecipes,
  type ProjectRecipeDiscovered,
  type ProjectRecipeRenderContext,
  type Recipe,
  type RecipeApplicability,
  type RecipeMatchInput,
  type RecipeSurface,
} from "@t3tools/project-recipes";
import type { AnyRecipeRef } from "@t3work/sdk";

import { isRelativePath, resolveWithinRoot } from "./t3work-projectRecipeDiscoveryShared.ts";

/**
 * Project the SDK `RecipeRef`'s discovery metadata onto a project-recipes `Recipe` so the locked
 * {@link matchRecipes} applicability/scoring engine — the same one bundled recipes use — decides
 * visibility and rank. Keeps recipe.ts and recipe.json recipes ranked on one ruleset.
 */
function toRecipe(ref: AnyRecipeRef): Recipe {
  return {
    id: ref.id,
    title: ref.title,
    shortDescription: ref.shortDescription,
    surfaces: ref.surfaces as ReadonlyArray<RecipeSurface>,
    appliesTo: (ref.appliesTo ?? {}) as RecipeApplicability,
    requiredContext: [],
    outputPreference: "markdown",
    ...(ref.icon !== undefined ? { icon: ref.icon } : {}),
    ...(ref.rank !== undefined ? { rankHint: ref.rank } : {}),
  };
}

/** Build a {@link RecipeMatchInput} from the render context (mirrors the bundled-compat matcher). */
function buildMatchInput(context: ProjectRecipeRenderContext): RecipeMatchInput {
  const provider = context.project.provider;
  const linkedProviders = queryableToReadonlyArray(context.linkedResources)
    .map((resource) => resource.provider)
    .filter((value): value is string => typeof value === "string" && value.length > 0);
  return {
    activeProject: provider ? { source: { provider } } : {},
    selectedResource: null,
    resourceKind: context.workitem?.kind ?? null,
    availableIntegrations: [...new Set([...(provider ? [provider] : []), ...linkedProviders])],
    surface: context.surface,
    ...(context.workitem?.type ? { jiraIssueType: context.workitem.type } : {}),
    enabledSkillPacks: context.enabledSkillPacks,
    profile: context.profile,
    availableContextKeys: queryableToReadonlyArray(context.availableContextKeys),
  };
}

/**
 * Resolve the recipe's `defaultAction` workflow to an absolute path within the recipe directory.
 * Recompute from `recipePath` + the ref's original relative `path` (rather than trusting the ref's
 * stack-derived `absolutePath`) so resolution is stable regardless of how the module was loaded;
 * fall back to `absolutePath` for absolute / `file://` author forms.
 */
function resolveWorkflowPath(
  pathService: Path.Path,
  recipePath: string,
  ref: AnyRecipeRef,
): string {
  const actionPath = ref.defaultAction.path;
  return isRelativePath(actionPath)
    ? resolveWithinRoot(pathService, recipePath, actionPath)
    : ref.defaultAction.absolutePath;
}

export const discoverProjectRecipeModuleAtPath = Effect.fn("discoverProjectRecipeModuleAtPath")(
  function* (input: {
    readonly workspaceRoot: string;
    readonly recipePath: string;
    /** Absolute path to the recipe's `recipe.ts`. */
    readonly modulePath: string;
    readonly context: ProjectRecipeRenderContext;
  }) {
    const pathService = yield* Path.Path;

    const moduleUrl = pathToFileURL(input.modulePath);
    moduleUrl.searchParams.set("v", String(yield* Clock.currentTimeMillis));
    const imported = (yield* Effect.tryPromise(() => import(moduleUrl.toString()))) as {
      readonly default?: AnyRecipeRef;
    };

    const ref = imported.default;
    if (!ref || ref.kind !== "recipe") {
      throw new Error(
        `recipe.ts must default-export a defineRecipe(...) result: ${input.modulePath}`,
      );
    }
    if (!ref.surfaces.includes(input.context.surface)) {
      return Option.none<ProjectRecipeDiscovered>();
    }

    const match = matchRecipes([toRecipe(ref)], buildMatchInput(input.context))[0];
    if (!match) {
      return Option.none<ProjectRecipeDiscovered>();
    }

    const workflowPath = resolveWorkflowPath(pathService, input.recipePath, ref);

    return Option.some({
      id: ref.id,
      version: ref.version,
      source: "project-local",
      displayName: ref.title,
      shortDescription: ref.shortDescription,
      ...(ref.icon ? { icon: ref.icon } : {}),
      surfaces: ref.surfaces as ReadonlyArray<RecipeSurface>,
      rank: match.score,
      ...(match.reason ? { reason: match.reason } : {}),
      // recipe.ts recipes are workflow-first: their prompt material lives in the `.workflow.ts`
      // body (each `agent` call), not a separate prompt.md, so the legacy prompt fields are empty.
      prompt: "",
      promptPath: "",
      sourcePath: input.modulePath,
      recipePath: input.recipePath,
      workflowPath,
      allowedToolGroups: ref.allowedToolGroups ?? [],
    } satisfies ProjectRecipeDiscovered);
  },
);

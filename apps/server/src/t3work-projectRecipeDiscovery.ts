import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { normalizeQueryable } from "@t3tools/project-context";
import {
  type ProjectRecipeDiscovered,
  type ProjectRecipeRenderContext,
} from "@t3tools/project-recipes";

import { discoverProjectRecipeAtPath, sortRecipes } from "./t3work-projectRecipeDiscoveryRecipe.ts";
import { T3WORK_PROJECT_RECIPES_ROOT } from "./t3work-projectSetupShared.ts";

function normalizeRenderContext(context: ProjectRecipeRenderContext): ProjectRecipeRenderContext {
  return {
    ...context,
    linkedResources: normalizeQueryable(context.linkedResources),
    artifacts: normalizeQueryable(context.artifacts),
    ...(context.contextAttachments
      ? { contextAttachments: normalizeQueryable(context.contextAttachments) }
      : {}),
    availableContextKeys: normalizeQueryable(context.availableContextKeys),
  };
}

export const discoverProjectRecipes = Effect.fn("discoverProjectRecipes")(function* (input: {
  readonly workspaceRoot: string;
  readonly context: ProjectRecipeRenderContext;
}) {
  const fileSystem = yield* FileSystem.FileSystem;
  const pathService = yield* Path.Path;
  const workspaceRoot = pathService.resolve(input.workspaceRoot);
  const context = normalizeRenderContext(input.context);
  const recipesRoot = pathService.join(workspaceRoot, T3WORK_PROJECT_RECIPES_ROOT);
  if (!(yield* fileSystem.exists(recipesRoot).pipe(Effect.orElseSucceed(() => false)))) {
    return {
      workspaceRoot,
      hasProjectLocalRecipes: false,
      recipes: [],
    };
  }

  const recipeEntries = yield* fileSystem.readDirectory(recipesRoot, { recursive: false });
  const discoveredRecipes: ProjectRecipeDiscovered[] = [];
  let hasProjectLocalRecipes = false;

  for (const entry of recipeEntries) {
    const recipePath = pathService.join(recipesRoot, entry);
    const entryStat = yield* fileSystem
      .stat(recipePath)
      .pipe(Effect.catch(() => Effect.succeed(null)));
    if (!entryStat || entryStat.type !== "Directory") {
      continue;
    }
    const maybeRecipe = yield* discoverProjectRecipeAtPath({
      workspaceRoot,
      recipePath,
      context,
    }).pipe(Effect.catch(() => Effect.succeed(Option.none<ProjectRecipeDiscovered>())));

    if (
      (yield* fileSystem
        .exists(pathService.join(recipePath, "recipe.json"))
        .pipe(Effect.orElseSucceed(() => false))) ||
      (yield* fileSystem
        .exists(pathService.join(recipePath, "recipe.ts"))
        .pipe(Effect.orElseSucceed(() => false)))
    ) {
      hasProjectLocalRecipes = true;
    }

    if (Option.isSome(maybeRecipe)) {
      discoveredRecipes.push(maybeRecipe.value);
    }
  }

  return {
    workspaceRoot,
    hasProjectLocalRecipes,
    recipes: discoveredRecipes.toSorted(sortRecipes),
  };
});

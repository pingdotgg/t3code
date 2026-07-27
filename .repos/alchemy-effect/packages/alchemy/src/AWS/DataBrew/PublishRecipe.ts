import type * as SVC from "@distilled.cloud/aws/databrew";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Recipe } from "./Recipe.ts";

export interface PublishRecipeRequest extends Omit<
  SVC.PublishRecipeRequest,
  "Name"
> {}

/**
 * Runtime binding for `databrew:PublishRecipe` — snapshots the bound
 * recipe's `LATEST_WORKING` steps as the next numbered published version
 * (recipe jobs consume the latest published version by default).
 * @binding
 * @section Publishing Recipes
 * @example Publish a New Version
 * ```typescript
 * const publishRecipe = yield* AWS.DataBrew.PublishRecipe(recipe);
 *
 * const { Name } = yield* publishRecipe({ Description: "nightly cut" });
 * ```
 */
export interface PublishRecipe extends Binding.Service<
  PublishRecipe,
  "AWS.DataBrew.PublishRecipe",
  <R extends Recipe>(
    recipe: R,
  ) => Effect.Effect<
    (
      request?: PublishRecipeRequest,
    ) => Effect.Effect<SVC.PublishRecipeResponse, SVC.PublishRecipeError>
  >
> {}
export const PublishRecipe = Binding.Service<PublishRecipe>(
  "AWS.DataBrew.PublishRecipe",
);

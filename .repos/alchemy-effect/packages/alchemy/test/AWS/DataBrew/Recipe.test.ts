import * as AWS from "@/AWS";
import { Recipe } from "@/AWS/DataBrew";
import * as Test from "@/Test/Alchemy";
import * as databrew from "@distilled.cloud/aws/databrew";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getWorkingRecipe = (name: string) =>
  databrew
    .describeRecipe({ Name: name, RecipeVersion: "LATEST_WORKING" })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );

test.provider(
  "create, publish, update, delete DataBrew recipe",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const recipe = yield* Recipe("Clean", {
            description: "normalize names",
            publish: true,
            steps: [
              {
                action: {
                  operation: "UPPER_CASE",
                  parameters: { sourceColumn: "name" },
                },
              },
            ],
            tags: { Environment: "test" },
          });
          return { recipe };
        }),
      );

      expect(created.recipe.recipeName).toBeDefined();
      expect(created.recipe.recipeArn).toContain(
        `:recipe/${created.recipe.recipeName}`,
      );
      // publish: true snapshots version 1.0 on create
      expect(created.recipe.recipeVersion).toEqual("1.0");

      // out-of-band verification of the working copy
      const observed = yield* getWorkingRecipe(created.recipe.recipeName);
      expect(observed?.Description).toEqual("normalize names");
      expect(observed?.Steps?.length).toEqual(1);
      expect(observed?.Steps?.[0]?.Action.Operation).toEqual("UPPER_CASE");
      expect(observed?.Tags?.["alchemy::id"]).toBeDefined();

      // idempotent re-deploy: no step change -> no new published version
      const same = yield* stack.deploy(
        Effect.gen(function* () {
          const recipe = yield* Recipe("Clean", {
            description: "normalize names",
            publish: true,
            steps: [
              {
                action: {
                  operation: "UPPER_CASE",
                  parameters: { sourceColumn: "name" },
                },
              },
            ],
            tags: { Environment: "test" },
          });
          return { recipe };
        }),
      );
      expect(same.recipe.recipeVersion).toEqual("1.0");

      // update the steps -> working copy changes -> version 2.0 published
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          const recipe = yield* Recipe("Clean", {
            description: "normalize names",
            publish: true,
            steps: [
              {
                action: {
                  operation: "UPPER_CASE",
                  parameters: { sourceColumn: "name" },
                },
              },
              {
                action: {
                  operation: "REMOVE_VALUES",
                  parameters: { sourceColumn: "email" },
                },
                conditionExpressions: [
                  { condition: "IS_MISSING", targetColumn: "email" },
                ],
              },
            ],
            tags: { Environment: "test" },
          });
          return { recipe };
        }),
      );
      expect(updated.recipe.recipeVersion).toEqual("2.0");

      const reobserved = yield* getWorkingRecipe(created.recipe.recipeName);
      expect(reobserved?.Steps?.length).toEqual(2);
      expect(reobserved?.Steps?.[1]?.Action.Operation).toEqual("REMOVE_VALUES");
      expect(
        reobserved?.Steps?.[1]?.ConditionExpressions?.[0]?.Condition,
      ).toEqual("IS_MISSING");

      // destroy deletes every version (published + working)
      yield* stack.destroy();
      const gone = yield* getWorkingRecipe(created.recipe.recipeName);
      expect(gone).toBeUndefined();
    }),
  { timeout: 120_000 },
);

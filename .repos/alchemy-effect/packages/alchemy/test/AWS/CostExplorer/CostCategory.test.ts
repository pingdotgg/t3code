import * as AWS from "@/AWS";
import { CostCategory } from "@/AWS/CostExplorer/CostCategory.ts";
import * as Test from "@/Test/Alchemy";
import { Region as AwsRegion } from "@distilled.cloud/aws/Region";
import * as ce from "@distilled.cloud/aws/cost-explorer";
import * as sts from "@distilled.cloud/aws/sts";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: AWS.providers() });

// Cost Explorer is served exclusively from us-east-1.
const pin = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provideService(AwsRegion, Effect.succeed("us-east-1")));

const categoryName = "alchemy-test-cost-category";

const getCategory = (costCategoryArn: string) =>
  pin(
    ce.describeCostCategoryDefinition({ CostCategoryArn: costCategoryArn }),
  ).pipe(
    Effect.map((r) => r.CostCategory),
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );

// Typed wait-until-gone on delete.
const assertCategoryGone = (costCategoryArn: string) =>
  Effect.gen(function* () {
    const found = yield* getCategory(costCategoryArn);
    if (found !== undefined && found.EffectiveEnd === undefined) {
      return yield* Effect.fail(
        new Error(`cost category '${costCategoryArn}' still exists`),
      );
    }
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.fixed("2 seconds"), Schedule.recurs(5)]),
    }),
  );

// Ungated typed-error probe: prove the distilled error union carries the
// not-found tag this provider's read/delete paths depend on.
test.provider(
  "describeCostCategoryDefinition on a nonexistent ARN fails with ResourceNotFoundException",
  () =>
    Effect.gen(function* () {
      const identity = yield* sts.getCallerIdentity({});
      const error = yield* Effect.flip(
        pin(
          ce.describeCostCategoryDefinition({
            CostCategoryArn: `arn:aws:ce::${identity.Account}:costcategory/00000000-0000-0000-0000-000000000000`,
          }),
        ),
      );
      expect(error._tag).toBe("ResourceNotFoundException");
    }),
  { timeout: 60_000 },
);

const makeStack = (name: string, matchValue: string, defaultValue: string) =>
  Effect.gen(function* () {
    const category = yield* CostCategory("Category", {
      name,
      rules: [
        {
          Value: "tagged",
          Type: "REGULAR",
          Rule: {
            Tags: {
              Key: "CostCenter",
              Values: [matchValue],
              MatchOptions: ["EQUALS"],
            },
          },
        },
      ],
      defaultValue,
      tags: { fixture: "cost-explorer-cost-category" },
    });
    return {
      costCategoryArn: category.costCategoryArn,
      name: category.name,
      effectiveStart: category.effectiveStart,
    };
  });

test.provider(
  "lifecycle: create cost category, update rules in place, replace on rename, destroy",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        makeStack(categoryName, "alchemy-test", "other"),
      );
      expect(deployed.name).toBe(categoryName);
      expect(deployed.effectiveStart).toBeDefined();

      // Out-of-band verification via distilled.
      const created = yield* getCategory(deployed.costCategoryArn);
      expect(created?.Name).toBe(categoryName);
      expect(created?.DefaultValue).toBe("other");
      expect(created?.Rules[0]?.Value).toBe("tagged");
      expect(created?.Rules[0]?.Rule?.Tags?.Values).toEqual(["alchemy-test"]);

      // Update — rules and default value are mutable in place.
      const updated = yield* stack.deploy(
        makeStack(categoryName, "alchemy-test-updated", "uncategorized"),
      );
      expect(updated.costCategoryArn).toBe(deployed.costCategoryArn);
      const afterUpdate = yield* getCategory(deployed.costCategoryArn);
      expect(afterUpdate?.DefaultValue).toBe("uncategorized");
      expect(afterUpdate?.Rules[0]?.Rule?.Tags?.Values).toEqual([
        "alchemy-test-updated",
      ]);

      // Rename — the name is create-only, must replace (new ARN).
      const replaced = yield* stack.deploy(
        makeStack(`${categoryName}-2`, "alchemy-test-updated", "uncategorized"),
      );
      expect(replaced.costCategoryArn).not.toBe(deployed.costCategoryArn);
      yield* assertCategoryGone(deployed.costCategoryArn);

      // Destroy — the category is gone.
      yield* stack.destroy();
      yield* assertCategoryGone(replaced.costCategoryArn);
    }),
  { timeout: 120_000 },
);

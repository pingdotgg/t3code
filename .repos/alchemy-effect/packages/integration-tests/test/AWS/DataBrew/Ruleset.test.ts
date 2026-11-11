import * as AWS from "@alchemy.run/aws";
import { Dataset, Ruleset } from "@alchemy.run/aws/DataBrew";
import { Bucket } from "@alchemy.run/aws/S3";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as databrew from "@distilled.cloud/aws/databrew";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getRuleset = (name: string) =>
  databrew
    .describeRuleset({ Name: name })
    .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.succeed(undefined)));

test.provider(
  "create, update, delete DataBrew ruleset",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const created = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("RulesetBucket", { forceDestroy: true });
          const dataset = yield* Dataset("Source", {
            format: "CSV",
            input: {
              s3InputDefinition: {
                bucket: bucket.bucketName,
                key: "raw/data.csv",
              },
            },
          });
          const ruleset = yield* Ruleset("Quality", {
            description: "basic data quality",
            targetArn: dataset.datasetArn,
            rules: [
              {
                name: "no-missing-ids",
                checkExpression: "AGG(MISSING_VALUES_PERCENTAGE) == :val1",
                substitutionMap: { ":val1": "0" },
                columnSelectors: [{ name: "id" }],
              },
            ],
            tags: { Environment: "test" },
          });
          return { bucket, dataset, ruleset };
        }),
      );

      expect(created.ruleset.rulesetName).toBeDefined();
      expect(created.ruleset.rulesetArn).toContain(`:ruleset/${created.ruleset.rulesetName}`);
      expect(created.ruleset.targetArn).toEqual(created.dataset.datasetArn);

      // out-of-band verification
      const observed = yield* getRuleset(created.ruleset.rulesetName);
      expect(observed?.TargetArn).toEqual(created.dataset.datasetArn);
      expect(observed?.Rules?.length).toEqual(1);
      expect(observed?.Rules?.[0]?.Name).toEqual("no-missing-ids");
      expect(observed?.Tags?.["alchemy::id"]).toBeDefined();

      // update: add a second rule
      yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Bucket("RulesetBucket", { forceDestroy: true });
          const dataset = yield* Dataset("Source", {
            format: "CSV",
            input: {
              s3InputDefinition: {
                bucket: bucket.bucketName,
                key: "raw/data.csv",
              },
            },
          });
          const ruleset = yield* Ruleset("Quality", {
            description: "basic data quality v2",
            targetArn: dataset.datasetArn,
            rules: [
              {
                name: "no-missing-ids",
                checkExpression: "AGG(MISSING_VALUES_PERCENTAGE) == :val1",
                substitutionMap: { ":val1": "0" },
                columnSelectors: [{ name: "id" }],
              },
              {
                name: "row-count",
                checkExpression: "AGG(DUPLICATE_ROWS_COUNT) == :val1",
                substitutionMap: { ":val1": "0" },
              },
            ],
            tags: { Environment: "test" },
          });
          return { ruleset };
        }),
      );

      const reobserved = yield* getRuleset(created.ruleset.rulesetName);
      expect(reobserved?.Description).toEqual("basic data quality v2");
      expect(reobserved?.Rules?.length).toEqual(2);

      yield* stack.destroy();
      const gone = yield* getRuleset(created.ruleset.rulesetName);
      expect(gone).toBeUndefined();
    }),
  {
    tags: ["provider:aws", "provider:aws:databrew", "provider:aws:s3", "live"],
    timeout: 120_000,
  },
);

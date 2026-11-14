import * as AWS from "@alchemy.run/aws";
import { Database } from "@alchemy.run/aws/Glue";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as glue from "@distilled.cloud/aws/glue";
import * as Effect from "effect/Effect";
import { driftOf, repairDrift, waitForDrift } from "../drift.ts";

const { test } = Test.make({ providers: AWS.providers() });

const getDatabase = (name: string) =>
  glue.getDatabase({ Name: name }).pipe(
    Effect.map((r) => r.Database),
    Effect.catchTag("EntityNotFoundException", () => Effect.succeed(undefined)),
  );

test.provider(
  "create, update, delete Glue database",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      // create
      const created = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Database("AnalyticsDb", {
            description: "analytics tables",
            parameters: { classification: "parquet" },
          });
        }),
      );

      expect(created.databaseName).toBeDefined();
      expect(created.databaseArn).toContain(`:database/${created.databaseName}`);
      expect(created.catalogId).toBeDefined();

      // out-of-band verification
      const observed = yield* getDatabase(created.databaseName);
      expect(observed?.Name).toEqual(created.databaseName);
      expect(observed?.Description).toEqual("analytics tables");
      expect(observed?.Parameters?.classification).toEqual("parquet");
      // ownership markers live in the Parameters map (databases aren't taggable)
      expect(observed?.Parameters?.["alchemy::id"]).toBeDefined();

      // update: description + parameters
      const updated = yield* stack.deploy(
        Effect.gen(function* () {
          return yield* Database("AnalyticsDb", {
            description: "curated analytics tables",
            locationUri: "s3://example-bucket/analytics/",
            parameters: { classification: "json" },
          });
        }),
      );

      expect(updated.databaseName).toEqual(created.databaseName);
      const reobserved = yield* getDatabase(created.databaseName);
      expect(reobserved?.Description).toEqual("curated analytics tables");
      expect(reobserved?.LocationUri).toEqual("s3://example-bucket/analytics/");
      expect(reobserved?.Parameters?.classification).toEqual("json");

      // delete
      yield* stack.destroy();
      const gone = yield* getDatabase(created.databaseName);
      expect(gone).toBeUndefined();
    }),
  { tags: ["provider:aws", "provider:aws:glue", "live"] },
);

// #2688: `read` must observe the description, location and parameters, or
// an out-of-band change reads as `unchanged`.
test.provider(
  "drift detects and repairs out-of-band database changes",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const db = yield* stack.deploy(
        Database("DriftDb", {
          description: "declared",
          parameters: { classification: "parquet" },
        }),
      );
      expect((yield* driftOf(stack, "DriftDb"))?.action).toBe("unchanged");

      const observed = yield* getDatabase(db.databaseName);
      yield* glue.updateDatabase({
        Name: db.databaseName,
        DatabaseInput: {
          Name: db.databaseName,
          Description: "out-of-band",
          Parameters: { ...observed?.Parameters, classification: "json" },
        },
      });

      const drifted = yield* waitForDrift(stack, "DriftDb", "drifted");
      expect(drifted?.attr?.configuration?.description).toBe("out-of-band");

      const repaired = yield* repairDrift(stack);
      expect(repaired.resources.DriftDb?.action).toBe("repaired");
      expect((yield* driftOf(stack, "DriftDb"))?.action).toBe("unchanged");
      const restored = yield* getDatabase(db.databaseName);
      expect(restored?.Description).toBe("declared");
      expect(restored?.Parameters?.classification).toBe("parquet");

      yield* stack.destroy();
      expect(yield* getDatabase(db.databaseName)).toBeUndefined();
    }),
  { tags: ["provider:aws", "provider:aws:glue", "live"] },
);

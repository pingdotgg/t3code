import * as AWS from "@/AWS";
import { Database } from "@/AWS/Glue";
import * as Test from "@/Test/Alchemy";
import * as glue from "@distilled.cloud/aws/glue";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";

const { test } = Test.make({ providers: AWS.providers() });

const getDatabase = (name: string) =>
  glue.getDatabase({ Name: name }).pipe(
    Effect.map((r) => r.Database),
    Effect.catchTag("EntityNotFoundException", () => Effect.succeed(undefined)),
  );

test.provider("create, update, delete Glue database", (stack) =>
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
);

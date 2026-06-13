import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Test from "@/Test/Vitest";
import * as vectorize from "@distilled.cloud/cloudflare/vectorize";
import { expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

test.provider("create and delete index with explicit dimensions", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const index = yield* stack.deploy(
      Cloudflare.VectorizeIndex("DefaultIndex", {
        dimensions: 768,
        metric: "cosine",
      }),
    );

    expect(index.indexName).toBeDefined();
    expect(index.dimensions).toEqual(768);
    expect(index.metric).toEqual("cosine");

    const actual = yield* vectorize.getIndex({
      accountId,
      indexName: index.indexName,
    });
    expect(actual.name).toEqual(index.indexName);
    expect(actual.config?.dimensions).toEqual(768);

    yield* stack.destroy();

    yield* waitForDelete(accountId, index.indexName);
  }).pipe(logLevel),
);

test.provider("create index from a preset", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const index = yield* stack.deploy(
      Cloudflare.VectorizeIndex("PresetIndex", {
        preset: "@cf/baai/bge-base-en-v1.5",
        description: "preset index",
      }),
    );

    const actual = yield* vectorize.getIndex({
      accountId,
      indexName: index.indexName,
    });
    // bge-base resolves to 768 dimensions.
    expect(actual.config?.dimensions).toEqual(768);
    expect(index.description).toEqual("preset index");

    yield* stack.destroy();

    yield* waitForDelete(accountId, index.indexName);
  }).pipe(logLevel),
);

test.provider("replaces index when dimensions change", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* CloudflareEnvironment;

    yield* stack.destroy();

    const index = yield* stack.deploy(
      Cloudflare.VectorizeIndex("ReplaceIndex", {
        dimensions: 32,
        metric: "cosine",
      }),
    );
    expect(index.dimensions).toEqual(32);
    expect(index.metric).toEqual("cosine");

    const replaced = yield* stack.deploy(
      Cloudflare.VectorizeIndex("ReplaceIndex", {
        dimensions: 64,
        metric: "euclidean",
      }),
    );

    const actual = yield* vectorize.getIndex({
      accountId,
      indexName: replaced.indexName,
    });
    expect(actual.config?.dimensions).toEqual(64);
    expect(actual.config?.metric).toEqual("euclidean");

    yield* stack.destroy();

    yield* waitForDelete(accountId, replaced.indexName);
  }).pipe(logLevel),
);

const waitForDelete = (accountId: string, indexName: string) =>
  vectorize.getIndex({ accountId, indexName }).pipe(
    Effect.flatMap((index) =>
      index.name === indexName
        ? Effect.fail({ _tag: "IndexNotDeleted" } as const)
        : Effect.void,
    ),
    Effect.catchTag(["NotFound", "Gone"], () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "IndexNotDeleted",
      schedule: Schedule.exponential("500 millis").pipe(
        Schedule.both(Schedule.recurs(10)),
      ),
    }),
  );

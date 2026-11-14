import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as Output from "alchemy/Output";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { MinimumLogLevel } from "effect/References";
import { apiToken, PageView } from "./fixtures/pipelines-shared.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const getPipeline = (accountId: string, pipelineId: string) =>
  pipelines.getV1Pipeline({ accountId, pipelineId });

/**
 * The whole Basin topology in one deploy: a typed stream, a catalog sink
 * that takes the Catalog resource (so it is created after the catalog),
 * and the SQL pipeline between them.
 */
const lakehouse = (sql: (stream: string, sink: string) => string) =>
  Effect.gen(function* () {
    const token = yield* apiToken;
    const bucket = yield* Cloudflare.R2.Bucket("LakeBucket", { forceDestroy: true });
    const catalog = yield* Cloudflare.Basin.Catalog("Catalog", {
      bucket,
    });
    const stream = yield* Cloudflare.Basin.Stream("PageViews", { schema: PageView });
    const sink = yield* Cloudflare.Basin.Sink("PageViewTable", {
      type: "basin_catalog",
      catalog,
      table: { namespace: "web", name: "page_views" },
      token,
    });
    const pipeline = yield* Cloudflare.Basin.Pipeline("Etl", {
      sql: Output.all(stream.name, sink.name).pipe(
        Output.map(([streamName, sinkName]) => sql(streamName, sinkName)),
      ),
    });
    return { stream, sink, pipeline };
  });

const passthrough = (stream: string, sink: string) => `INSERT INTO ${sink} SELECT * FROM ${stream}`;

test.provider(
  "SQL is validated during plan; whitespace-only changes are a no-op",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      yield* stack.destroy();

      const deployed = yield* stack.deploy(lakehouse(passthrough));
      expect(deployed.sink.type).toEqual("basin_catalog");
      expect(deployed.pipeline.pipelineId).toBeTruthy();

      // Reformatted SQL is the same statement.
      const reformatted = yield* stack.plan(
        lakehouse((stream, sink) => `  INSERT INTO ${sink}\n    SELECT *\n    FROM ${stream};  `),
      );
      expect(reformatted.resources.Etl!.action).toEqual("noop");

      // Invalid SQL fails the plan — before the running pipeline is deleted.
      const invalid = yield* stack
        .plan(lakehouse((stream, sink) => `INSERT INTO ${sink} SELEC * FROM ${stream}`))
        .pipe(Effect.exit);
      expect(Exit.isFailure(invalid)).toBe(true);
      expect(String(Exit.isFailure(invalid) ? invalid.cause : "")).toContain("invalid SQL");

      // A valid change is a replacement.
      const filtered = yield* stack.plan(
        lakehouse((stream, sink) => `INSERT INTO ${sink} SELECT * FROM ${stream} WHERE url != ''`),
      );
      expect(filtered.resources.Etl!.action).toEqual("replace");

      const live = yield* getPipeline(accountId, deployed.pipeline.pipelineId);
      expect(live.id).toEqual(deployed.pipeline.pipelineId);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: [
      "provider:cloudflare",
      "provider:cloudflare:pipelines",
      "provider:cloudflare:r2",
      "live",
    ],
    timeout: 240_000,
  },
);

import * as Cloudflare from "@alchemy.run/cloudflare";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { apiToken, r2Credentials } from "./fixtures/pipelines-shared.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

const getSink = (accountId: string, sinkId: string) => pipelines.getSink({ accountId, sinkId });

const expectSinkGone = (accountId: string, sinkId: string) =>
  getSink(accountId, sinkId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "SinkNotDeleted" } as const)),
    Effect.catchTag("SinkNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "SinkNotDeleted",
      schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.recurs(10)]),
    }),
  );

const tags = [
  "provider:cloudflare",
  "provider:cloudflare:pipelines",
  "provider:cloudflare:r2",
  "live",
];

const rotated = {
  accessKeyId: Redacted.make("rotated-access-key-id"),
  secretAccessKey: Redacted.make("rotated-secret-access-key"),
};

test.provider(
  "r2 sink: credential rotation and equivalent defaults never replace",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const credentials = yield* r2Credentials;
      yield* stack.destroy();

      const sink = (opts: {
        credentials: typeof credentials;
        explicitDefaults?: boolean;
        path?: string;
      }) =>
        Effect.gen(function* () {
          const bucket = yield* Cloudflare.R2.Bucket("SinkBucket", { forceDestroy: true });
          return yield* Cloudflare.Basin.Sink("Sink", {
            type: "r2",
            format: opts.explicitDefaults ? { type: "json" } : undefined,
            config: {
              bucket: bucket.bucketName,
              credentials: opts.credentials,
              path: opts.path,
              rollingPolicy: opts.explicitDefaults ? { intervalSeconds: 300 } : undefined,
            },
          });
        });

      const initial = yield* stack.deploy(sink({ credentials }));

      // Rotated credentials are write-only and cannot be updated: no replace.
      const rotatePlan = yield* stack.plan(sink({ credentials: rotated }));
      expect(rotatePlan.resources.Sink!.action).toEqual("noop");

      // Spelling out the defaults is equivalent.
      const defaultsPlan = yield* stack.plan(sink({ credentials, explicitDefaults: true }));
      expect(defaultsPlan.resources.Sink!.action).toEqual("noop");

      // A destination change still replaces.
      const pathPlan = yield* stack.plan(sink({ credentials, path: "moved" }));
      expect(pathPlan.resources.Sink!.action).toEqual("replace");

      const after = yield* stack.deploy(sink({ credentials: rotated }));
      expect(after.sinkId).toEqual(initial.sinkId);

      yield* stack.destroy();
      yield* expectSinkGone(accountId, initial.sinkId);
    }).pipe(logLevel),
  { tags, timeout: 240_000 },
);

test.provider(
  "catalog sink: config form ⇄ catalog form and r2_data_catalog ⇄ basin_catalog are no-ops",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const token = yield* apiToken;
      yield* stack.destroy();

      const lakehouse = Effect.gen(function* () {
        const bucket = yield* Cloudflare.R2.Bucket("LakeBucket", { forceDestroy: true });
        const catalog = yield* Cloudflare.Basin.Catalog("Catalog", {
          bucket,
        });
        return { bucket, catalog };
      });

      // The catalog's attributes are all stable, so the old bucket-name
      // spelling does not wait for it — enable it in a first deploy.
      yield* stack.deploy(lakehouse);

      const initial = yield* stack.deploy(
        Effect.gen(function* () {
          // The old spelling.
          const { catalog } = yield* lakehouse;
          return yield* Cloudflare.Pipelines.Sink("Table", {
            type: "r2_data_catalog",
            config: {
              bucket: catalog.bucketName,
              namespace: "web",
              tableName: "page_views",
              token,
            },
          });
        }),
      );
      expect(initial.type).toEqual("r2_data_catalog");
      expect(initial.tableName).toEqual("page_views");
      const live = yield* getSink(accountId, initial.sinkId);
      expect(live.config?.bucket).toEqual(initial.bucket);

      const catalogForm = (sinkToken: Redacted.Redacted<string>) =>
        Effect.gen(function* () {
          const { catalog } = yield* lakehouse;
          return yield* Cloudflare.Basin.Sink("Table", {
            type: "basin_catalog",
            catalog,
            table: { namespace: "web", name: "page_views" },
            token: sinkToken,
          });
        });

      const plan = yield* stack.plan(catalogForm(token));
      expect(plan.resources.Table!.action).toEqual("noop");

      // A rotated token never replaces (the table already exists, so a
      // catalog sink could not be recreated on it anyway).
      const rotatePlan = yield* stack.plan(catalogForm(Redacted.make("rotated-token")));
      expect(rotatePlan.resources.Table!.action).toEqual("noop");

      const switched = yield* stack.deploy(catalogForm(token));
      expect(switched.sinkId).toEqual(initial.sinkId);

      yield* stack.destroy();
      yield* expectSinkGone(accountId, initial.sinkId);
    }).pipe(logLevel),
  { tags, timeout: 240_000 },
);

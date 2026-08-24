import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Output from "@/Output";
import * as Test from "@/Test/Alchemy";
import * as pipelines from "@distilled.cloud/cloudflare/pipelines";
import * as user from "@distilled.cloud/cloudflare/user";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import crypto from "node:crypto";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// The scoped API token the test harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out 403 blips
// (`Forbidden`, declared in the distilled error unions) on the test's
// own out-of-band verification calls.
const forbiddenBlips = {
  while: (e: { _tag: string }) => e._tag === "Forbidden",
  schedule: Schedule.exponential("500 millis"),
  times: 8,
} as const;

// The same blip can hit engine-side calls mid-deploy. Reconcile is
// idempotent (observe→ensure→sync), so retrying the whole deploy is safe.
const retryAuthBlip = <A, E, R>(eff: Effect.Effect<A, E, R>) =>
  eff.pipe(
    Effect.retry({
      while: (e) => String(e).includes("Unable to authenticate request"),
      schedule: Schedule.exponential("1 second"),
      times: 5,
    }),
  );

// R2 S3-compatible credentials are derived from the active API token:
// the access key id is the token id and the secret is the SHA-256 hex
// digest of the token value.
const r2Credentials = Effect.gen(function* () {
  const creds = yield* yield* CloudflareEnvironment;
  if (creds.type !== "apiToken") {
    return yield* Effect.die(
      new Error(
        "Pipelines sink test requires an apiToken profile (R2 S3 credentials are derived from the token)",
      ),
    );
  }
  const token = Redacted.value(creds.apiToken);
  const verified = yield* retryAuthBlip(user.verifyToken({}));
  const secretAccessKey = yield* Effect.sync(() =>
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return {
    accessKeyId: Redacted.make(verified.id),
    secretAccessKey: Redacted.make(secretAccessKey),
  };
});

const getStream = (accountId: string, streamId: string) =>
  pipelines
    .getStream({ accountId, streamId })
    .pipe(Effect.retry(forbiddenBlips));

const getSink = (accountId: string, sinkId: string) =>
  pipelines.getSink({ accountId, sinkId }).pipe(Effect.retry(forbiddenBlips));

const getPipeline = (accountId: string, pipelineId: string) =>
  pipelines
    .getV1Pipeline({ accountId, pipelineId })
    .pipe(Effect.retry(forbiddenBlips));

const expectStreamGone = (accountId: string, streamId: string) =>
  getStream(accountId, streamId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "StreamNotDeleted" } as const)),
    Effect.catchTag("StreamNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "StreamNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

const expectSinkGone = (accountId: string, sinkId: string) =>
  getSink(accountId, sinkId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "SinkNotDeleted" } as const)),
    Effect.catchTag("SinkNotFound", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "SinkNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

const expectPipelineGone = (accountId: string, pipelineId: string) =>
  getPipeline(accountId, pipelineId).pipe(
    Effect.flatMap(() => Effect.fail({ _tag: "PipelineNotDeleted" } as const)),
    Effect.catchTag("PipelineNotExists", () => Effect.void),
    Effect.retry({
      while: (e) => e._tag === "PipelineNotDeleted",
      schedule: Schedule.max([
        Schedule.exponential("500 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider(
  "stream: create with defaults, patch http in place, replace on schema change",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      yield* stack.destroy();

      // Create — engine-generated name, default http/workerBinding.
      const initial = yield* retryAuthBlip(
        stack.deploy(Cloudflare.Pipelines.Stream("Stream", {})),
      );

      expect(initial.streamId).toBeTruthy();
      expect(initial.accountId).toEqual(accountId);
      expect(initial.httpEnabled).toEqual(true);
      expect(initial.httpAuthentication).toEqual(false);
      expect(initial.workerBindingEnabled).toEqual(true);
      expect(initial.endpoint).toBeTruthy();

      const live = yield* getStream(accountId, initial.streamId);
      expect(live.id).toEqual(initial.streamId);
      expect(live.name).toEqual(initial.name);

      // Patch http in place — same streamId.
      const updated = yield* retryAuthBlip(
        stack.deploy(
          Cloudflare.Pipelines.Stream("Stream", {
            http: {
              enabled: true,
              authentication: true,
              cors: { origins: ["https://example.com"] },
            },
          }),
        ),
      );

      expect(updated.streamId).toEqual(initial.streamId);
      expect(updated.httpAuthentication).toEqual(true);
      expect(updated.corsOrigins).toEqual(["https://example.com"]);

      const liveUpdated = yield* getStream(accountId, updated.streamId);
      expect(liveUpdated.http.authentication).toEqual(true);
      expect(liveUpdated.http.cors?.origins).toEqual(["https://example.com"]);

      // The schema is immutable — declaring one triggers a replacement.
      const replaced = yield* retryAuthBlip(
        stack.deploy(
          Cloudflare.Pipelines.Stream("Stream", {
            schema: {
              fields: [
                { type: "string", name: "url", required: true },
                { type: "timestamp", name: "ts", unit: "millisecond" },
              ],
            },
          }),
        ),
      );

      expect(replaced.streamId).not.toEqual(initial.streamId);
      yield* expectStreamGone(accountId, initial.streamId);

      yield* stack.destroy();
      yield* expectStreamGone(accountId, replaced.streamId);

      // Destroy again — delete must be idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

interface EtlOpts {
  path?: string;
  where?: string;
}

// One program deploying the whole Pipelines topology: an R2 destination
// bucket, the sink writing to it, an ingest stream, and the SQL pipeline
// connecting them. The pipeline SQL interpolates the stream/sink names so
// the engine orders pipeline-after-stream/sink on deploy (and the reverse
// on destroy).
const etl = (
  creds: {
    accessKeyId: Redacted.Redacted<string>;
    secretAccessKey: Redacted.Redacted<string>;
  },
  opts: EtlOpts = {},
) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("SinkBucket", {});
    const stream = yield* Cloudflare.Pipelines.Stream("Stream", {});
    const sink = yield* Cloudflare.Pipelines.Sink("Sink", {
      type: "r2",
      config: {
        bucket: bucket.bucketName,
        credentials: creds,
        path: opts.path,
        rollingPolicy: { intervalSeconds: 10 },
      },
    });
    const pipeline = yield* Cloudflare.Pipelines.Pipeline("Etl", {
      sql: Output.interpolate`INSERT INTO ${sink.name} SELECT * FROM ${stream.name}${opts.where ? ` WHERE ${opts.where}` : ""}`,
    });
    return { bucket, stream, sink, pipeline };
  });

test.provider(
  "end-to-end: stream → sql pipeline → r2 sink, replacement on sink change",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const creds = yield* r2Credentials;

      yield* stack.destroy();

      const initial = yield* retryAuthBlip(stack.deploy(etl(creds)));

      expect(initial.sink.sinkId).toBeTruthy();
      expect(initial.sink.type).toEqual("r2");
      expect(initial.sink.bucket).toEqual(initial.bucket.bucketName);
      expect(initial.pipeline.pipelineId).toBeTruthy();
      expect(initial.pipeline.sql).toContain(
        `INSERT INTO ${initial.sink.name} SELECT * FROM ${initial.stream.name}`,
      );

      const liveSink = yield* getSink(accountId, initial.sink.sinkId);
      expect(liveSink.name).toEqual(initial.sink.name);
      expect(liveSink.config?.bucket).toEqual(initial.bucket.bucketName);

      const livePipeline = yield* getPipeline(
        accountId,
        initial.pipeline.pipelineId,
      );
      expect(livePipeline.name).toEqual(initial.pipeline.name);
      expect(livePipeline.sql).toEqual(initial.pipeline.sql);
      expect(livePipeline.status).toBeTruthy();

      // Redeploying identical props is a no-op.
      const noop = yield* retryAuthBlip(stack.deploy(etl(creds)));
      expect(noop.sink.sinkId).toEqual(initial.sink.sinkId);
      expect(noop.pipeline.pipelineId).toEqual(initial.pipeline.pipelineId);
      expect(noop.stream.streamId).toEqual(initial.stream.streamId);

      // Sinks have no update API — changing the path replaces the sink,
      // and the pipeline's SQL change replaces the pipeline with it. The
      // stream is untouched.
      const replaced = yield* retryAuthBlip(
        stack.deploy(etl(creds, { path: "ingest", where: "1 = 1" })),
      );

      expect(replaced.sink.sinkId).not.toEqual(initial.sink.sinkId);
      expect(replaced.sink.path).toEqual("ingest");
      expect(replaced.pipeline.pipelineId).not.toEqual(
        initial.pipeline.pipelineId,
      );
      expect(replaced.pipeline.sql).toContain("WHERE 1 = 1");
      expect(replaced.stream.streamId).toEqual(initial.stream.streamId);

      // The old sink and pipeline were deleted as part of the replacement.
      yield* expectPipelineGone(accountId, initial.pipeline.pipelineId);
      yield* expectSinkGone(accountId, initial.sink.sinkId);

      // Destroy tears down pipeline → sink/stream → bucket in dependency
      // order.
      yield* stack.destroy();

      yield* expectPipelineGone(accountId, replaced.pipeline.pipelineId);
      yield* expectSinkGone(accountId, replaced.sink.sinkId);
      yield* expectStreamGone(accountId, replaced.stream.streamId);

      // Destroy again — deletes must be idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 600_000 },
);

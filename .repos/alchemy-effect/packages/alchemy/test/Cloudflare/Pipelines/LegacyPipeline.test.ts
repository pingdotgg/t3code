import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
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
        "LegacyPipeline test requires an apiToken profile (R2 S3 credentials are derived from the token)",
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

const getLegacyPipeline = (accountId: string, pipelineName: string) =>
  pipelines
    .getPipeline({ accountId, pipelineName })
    .pipe(Effect.retry(forbiddenBlips));

const expectLegacyPipelineGone = (accountId: string, pipelineName: string) =>
  getLegacyPipeline(accountId, pipelineName).pipe(
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

interface LegacyOpts {
  prefix?: string;
  corsOrigins?: string[];
  name?: string;
}

const legacy = (
  creds: {
    accessKeyId: Redacted.Redacted<string>;
    secretAccessKey: Redacted.Redacted<string>;
  },
  opts: LegacyOpts = {},
) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("LegacyBucket", {});
    const pipeline = yield* Cloudflare.Pipelines.LegacyPipeline("Legacy", {
      name: opts.name,
      source: [
        {
          type: "http",
          ...(opts.corsOrigins ? { cors: { origins: opts.corsOrigins } } : {}),
        },
        { type: "binding" },
      ],
      destination: {
        bucket: bucket.bucketName,
        credentials: creds,
        batch: { maxDurationS: 5 },
        ...(opts.prefix ? { prefix: opts.prefix } : {}),
      },
    });
    return { bucket, pipeline };
  });

test.provider(
  "legacy pipeline: create, in-place update, replace on name change",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const creds = yield* r2Credentials;

      yield* stack.destroy();

      // Create — engine-generated name, http + binding sources.
      const initial = yield* retryAuthBlip(stack.deploy(legacy(creds)));

      expect(initial.pipeline.pipelineId).toBeTruthy();
      expect(initial.pipeline.accountId).toEqual(accountId);
      expect(initial.pipeline.endpoint).toBeTruthy();
      expect(initial.pipeline.bucket).toEqual(initial.bucket.bucketName);

      const live = yield* getLegacyPipeline(accountId, initial.pipeline.name);
      expect(live.id).toEqual(initial.pipeline.pipelineId);
      expect(live.destination.path.bucket).toEqual(initial.bucket.bucketName);
      expect(live.source.map((s) => s.type).sort()).toEqual([
        "binding",
        "http",
      ]);

      // Redeploying identical props is a no-op.
      const noop = yield* retryAuthBlip(stack.deploy(legacy(creds)));
      expect(noop.pipeline.pipelineId).toEqual(initial.pipeline.pipelineId);
      expect(noop.pipeline.version).toEqual(initial.pipeline.version);

      // In-place update — prefix and CORS change via PUT, same id/name.
      const updated = yield* retryAuthBlip(
        stack.deploy(
          legacy(creds, {
            prefix: "ingest",
            corsOrigins: ["https://example.com"],
          }),
        ),
      );

      expect(updated.pipeline.pipelineId).toEqual(initial.pipeline.pipelineId);
      expect(updated.pipeline.name).toEqual(initial.pipeline.name);

      const liveUpdated = yield* getLegacyPipeline(
        accountId,
        updated.pipeline.name,
      );
      expect(liveUpdated.destination.path.prefix).toEqual("ingest");
      const httpSource = liveUpdated.source.find((s) => s.type === "http");
      expect(
        httpSource && "cors" in httpSource
          ? httpSource.cors?.origins
          : undefined,
      ).toEqual(["https://example.com"]);

      // Name change — the legacy API addresses pipelines by name, so this
      // is a replacement.
      const replacementName = `${initial.pipeline.name}-r`;
      const replaced = yield* retryAuthBlip(
        stack.deploy(
          legacy(creds, {
            name: replacementName,
            prefix: "ingest",
            corsOrigins: ["https://example.com"],
          }),
        ),
      );

      expect(replaced.pipeline.name).toEqual(replacementName);
      expect(replaced.pipeline.pipelineId).not.toEqual(
        initial.pipeline.pipelineId,
      );
      yield* expectLegacyPipelineGone(accountId, initial.pipeline.name);

      yield* stack.destroy();
      yield* expectLegacyPipelineGone(accountId, replaced.pipeline.name);

      // Destroy again — delete must be idempotent.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 420_000 },
);

// The list endpoint returns truncated summary items
// (`{id, name, endpoint}` only), but distilled's `ListPipelinesResponse`
// schema marks the per-item `destination`, `source`, and `version`
// fields as required, so the valid response is rejected as a catch-all
// `CloudflareHttpError`:
//   CloudflareHttpError: {"success":true,...,"result":[{"id":"...",
//   "name":"...","endpoint":"..."}],"result_info":{...}}
// NEEDED DISTILLED PATCH (pipelines/listPipelines): make the per-item
// `destination`, `source`, and `version` fields optional in
// `ListPipelinesResponse.results` (the list endpoint is summary-only;
// the provider hydrates each item via `getPipeline`). Until then this is
// gated — set CLOUDFLARE_TEST_LEGACY_PIPELINE_LIST=1 to run it.
test.provider.skipIf(!process.env.CLOUDFLARE_TEST_LEGACY_PIPELINE_LIST)(
  "list enumerates the deployed legacy pipeline",
  (stack) =>
    Effect.gen(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const creds = yield* r2Credentials;

      yield* stack.destroy();

      const deployed = yield* retryAuthBlip(stack.deploy(legacy(creds)));
      expect(deployed.pipeline.pipelineId).toBeTruthy();

      // Account collection: list() exhaustively paginates every legacy
      // pipeline in the account and hydrates each into the read
      // Attributes shape.
      const provider = yield* Provider.findProvider(
        Cloudflare.Pipelines.LegacyPipeline,
      );
      const all = yield* provider.list();

      const match = all.find(
        (p) => p.pipelineId === deployed.pipeline.pipelineId,
      );
      expect(match).toBeDefined();
      expect(match?.name).toEqual(deployed.pipeline.name);
      expect(match?.accountId).toEqual(accountId);
      expect(match?.bucket).toEqual(deployed.bucket.bucketName);
      expect(match?.endpoint).toEqual(deployed.pipeline.endpoint);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

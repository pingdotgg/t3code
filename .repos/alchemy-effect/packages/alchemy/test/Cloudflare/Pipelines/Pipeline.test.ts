import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Output from "@/Output";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
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
        "Pipelines list test requires an apiToken profile (R2 S3 credentials are derived from the token)",
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

// A pipeline references a stream + sink by name in its SQL, so the
// smallest deployable unit is the full R2 topology.
const etl = (creds: {
  accessKeyId: Redacted.Redacted<string>;
  secretAccessKey: Redacted.Redacted<string>;
}) =>
  Effect.gen(function* () {
    const bucket = yield* Cloudflare.R2.Bucket("SinkBucket", {});
    const stream = yield* Cloudflare.Pipelines.Stream("Stream", {});
    const sink = yield* Cloudflare.Pipelines.Sink("Sink", {
      type: "r2",
      config: {
        bucket: bucket.bucketName,
        credentials: creds,
        rollingPolicy: { intervalSeconds: 10 },
      },
    });
    const pipeline = yield* Cloudflare.Pipelines.Pipeline("Etl", {
      sql: Output.interpolate`INSERT INTO ${sink.name} SELECT * FROM ${stream.name}`,
    });
    return { bucket, stream, sink, pipeline };
  });

test.provider(
  "list enumerates the deployed pipeline",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const creds = yield* r2Credentials;
      const deployed = yield* retryAuthBlip(stack.deploy(etl(creds)));

      const provider = yield* Provider.findProvider(
        Cloudflare.Pipelines.Pipeline,
      );
      const all = yield* provider.list();

      // Each element is the full `read` Attributes shape, usable by delete.
      expect(
        all.some((p) => p.pipelineId === deployed.pipeline.pipelineId),
      ).toBe(true);
      const found = all.find(
        (p) => p.pipelineId === deployed.pipeline.pipelineId,
      )!;
      expect(found.name).toEqual(deployed.pipeline.name);
      expect(found.sql).toEqual(deployed.pipeline.sql);
      expect(found.accountId).toEqual(deployed.pipeline.accountId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 600_000 },
);

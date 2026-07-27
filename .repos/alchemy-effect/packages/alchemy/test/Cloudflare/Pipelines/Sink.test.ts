import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
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

// The scoped API token the harness mints propagates eventually-
// consistently across Cloudflare's edge — ride out auth blips.
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
  const verified = yield* retryAuthBlip(
    user.verifyToken({}).pipe(
      Effect.retry({
        while: (e) => e._tag === "Forbidden",
        schedule: Schedule.exponential("500 millis"),
        times: 8,
      }),
    ),
  );
  const secretAccessKey = yield* Effect.sync(() =>
    crypto.createHash("sha256").update(token).digest("hex"),
  );
  return {
    accessKeyId: Redacted.make(verified.id),
    secretAccessKey: Redacted.make(secretAccessKey),
  };
});

test.provider(
  "list enumerates the deployed sink",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const creds = yield* r2Credentials;

      const deployed = yield* retryAuthBlip(
        stack.deploy(
          Effect.gen(function* () {
            const bucket = yield* Cloudflare.R2.Bucket("SinkBucket", {});
            return yield* Cloudflare.Pipelines.Sink("ListSink", {
              type: "r2",
              config: {
                bucket: bucket.bucketName,
                credentials: creds,
                rollingPolicy: { intervalSeconds: 10 },
              },
            });
          }),
        ),
      );

      expect(deployed.sinkId).toBeTruthy();

      // Account collection: list() exhaustively paginates every sink in
      // the account and hydrates each into the read Attributes shape.
      const provider = yield* Provider.findProvider(Cloudflare.Pipelines.Sink);
      const all = yield* provider.list();

      const match = all.find((s) => s.sinkId === deployed.sinkId);
      expect(match).toBeDefined();
      expect(match?.name).toEqual(deployed.name);
      expect(match?.type).toEqual("r2");
      expect(match?.accountId).toEqual(deployed.accountId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000 },
);

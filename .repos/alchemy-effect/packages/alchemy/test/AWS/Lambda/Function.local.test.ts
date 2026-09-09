/**
 * `AWS.Lambda.Function` under `alchemy dev`: the dualized provider deploys
 * the function INTO the floci emulator (RPC-sidecar-hosted
 * `FlociFunctionProvider`) and hot-swaps its code on file change.
 *
 * Proof structure:
 *   - attrs carry the emulator shape — dummy-account ARN
 *     (`:000000000000:`) and a `*.lambda-url.us-east-1.localhost:4566`
 *     function URL — which the live cloud can never produce;
 *   - the function URL is host-reachable and serves the fixture's marker;
 *   - rewriting the fixture source (in a CLONE, the repo tree stays clean)
 *     is observed at the URL without another deploy — the sidecar watch
 *     loop rebuilds, uploads to the emulator's assets bucket, and floci's
 *     reactive S3 sync re-extracts (measured latency reported);
 *   - an engine-driven update (env change) between two rewrites does not
 *     detach the function from the watch loop's dev key — the next rewrite
 *     still serves (regression: the watcher memoized its one-time
 *     enrollment and never re-pointed the function after the live
 *     reconcile moved it to a content-addressed key);
 *   - a dualized Queue + a `bundle: false` Function + a distilled
 *     event-source mapping pump SQS messages through the containerized
 *     function into a dualized Bucket;
 *   - after destroy the function is gone from the emulator.
 *
 * Requires Docker (floci + the Lambda runtime container); skipped when the
 * daemon is unavailable.
 */
import * as AWS from "@/AWS";
import * as Endpoint from "@/AWS/Endpoint.ts";
import * as Region from "@/AWS/Region.ts";
import * as Test from "@/Test/Alchemy";
import { Credentials } from "@distilled.cloud/aws/Credentials";
import type { RegionName } from "@distilled.cloud/aws/Region";
import * as Lambda from "@distilled.cloud/aws/lambda";
import * as SQS from "@distilled.cloud/aws/sqs";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as HttpClient from "effect/unstable/http/HttpClient";
import { fileURLToPath } from "node:url";
import { cloneFixture } from "../../Cloudflare/Utils/Fixture.ts";
import {
  dockerAvailable,
  FLOCI_ENDPOINT,
  rawS3GetObject,
} from "../Local/fixtures/raw.ts";

const { test } = Test.make({ providers: AWS.providers(), dev: true });

const devFixtureDir = fileURLToPath(
  new URL("./fixtures/floci-dev", import.meta.url),
);
const esmHandlerPath = fileURLToPath(
  new URL("./fixtures/floci-esm/handler.mjs", import.meta.url),
);

/** Floci-scoped context for the raw distilled calls the test makes itself. */
const flociContext = Layer.mergeAll(
  Endpoint.of(FLOCI_ENDPOINT),
  Region.of("us-east-1"),
  Layer.succeed(
    Credentials,
    Effect.succeed({
      accessKeyId: Redacted.make("test"),
      secretAccessKey: Redacted.make("test"),
      sessionToken: undefined,
      region: "us-east-1" as RegionName,
    }),
  ),
);

test.provider.skipIf(!dockerAvailable)(
  "dev deploys a Function into floci with a reachable URL and hot reload",
  (stack) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const client = yield* HttpClient.HttpClient;

      yield* stack.destroy();

      // Clone the fixture so the hot-reload rewrite never touches the repo
      // tree.
      const clone = yield* cloneFixture(devFixtureDir, {
        prefix: "floci-dev-fn-",
      });
      const mainPath = path.join(clone, "handler.ts");

      const fn = yield* stack.deploy(
        AWS.Lambda.Function("DevFn", {
          main: mainPath,
          handler: "handler",
          isExternal: true,
          functionUrl: true,
          env: { DEV_MARKER: "env-carried" },
        }),
      );

      // Emulator-shaped identity: the live cloud can never produce these.
      expect(fn.functionArn).toContain(":000000000000:");
      expect(fn.functionArn).toContain(":us-east-1:");
      expect(fn.functionUrl).toBeDefined();
      expect(fn.functionUrl).toContain("localhost:4566");

      // First invoke pulls the Lambda runtime image (~4.4s cold), then warm.
      const first = yield* client.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({
            status: response.status,
            body,
          })),
        ),
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.spaced("2 seconds"),
          times: 60,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("2 seconds"),
          until: (res): boolean =>
            res.status === 200 && res.body.startsWith("marker-v1"),
          times: 60,
        }),
      );
      expect(first.status).toBe(200);
      expect(first.body).toBe("marker-v1:env-carried");

      // Hot reload: rewrite the CLONED source and wait (bounded) for the
      // new marker to serve — no deploy in between. The sidecar watch loop
      // rebuilds + uploads; floci's reactive S3 sync re-extracts.
      const source = yield* fs.readFileString(mainPath);
      const swapStartedAt = Date.now();
      yield* fs.writeFileString(
        mainPath,
        source.replace(`"marker-v1"`, `"marker-v2"`),
      );

      const swapped = yield* client.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({
            status: response.status,
            body,
          })),
        ),
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.spaced("250 millis"),
          times: 20,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("250 millis"),
          until: (res): boolean =>
            res.status === 200 && res.body.startsWith("marker-v2"),
          times: 240,
        }),
      );
      const swapLatencyMs = Date.now() - swapStartedAt;
      expect(swapped.body).toBe("marker-v2:env-carried");
      yield* Effect.log(
        `hot reload observed at the function URL in ${swapLatencyMs}ms`,
      );

      // Second swap: the function's code is now enrolled on the stable dev
      // S3 key, so this one is a bare PutObject + floci reactive re-extract
      // (no Lambda API call).
      const secondStartedAt = Date.now();
      yield* fs.writeFileString(
        mainPath,
        source.replace(`"marker-v1"`, `"marker-v3"`),
      );
      const reswapped = yield* client.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({
            status: response.status,
            body,
          })),
        ),
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.spaced("250 millis"),
          times: 20,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("250 millis"),
          until: (res): boolean =>
            res.status === 200 && res.body.startsWith("marker-v3"),
          times: 240,
        }),
      );
      const secondSwapLatencyMs = Date.now() - secondStartedAt;
      expect(reswapped.body).toBe("marker-v3:env-carried");
      yield* Effect.log(
        `second hot reload (reactive S3 sync) observed in ${secondSwapLatencyMs}ms`,
      );

      // Engine-driven UPDATE between swaps (a prop change — here `env`):
      // the live reconcile re-uploads the bundle to a content-addressed key
      // and re-points the function THERE, detaching it from the watch
      // loop's stable dev key. The watcher must notice and re-enroll on its
      // next swap; before the fix the marker below never served (the
      // PutObject landed on a key the function no longer read) until the
      // next engine update happened to re-bundle it.
      const updated = yield* stack.deploy(
        AWS.Lambda.Function("DevFn", {
          main: mainPath,
          handler: "handler",
          isExternal: true,
          functionUrl: true,
          env: { DEV_MARKER: "env-updated" },
        }),
      );
      expect(updated.functionUrl).toBe(fn.functionUrl);
      const afterUpdate = yield* client.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({
            status: response.status,
            body,
          })),
        ),
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.spaced("250 millis"),
          times: 20,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("250 millis"),
          until: (res): boolean =>
            res.status === 200 && res.body === "marker-v3:env-updated",
          times: 240,
        }),
      );
      expect(afterUpdate.body).toBe("marker-v3:env-updated");

      yield* fs.writeFileString(
        mainPath,
        source.replace(`"marker-v1"`, `"marker-v4"`),
      );
      const afterUpdateSwap = yield* client.get(fn.functionUrl!).pipe(
        Effect.flatMap((response) =>
          Effect.map(response.text, (body) => ({
            status: response.status,
            body,
          })),
        ),
        Effect.retry({
          while: (): boolean => true,
          schedule: Schedule.spaced("250 millis"),
          times: 20,
        }),
        Effect.repeat({
          schedule: Schedule.spaced("250 millis"),
          until: (res): boolean =>
            res.status === 200 && res.body.startsWith("marker-v4"),
          times: 240,
        }),
      );
      expect(afterUpdateSwap.body).toBe("marker-v4:env-updated");

      // Destroy: the function (and its role) must be gone from the
      // emulator.
      yield* stack.destroy();
      const gone = yield* Lambda.getFunction({
        FunctionName: fn.functionName,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(true),
        ),
        Effect.provide(flociContext),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (isGone): boolean => isGone,
          times: 20,
        }),
      );
      expect(gone).toBe(true);
    }),
  { timeout: 540_000 },
);

test.provider.skipIf(!dockerAvailable)(
  "SQS -> dev Function (bundle: false) -> S3 event pumping in the emulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const markerKey = "floci-dev-esm-consumed.txt";

      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const queue = yield* AWS.SQS.Queue("DevEsmQueue");
          const bucket = yield* AWS.S3.Bucket("DevEsmTarget", {
            forceDestroy: true,
          });
          const fn = yield* AWS.Lambda.Function("DevEsmFn", {
            main: esmHandlerPath,
            handler: "handler",
            bundle: false,
            functionUrl: false,
            env: { TARGET_BUCKET: bucket.bucketName },
          });
          // The dualized RESOURCE (requires the alchemy floci fork ≥
          // 1.6.0-alchemy.2: its reconciler's ownership scan calls lambda
          // ListTags on the `event-source-mapping:` ARN, and creation
          // brands it with Tags).
          const esm = yield* AWS.Lambda.EventSourceMapping("DevEsm", {
            functionName: fn.functionName,
            eventSourceArn: queue.queueArn,
            batchSize: 1,
            enabled: true,
          });
          return { queue, bucket, fn, esm };
        }),
      );
      expect(outputs.queue.queueArn).toContain(":000000000000:");
      expect(outputs.fn.functionArn).toContain(":000000000000:");
      expect(outputs.esm.eventSourceMappingArn).toContain(":000000000000:");

      yield* SQS.sendMessage({
        QueueUrl: outputs.queue.queueUrl,
        MessageBody: markerKey,
      }).pipe(Effect.provide(flociContext));

      // Bounded poll: floci's ESM poller delivers to the containerized
      // function, whose S3 write-back proves consumption.
      const consumed = yield* rawS3GetObject(
        outputs.bucket.bucketName,
        markerKey,
      ).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("3 seconds"),
          until: (res): boolean => res.status === 200,
          times: 40,
        }),
      );
      expect(consumed.status).toBe(200);

      // Destroy tears down the mapping (stopping its poller), the
      // function, the queue, and the bucket in dependency order.
      yield* stack.destroy();

      const esmGone = yield* Lambda.getEventSourceMapping({
        UUID: outputs.esm.uuid,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(true),
        ),
        Effect.provide(flociContext),
      );
      expect(esmGone).toBe(true);

      const gone = yield* Lambda.getFunction({
        FunctionName: outputs.fn.functionName,
      }).pipe(
        Effect.map(() => false),
        Effect.catchTag("ResourceNotFoundException", () =>
          Effect.succeed(true),
        ),
        Effect.provide(flociContext),
        Effect.repeat({
          schedule: Schedule.spaced("1 second"),
          until: (isGone): boolean => isGone,
          times: 20,
        }),
      );
      expect(gone).toBe(true);
    }),
  { timeout: 540_000 },
);

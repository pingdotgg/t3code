import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as pathe from "pathe";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";

// `dev: true` runs local providers behind the RPC sidecar proxy by default,
// matching the process topology of the real `alchemy dev` command (see
// MakeOptions.sidecar in Test/Core.ts).
const { test } = Test.make({
  providers: Cloudflare.providers(),
  dev: true,
});

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

class WorkerNotReady extends Data.TaggedError("WorkerNotReady")<{
  status: number;
}> {}

const getJsonReady = (url: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url).pipe(
      Effect.flatMap((res) =>
        res.status === 200
          ? Effect.succeed(res)
          : Effect.fail(new WorkerNotReady({ status: res.status })),
      ),
      Effect.retry({
        while: (e): e is WorkerNotReady => e instanceof WorkerNotReady,
        // Cap the backoff: an uncapped exponential over 10 recurs sums to
        // ~8.5 minutes and turns a persistent non-200 into an apparent hang.
        schedule: Schedule.max([
          Schedule.min([
            Schedule.exponential("500 millis"),
            Schedule.spaced("2 seconds"),
          ]),
          Schedule.recurs(10),
        ]),
      }),
    );
    return yield* res.json;
  }).pipe(Effect.orDie);

/**
 * Under `alchemy dev` the R2 Bucket resource is emulated by the local
 * provider (a `dev:`-prefixed bucket name, no cloud API calls) and the
 * worker's `r2_bucket` binding is lowered onto the local workerd R2
 * simulator. This exercises the full local roundtrip: put / get / head /
 * list / delete through the native `env` binding.
 */
test.provider(
  "R2 bucket binding round-trips against the local simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Cloudflare.R2.Bucket("LocalBucket", {
            forceDestroy: true,
          });
          const worker = yield* Cloudflare.Worker("r2-local-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/r2-local-worker.ts",
            ),
            env: { BUCKET: bucket },
          });
          return { bucket, worker };
        }),
      );

      // The local provider fabricates a `dev:` name — proof no cloud call
      // ran — and the worker serves from the local dev proxy.
      expect(deployed.bucket.bucketName).toMatch(/^dev:/);
      expect(deployed.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const body = (yield* getJsonReady(
        `${deployed.worker.url}/roundtrip`,
      )) as {
        text: string;
        etag: string | null;
        size: number | null;
        keys: string[];
        afterDelete: boolean;
      };
      expect(body.text).toBe("hello r2");
      expect(body.etag).toBeTruthy();
      expect(body.size).toBe("hello r2".length);
      expect(body.keys).toEqual(["greeting.txt"]);
      expect(body.afterDelete).toBe(true);

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * The `*Local` R2 capability layers reach the local simulator through an
 * ephemeral workerd gateway that emulates the R2 REST API over the native
 * binding. An Action seeds (put/get/head/list/delete) a `dev:` bucket, and
 * the worker's native binding then reads the same simulator storage —
 * proving Node-side capability clients and worker bindings share one local
 * data plane.
 */
test.provider(
  "ReadWriteBucketLocal Action seeds the local simulator in dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Cloudflare.R2.Bucket("ActionSeededBucket", {
            forceDestroy: true,
          });

          const Seed = Action(
            "Seed",
            Effect.gen(function* () {
              const client = yield* Cloudflare.R2.ReadWriteBucket(bucket);
              return Effect.fn(function* () {
                yield* client.put("seeded.txt", "from-action", {
                  httpMetadata: { contentType: "text/plain" },
                });
                yield* client.put("other.txt", "value");
                const object = yield* client.get("seeded.txt");
                const text = object === null ? null : yield* object.text();
                const head = yield* client.head("seeded.txt");
                const list = yield* client.list();
                yield* client.delete("other.txt");
                const afterDelete = yield* client.get("other.txt");
                return {
                  text,
                  contentType: head?.httpMetadata?.contentType ?? null,
                  keys: list.objects.map((o) => o.key),
                  afterDelete: afterDelete === null,
                };
              });
            }).pipe(Effect.provide(Cloudflare.R2.ReadWriteBucketLocal)),
          );
          const seeded = yield* Seed({});

          const worker = yield* Cloudflare.Worker("r2-action-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/r2-local-worker.ts",
            ),
            env: { BUCKET: bucket },
          });
          return { bucket, worker, seeded };
        }),
      );

      expect(deployed.bucket.bucketName).toMatch(/^dev:/);
      expect(deployed.seeded.text).toBe("from-action");
      expect(deployed.seeded.contentType).toBe("text/plain");
      expect(deployed.seeded.keys.sort()).toEqual(["other.txt", "seeded.txt"]);
      expect(deployed.seeded.afterDelete).toBe(true);

      // The worker's native binding reads the same simulator storage the
      // Action's gateway wrote to.
      const body = (yield* getJsonReady(
        `${deployed.worker.url}/get?key=seeded.txt`,
      )) as { text: string | null };
      expect(body.text).toBe("from-action");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

/**
 * `Alchemy.remote()` opts the bucket OUT of local emulation: even under
 * `alchemy dev` the bucket is created on real Cloudflare (a real bucket
 * name, not `dev:`-prefixed) and the worker's `r2_bucket` binding proxies
 * to it remotely. An out-of-band read through the cloud API proves the
 * worker's write landed in the real bucket, and destroy removes it.
 */
test.provider(
  "Alchemy.remote() bucket runs live in dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const bucket = yield* Cloudflare.R2.Bucket("LiveDevBucket", {
            forceDestroy: true,
          }).pipe(Alchemy.remote());
          const worker = yield* Cloudflare.Worker("r2-live-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/r2-local-worker.ts",
            ),
            env: { BUCKET: bucket },
          });
          return { bucket, worker };
        }),
      );

      // A real bucket name — the live provider created it on Cloudflare.
      expect(deployed.bucket.bucketName).not.toMatch(/^dev:/);

      const seeded = (yield* getJsonReady(`${deployed.worker.url}/seed`)) as {
        etag: string | null;
      };
      expect(seeded.etag).toBeTruthy();

      // Out-of-band: the object is visible through the cloud API — the
      // remote-proxied binding really hit the live bucket.
      const { accountId } = yield* yield* CloudflareEnvironment;
      const object = yield* r2.getObject({
        accountId,
        bucketName: deployed.bucket.bucketName,
        objectName: "seed.txt",
      });
      const text = yield* object.body.pipe(Stream.decodeText, Stream.mkString);
      expect(text).toBe("seeded by worker");

      yield* stack.destroy();

      // Destroy emptied and deleted the real bucket (stamped live mode).
      const gone = yield* r2
        .getBucket({ accountId, bucketName: deployed.bucket.bucketName })
        .pipe(
          Effect.as(false),
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 120_000 },
);

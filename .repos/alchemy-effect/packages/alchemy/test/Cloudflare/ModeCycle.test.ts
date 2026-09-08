import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as d1 from "@distilled.cloud/cloudflare/d1";
import * as kv from "@distilled.cloud/cloudflare/kv";
import * as r2 from "@distilled.cloud/cloudflare/r2";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment.ts";
import { Stack } from "@/Stack";
import { State, type ResourceState } from "@/State";
import { inDev } from "../test.resources.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

/**
 * The full provider-mode cycle against the real cloud. Mode transitions are
 * engine-orchestrated REPLACEMENTS (the persisted `providerMode` stamp vs
 * the resolved mode; the provider diff is not consulted) — the providers
 * themselves carry no promotion logic:
 *
 * 1. dev (all local)          — `dev:` rows, zero cloud calls
 * 2. dev + remote() on KV       — hybrid: the namespace switches local → live
 *                               WITHIN dev (replacement, real cloud id);
 *                               bucket/DB stay local
 * 3. deploy (all live)        — bucket/DB promote (replacements, new real
 *                               ids); the already-live namespace keeps its
 *                               identity (no churn)
 * 4. dev, remote() removed      — demotion: all three switch live → local;
 *                               the real cloud resources are deleted by the
 *                               live provider (the stamped mode) and fresh
 *                               `dev:` rows replace them
 * 5. destroy                  — local rows, nothing left upstream
 */
test.provider(
  "KV/R2/D1 cycle local → hybrid → live → local with engine-orchestrated replacements",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const { accountId } = yield* yield* CloudflareEnvironment;

      const program = (liveKV: boolean) =>
        Effect.gen(function* () {
          const namespace = yield* Cloudflare.KV.Namespace("CycleKV").pipe(
            Alchemy.remote(liveKV),
          );
          const bucket = yield* Cloudflare.R2.Bucket("CycleBucket", {
            forceDestroy: true,
          });
          const database = yield* Cloudflare.D1.Database("CycleDB");
          return { namespace, bucket, database };
        });

      const namespaceExists = (namespaceId: string) =>
        kv.getNamespace({ accountId, namespaceId }).pipe(
          Effect.as(true),
          Effect.catchTag("NamespaceNotFound", () => Effect.succeed(false)),
        );
      const bucketExists = (bucketName: string) =>
        r2.getBucket({ accountId, bucketName }).pipe(
          Effect.as(true),
          Effect.catchTag("NoSuchBucket", () => Effect.succeed(false)),
        );
      const databaseExists = (databaseId: string) =>
        d1.getDatabase({ accountId, databaseId }).pipe(
          Effect.as(true),
          Effect.catchTag("DatabaseNotFound", () => Effect.succeed(false)),
        );

      // 1. dev — everything is a local `dev:` row.
      const dev1 = yield* inDev(stack.deploy(program(false)));
      expect(dev1.namespace.namespaceId).toMatch(/^dev:/);
      expect(dev1.bucket.bucketName).toMatch(/^dev:/);
      expect(dev1.database.databaseId).toMatch(/^dev:/);

      // 2. dev + remote() on the namespace — hybrid. The engine replaces the
      // local KV row with a real cloud namespace; the others stay local
      // (identities unchanged — no churn from an unrelated sibling switch).
      const dev2 = yield* inDev(stack.deploy(program(true)));
      expect(dev2.namespace.namespaceId).not.toMatch(/^dev:/);
      expect(yield* namespaceExists(dev2.namespace.namespaceId)).toBe(true);
      expect(dev2.bucket.bucketName).toBe(dev1.bucket.bucketName);
      expect(dev2.database.databaseId).toBe(dev1.database.databaseId);

      // 3. plain deploy — bucket/DB promote to real resources via
      // replacement (new identities); the namespace was ALREADY live, so
      // its identity is stable across the promotion (same-mode noop).
      const live = yield* stack.deploy(program(true));
      expect(live.namespace.namespaceId).toBe(dev2.namespace.namespaceId);
      expect(live.bucket.bucketName).not.toMatch(/^dev:/);
      expect(live.database.databaseId).not.toMatch(/^dev:/);
      expect(yield* bucketExists(live.bucket.bucketName)).toBe(true);
      expect(yield* databaseExists(live.database.databaseId)).toBe(true);

      // 4. back to dev with remote() removed — demotion. Every resource
      // switches live → local: fresh `dev:` rows, and the live provider
      // (the stamped mode that created them) deletes the cloud resources.
      const dev3 = yield* inDev(stack.deploy(program(false)));
      expect(dev3.namespace.namespaceId).toMatch(/^dev:/);
      expect(dev3.bucket.bucketName).toMatch(/^dev:/);
      expect(dev3.database.databaseId).toMatch(/^dev:/);
      expect(yield* namespaceExists(live.namespace.namespaceId)).toBe(false);
      expect(yield* bucketExists(live.bucket.bucketName)).toBe(false);
      expect(yield* databaseExists(live.database.databaseId)).toBe(false);

      // 5. destroy — local rows only; nothing upstream to clean.
      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

/**
 * Regression: state rows written by alchemy versions before providerMode
 * stamping (≤ 2.0.0-beta.64) in dev mode have no `providerMode` stamp but
 * carry `dev:`-marker identities. A plain destroy on a newer version must
 * infer "local" from the marker and route the delete to the local provider
 * variant instead of handing the `dev:` id to the live provider — the
 * Cloudflare API rejects it with `BadRequest: There is a malformed
 * parameter in the request`, permanently wedging the destroy.
 */
test.provider(
  "a legacy pre-stamping dev queue row (no providerMode, dev: id) destroys cleanly in live mode",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const state = yield* yield* State;
      const stk = yield* Stack;
      const { accountId } = yield* yield* CloudflareEnvironment;

      // The exact shape `alchemy dev` on beta.64 persisted for a local
      // queue: a fabricated `dev:<uuid>` id and no providerMode field.
      const fqn = "LegacyDevQueue";
      yield* state.set({
        stack: stk.name,
        stage: stk.stage,
        fqn,
        value: {
          kind: "resource",
          status: "created",
          fqn,
          logicalId: fqn,
          instanceId: "beta64legacyrow0",
          namespace: undefined,
          resourceType: "Cloudflare.Queues.Queue",
          providerVersion: 0,
          props: {},
          attr: {
            queueId: "dev:00000000-0000-4000-8000-000000000000",
            queueName: "legacy-dev-queue",
            accountId,
          },
          bindings: [],
          downstream: [],
        } satisfies ResourceState,
      });

      // Live-mode destroy: the marker-inferred local variant deletes the
      // row (a no-op against its empty in-memory registry) — no cloud call.
      yield* stack.destroy();

      expect(
        yield* state.get({ stack: stk.name, stage: stk.stage, fqn }),
      ).toBeUndefined();
    }).pipe(logLevel),
  { timeout: 120_000 },
);

// Alchemy modifications are licensed under Apache-2.0.
// This file includes third-party code; see /THIRD_PARTY_LICENSES.md.
/**
 * Adapted from Miniflare's secrets-store plugin tests
 * (`workers-sdk/packages/miniflare/test/plugins/secret-store/index.spec.ts`).
 *
 * Miniflare seeds secrets from Node through `getSecretsStoreSecretAPI` (a
 * magic-proxy admin API on the secret entrypoint); this runtime has no
 * equivalent, so the test worker instead carries `SecretsStore.admin`
 * bindings — the raw KV-namespace view of a store that deploy-time tooling
 * (alchemy's local Secret provider, via the platform proxy) uses for
 * seeding — and exposes them over a `/seed` route. This covers the exact
 * seeding surface consumers use in production.
 *
 * Both upstream cases are ported ("single secret-store", "multiple
 * secret-store"). Upstream has no persistence coverage; a file-system
 * persistence case is added for parity with the other binding suites, and a
 * KV-isolation case pins that a KV namespace and a Secrets Store with the
 * same identifier never share data (distinct services, Durable Object
 * uniqueKeys and storage directories).
 */
import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it, layer } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as KvNamespace from "../../bindings/kv-namespace/index.ts";
import * as SecretsStore from "../../bindings/secrets-store/index.ts";
import * as Docker from "../../Docker.ts";
import * as Globals from "../../globals/Globals.ts";
import * as Internet from "../../globals/Internet.ts";
import * as Storage from "../../globals/Storage.ts";
import * as Paths from "../../internal/Paths.ts";
import * as Runtime from "../../Runtime.ts";
import * as RuntimeServices from "../../RuntimeServices.ts";
import * as Workerd from "../../workerd/Workerd.ts";
import type { TestWorker } from "../helpers/runtime.ts";
import {
  localRuntimeLayer,
  makeTempDirectory,
  startTestWorker,
} from "../helpers/runtime.ts";

// -----------------------------------------------------------------------------
// Test worker: drives secret bindings and the admin seeding surface over HTTP
// -----------------------------------------------------------------------------

const TEST_SCRIPT = `
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/seed") {
      // Admin surface: write/delete a secret value through the raw
      // KV-namespace view of a store.
      const { binding, name, value } = await request.json();
      if (value === null) await env[binding].delete(name);
      else await env[binding].put(name, value);
      return new Response("ok");
    }
    if (url.pathname === "/secret") {
      // Single secret read; mirrors the upstream "single secret-store" worker.
      const binding = url.searchParams.get("binding") ?? "SECRET";
      try {
        const value = await env[binding].get();
        return new Response(value);
      } catch (e) {
        return new Response(e.message, { status: 404 });
      }
    }
    if (url.pathname === "/secrets") {
      // Bulk read; mirrors the upstream "multiple secret-store" worker.
      const bindings = url.searchParams.get("bindings").split(",");
      const results = await Promise.allSettled(bindings.map((b) => env[b].get()));
      return Response.json(
        Object.fromEntries(
          bindings.map((b, i) => [
            b,
            results[i].status === "fulfilled" ? results[i].value : null,
          ]),
        ),
      );
    }
    if (url.pathname === "/kv") {
      // KV-isolation probe: read a key from a plain KV namespace binding.
      const value = await env.KV.get(url.searchParams.get("key"));
      return Response.json({ value });
    }
    return new Response(null, { status: 404 });
  },
};
`;

const compatibilityDate = "2026-03-10";
const modules = [
  { name: "main.js", type: "ESModule", content: TEST_SCRIPT },
] as const;

const seed = (
  worker: TestWorker,
  binding: string,
  name: string,
  value: string | null,
) =>
  worker
    .fetchText("/seed", {
      method: "POST",
      body: JSON.stringify({ binding, name, value }),
    })
    .pipe(
      Effect.tap((body) =>
        Effect.sync(() => {
          expect(body).toBe("ok");
        }),
      ),
    );

// -----------------------------------------------------------------------------
// Upstream cases
// -----------------------------------------------------------------------------

layer(localRuntimeLayer)("SecretsStore binding", (it) => {
  it.effect("single secret-store", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "secrets-store-single-test",
        compatibilityDate,
        compatibilityFlags: [],
        modules: [...modules],
        bindings: [
          SecretsStore.local({
            binding: "SECRET",
            storeId: "test_store_id",
            secretName: "secret_name",
          }),
          SecretsStore.admin({ binding: "ADMIN", storeId: "test_store_id" }),
        ],
      });

      const missing = yield* worker.fetch("/secret");
      expect(missing.status).toBe(404);
      expect(yield* Effect.promise(() => missing.text())).toBe(
        'Secret "secret_name" not found',
      );

      yield* seed(worker, "ADMIN", "secret_name", "example");

      const found = yield* worker.fetch("/secret");
      expect(found.status).toBe(200);
      expect(yield* Effect.promise(() => found.text())).toBe("example");
    }).pipe(Effect.scoped),
  );

  it.effect("multiple secret-store", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "secrets-store-multiple-test",
        compatibilityDate,
        compatibilityFlags: [],
        modules: [...modules],
        bindings: [
          SecretsStore.local({
            binding: "SECRET1",
            storeId: "test_store_id_1",
            secretName: "secret_name_a",
          }),
          // Same store id, different secret name
          SecretsStore.local({
            binding: "SECRET2",
            storeId: "test_store_id_1",
            secretName: "secret_name_b",
          }),
          // Different store id, same secret name
          SecretsStore.local({
            binding: "SECRET3",
            storeId: "test_store_id_2",
            secretName: "secret_name_a",
          }),
          SecretsStore.admin({ binding: "ADMIN1", storeId: "test_store_id_1" }),
          SecretsStore.admin({ binding: "ADMIN2", storeId: "test_store_id_2" }),
        ],
      });

      const read = worker.fetchJson<Record<string, string | null>>(
        "/secrets?bindings=SECRET1,SECRET2,SECRET3",
      );

      expect(yield* read).toEqual({
        SECRET1: null,
        SECRET2: null,
        SECRET3: null,
      });

      yield* seed(worker, "ADMIN1", "secret_name_a", "example_a");
      yield* seed(worker, "ADMIN1", "secret_name_b", "example_b");

      expect(yield* read).toEqual({
        SECRET1: "example_a",
        SECRET2: "example_b",
        SECRET3: null,
      });

      yield* seed(worker, "ADMIN2", "secret_name_a", "example_c");

      expect(yield* read).toEqual({
        SECRET1: "example_a",
        SECRET2: "example_b",
        SECRET3: "example_c",
      });
    }).pipe(Effect.scoped),
  );

  it.effect("deleted secret reads as not found again", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "secrets-store-delete-test",
        compatibilityDate,
        compatibilityFlags: [],
        modules: [...modules],
        bindings: [
          SecretsStore.local({
            binding: "SECRET",
            storeId: "delete_store_id",
            secretName: "secret_name",
          }),
          SecretsStore.admin({ binding: "ADMIN", storeId: "delete_store_id" }),
        ],
      });

      yield* seed(worker, "ADMIN", "secret_name", "to-be-deleted");
      expect(yield* worker.fetchText("/secret")).toBe("to-be-deleted");

      yield* seed(worker, "ADMIN", "secret_name", null);
      // Deleting a missing secret is idempotent.
      yield* seed(worker, "ADMIN", "secret_name", null);

      const missing = yield* worker.fetch("/secret");
      expect(missing.status).toBe(404);
      expect(yield* Effect.promise(() => missing.text())).toBe(
        'Secret "secret_name" not found',
      );
    }).pipe(Effect.scoped),
  );

  it.effect("secrets stores never share data with KV namespaces", () =>
    Effect.gen(function* () {
      const worker = yield* startTestWorker({
        name: "secrets-store-kv-isolation-test",
        compatibilityDate,
        compatibilityFlags: [],
        modules: [...modules],
        bindings: [
          SecretsStore.local({
            binding: "SECRET",
            storeId: "shared_identifier",
            secretName: "secret_name",
          }),
          SecretsStore.admin({
            binding: "ADMIN",
            storeId: "shared_identifier",
          }),
          KvNamespace.local({ binding: "KV", id: "shared_identifier" }),
        ],
      });

      yield* seed(worker, "ADMIN", "secret_name", "secret-value");
      expect(yield* worker.fetchText("/secret")).toBe("secret-value");

      // The KV namespace with the same identifier sees none of it.
      const kv = yield* worker.fetchJson<{ value: string | null }>(
        "/kv?key=secret_name",
      );
      expect(kv.value).toBeNull();
    }).pipe(Effect.scoped),
  );
});

// -----------------------------------------------------------------------------
// Persistence
// -----------------------------------------------------------------------------

describe("SecretsStore binding persistence", () => {
  it.effect(
    "persists on file-system",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;

        const tmp = yield* makeTempDirectory("secrets-store-persist-");

        const runtimeLayerTempDir = Runtime.RuntimeLive.pipe(
          Layer.provideMerge(RuntimeServices.layerLocalBindings()),
          Layer.provide(Globals.GlobalsLive),
          Layer.provideMerge(RuntimeServices.layerLoopback()),
          Layer.provide(Storage.layerDisk(tmp)),
          Layer.provide(Internet.InternetLive),
          Layer.provideMerge(RuntimeServices.layerRegistry()),
          Layer.provide(Paths.PathsLive),
          Layer.provide(Docker.DockerLive),
          Layer.provide(Workerd.WorkerdLive),
          Layer.provideMerge(
            Layer.mergeAll(NodeServices.layer, FetchHttpClient.layer),
          ),
        );

        const runAgainstStorage = Effect.fn(
          function* (run: (worker: TestWorker) => Effect.Effect<void>) {
            const worker = yield* startTestWorker({
              name: "secrets-store-persist-test",
              compatibilityDate,
              compatibilityFlags: [],
              modules: [...modules],
              bindings: [
                SecretsStore.local({
                  binding: "SECRET",
                  storeId: "persist_store",
                  secretName: "secret_name",
                }),
                SecretsStore.admin({
                  binding: "ADMIN",
                  storeId: "persist_store",
                }),
              ],
            });
            yield* run(worker);
          },
          (self) =>
            self.pipe(Effect.provide(runtimeLayerTempDir), Effect.scoped),
        );

        yield* runAgainstStorage((worker) =>
          Effect.gen(function* () {
            yield* seed(worker, "ADMIN", "secret_name", "persisted-value");
            expect(yield* worker.fetchText("/secret")).toBe("persisted-value");
          }),
        );

        // Directories created for the Durable Object SQLite databases and the
        // store's blobs, mirroring the KV persistence layout under a distinct
        // `secrets-store` root.
        const names = yield* fs.readDirectory(path.join(tmp, "secrets-store"));
        expect(names).toContain(
          "cloudflare-runtime-secrets-store-KVNamespaceObject",
        );
        expect(names).toContain("persist_store");

        // "Restarting" keeps persisted data.
        yield* runAgainstStorage((worker) =>
          Effect.gen(function* () {
            expect(yield* worker.fetchText("/secret")).toBe("persisted-value");
          }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
    { timeout: 30_000 },
  );
});

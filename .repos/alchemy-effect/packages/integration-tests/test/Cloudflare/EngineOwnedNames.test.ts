import type { CloudflareResolvedCredentials } from "@alchemy.run/cloudflare/Auth/AuthConfig";
import { CloudflareEnvironment } from "@alchemy.run/cloudflare/CloudflareEnvironment";
import { type Database, DatabaseProvider } from "@alchemy.run/cloudflare/D1/Database";
import { type Connection, ConnectionProvider } from "@alchemy.run/cloudflare/Hyperdrive/Connection";
import { type Namespace, NamespaceProvider } from "@alchemy.run/cloudflare/KV/Namespace";
import { LocalRuntimeState } from "@alchemy.run/cloudflare/LocalRuntime";
import { type Queue, QueueProvider } from "@alchemy.run/cloudflare/Queues/Queue";
import { type Bucket, BucketProvider } from "@alchemy.run/cloudflare/R2/Bucket";
import { type Index, IndexProvider } from "@alchemy.run/cloudflare/Vectorize/VectorizeIndex";
import { describe, expect, it } from "@alchemy.run/test";
import { apiTokenCredentials, Credentials } from "@distilled.cloud/cloudflare/Credentials";
import { NodeServices } from "@effect/platform-node";
import { AlchemyContext } from "alchemy/AlchemyContext";
import { ArtifactStore, createArtifactStore } from "alchemy/Artifacts";
import { Provider } from "alchemy/Provider";
import { ResourceContext } from "alchemy/ResourceContext";
import { Stack, type StackSpec } from "alchemy/Stack";
import { Stage } from "alchemy/Stage";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import * as MutableHashMap from "effect/MutableHashMap";
import * as Redacted from "effect/Redacted";
import { resourceContext } from "../Util/ResourceContext.ts";

// Regression tests for the "engine-owned names" invariant: a provider's
// `diff` must never order a replace (or rename) because the physical-name
// generator's output for a logical id has drifted from the deployed name.
// This is exactly what happens when the naming algorithm evolves (e.g. the
// truncation fix) — deployed resources keep their old-style names, while a
// fresh recompute yields a new-style name. Before the guard, that mismatch
// deleted the deployed resource (databases included) via replace.
//
// Live suites can never catch this class of bug: a fresh deploy generates
// names with the current algorithm, so `output` always matches the
// recompute. These tests simulate drift directly by handing the real
// provider `diff` a persisted output whose name no generator run today
// could produce.

const TEST_ACCOUNT = "test-account-id";

// A name no current-generator run can produce for the ids used below.
const DRIFTED = "old-algorithm-name-a1b2c3";

const stack: Omit<StackSpec, "output"> = {
  name: "my-stack",
  stage: "dev",
  resources: {},
  bindings: {},
  actions: {},
};

const credentials: CloudflareResolvedCredentials = {
  type: "apiToken",
  apiToken: Redacted.make("test-token"),
  accountId: TEST_ACCOUNT,
  source: { type: "stored" },
};

const env = Layer.mergeAll(
  Layer.succeed(CloudflareEnvironment, Effect.succeed(credentials)),
  Layer.succeed(Stack, stack),
  Layer.succeed(Stage, stack.stage),
  Layer.succeed(ResourceContext, resourceContext("0123456789abcdef0123456789abcdef")),
  Layer.succeed(AlchemyContext, { dotAlchemy: "/tmp/.alchemy-test", dev: false, adopt: false }),
  // The remaining layers only satisfy the provider layers' type-level
  // requirements (reconcile/read need clients); diff never touches them.
  Layer.succeed(
    Credentials,
    Effect.succeed(apiTokenCredentials({ apiToken: Redacted.make("test-token") })),
  ),
  Layer.sync(ArtifactStore, createArtifactStore),
  Layer.succeed(
    LocalRuntimeState,
    LocalRuntimeState.of({
      queues: MutableHashMap.empty(),
      queueConsumers: MutableHashMap.empty(),
      workerRestarts: MutableHashMap.empty(),
    }),
  ),
  NodeServices.layer,
  FetchHttpClient.layer,
);

const diffInput = <Olds, News, Output>(id: string, olds: Olds, news: News, output: Output) => ({
  id,
  fqn: id,
  instanceId: "0123456789abcdef0123456789abcdef",
  olds: olds as never,
  news: news as never,
  output: output as never,
  oldBindings: [] as never,
  newBindings: [] as never,
});

describe(
  "engine-owned names: generator drift never replaces",
  { tags: ["unit", "provider:cloudflare", "local"] },
  () => {
    it.effect(
      "D1 Database: drifted auto-generated name does not replace",
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider<Database>("Cloudflare.D1Database");
          const result = yield* provider.diff!(
            diffInput(
              "Db",
              {},
              {},
              {
                databaseId: "11111111-2222-3333-4444-555555555555",
                databaseName: DRIFTED,
                accountId: TEST_ACCOUNT,
              },
            ),
          );
          expect(result?.action).not.toBe("replace");
        }).pipe(Effect.provide(DatabaseProvider()), Effect.provide(env)),
      { tags: ["provider:cloudflare:d1"] },
    );

    it.effect(
      "D1 Database: explicit user rename still replaces",
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider<Database>("Cloudflare.D1Database");
          const result = yield* provider.diff!(
            diffInput(
              "Db",
              {},
              { name: "explicit-new-name" },
              {
                databaseId: "11111111-2222-3333-4444-555555555555",
                databaseName: DRIFTED,
                accountId: TEST_ACCOUNT,
              },
            ),
          );
          expect(result?.action).toBe("replace");
        }).pipe(Effect.provide(DatabaseProvider()), Effect.provide(env)),
      { tags: ["provider:cloudflare:d1"] },
    );

    it.effect(
      "D1 Database: explicit name equal to deployed name does not replace",
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider<Database>("Cloudflare.D1Database");
          const result = yield* provider.diff!(
            diffInput(
              "Db",
              { name: DRIFTED },
              { name: DRIFTED },
              {
                databaseId: "11111111-2222-3333-4444-555555555555",
                databaseName: DRIFTED,
                accountId: TEST_ACCOUNT,
              },
            ),
          );
          expect(result?.action).not.toBe("replace");
        }).pipe(Effect.provide(DatabaseProvider()), Effect.provide(env)),
      { tags: ["provider:cloudflare:d1"] },
    );

    it.effect(
      "R2 Bucket: drifted auto-generated name does not replace",
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider<Bucket>("Cloudflare.R2.Bucket");
          const result = yield* provider.diff!(
            diffInput("Files", {}, {}, { bucketName: DRIFTED, accountId: TEST_ACCOUNT }),
          );
          expect(result?.action).not.toBe("replace");
        }).pipe(Effect.provide(BucketProvider()), Effect.provide(env)),
      { tags: ["provider:cloudflare:r2"] },
    );

    it.effect(
      "R2 Bucket: explicit user rename still replaces",
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider<Bucket>("Cloudflare.R2.Bucket");
          const result = yield* provider.diff!(
            diffInput(
              "Files",
              {},
              { name: "explicit-new-bucket" },
              { bucketName: DRIFTED, accountId: TEST_ACCOUNT },
            ),
          );
          expect(result?.action).toBe("replace");
        }).pipe(Effect.provide(BucketProvider()), Effect.provide(env)),
      { tags: ["provider:cloudflare:r2"] },
    );

    it.effect(
      "Queue: drifted auto-generated name does not replace",
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider<Queue>("Cloudflare.Queues.Queue");
          const result = yield* provider.diff!(
            diffInput(
              "Jobs",
              {},
              {},
              {
                queueId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
                queueName: DRIFTED,
                accountId: TEST_ACCOUNT,
              },
            ),
          );
          expect(result?.action).not.toBe("replace");
        }).pipe(Effect.provide(QueueProvider()), Effect.provide(env)),
      { tags: ["provider:cloudflare:queue"] },
    );

    it.effect(
      "Vectorize Index: drifted auto-generated name does not replace",
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider<Index>("Cloudflare.VectorizeIndex");
          const result = yield* provider.diff!(
            diffInput("Vectors", {}, {}, { indexName: DRIFTED, accountId: TEST_ACCOUNT }),
          );
          expect(result?.action).not.toBe("replace");
        }).pipe(Effect.provide(IndexProvider()), Effect.provide(env)),
      { tags: ["provider:cloudflare:vectorize"] },
    );

    it.effect(
      "KV Namespace: drifted auto-generated title does not rename",
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider<Namespace>("Cloudflare.KV.Namespace");
          const result = yield* provider.diff!(
            diffInput(
              "Cache",
              {},
              {},
              {
                namespaceId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
                title: DRIFTED,
                accountId: TEST_ACCOUNT,
              },
            ),
          );
          expect(result).toBeUndefined();
        }).pipe(Effect.provide(NamespaceProvider()), Effect.provide(env)),
      { tags: ["provider:cloudflare:kv"] },
    );

    it.effect(
      "Hyperdrive Connection: drifted auto-generated name does not replace",
      () =>
        Effect.gen(function* () {
          const provider = yield* Provider<Connection>("Cloudflare.Hyperdrive");
          const result = yield* provider.diff!(
            diffInput(
              "Pg",
              {},
              {},
              {
                hyperdriveId: "a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4",
                name: DRIFTED,
                accountId: TEST_ACCOUNT,
              },
            ),
          );
          expect(result?.action).not.toBe("replace");
        }).pipe(Effect.provide(ConnectionProvider()), Effect.provide(env)),
      { tags: ["provider:cloudflare:hyperdrive"] },
    );
  },
);

import { Action } from "@/Action";
import * as Cloudflare from "@/Cloudflare/index.ts";
import { LOCAL_ACCOUNT_ID } from "@/Cloudflare/LocalAccount.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Result from "effect/Result";
import * as HttpClient from "effect/http/HttpClient";

const noCredentials = Layer.effect(
  ConfigProvider.ConfigProvider,
  Effect.gen(function* () {
    const base = yield* ConfigProvider.ConfigProvider;
    return ConfigProvider.make((path) => {
      const key = path[0];
      if (path.length === 1 && typeof key === "string") {
        if (key.startsWith("CLOUDFLARE_")) return Effect.succeed(undefined);
        if (key === "CI")
          return Effect.succeed(ConfigProvider.makeValue("false"));
        if (key === "ALCHEMY_PROFILE")
          return Effect.succeed(
            ConfigProvider.makeValue("cloudflare-credential-free-test"),
          );
      }
      return base.load(path);
    });
  }),
);

const { test } = Test.make({
  providers: Cloudflare.providers().pipe(Layer.provide(noCredentials)),
  dev: true,
  profile: "cloudflare-credential-free-test",
});

test.provider(
  "local Worker and Action storage clients work without Cloudflare credentials",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const program = Effect.gen(function* () {
        const kv = yield* Cloudflare.KV.Namespace("KV");
        const bucket = yield* Cloudflare.R2.Bucket("Bucket");
        const db = yield* Cloudflare.D1.Database("Database");
        const queue = yield* Cloudflare.Queues.Queue("Queue");
        const store = yield* Cloudflare.SecretsStore.Store("Store");
        const Seed = Action(
          "Seed",
          Effect.gen(function* () {
            const namespace = yield* Cloudflare.KV.ReadWriteNamespace(kv);
            const objects = yield* Cloudflare.R2.ReadWriteBucket(bucket);
            const database = yield* Cloudflare.D1.QueryDatabase(db);
            return Effect.fn(function* () {
              yield* namespace.put("seed", "credential-free");
              yield* objects.put("seed", "credential-free");
              yield* database.exec(
                "CREATE TABLE IF NOT EXISTS seed (value TEXT)",
              );
              yield* database.exec("DELETE FROM seed");
              yield* database
                .prepare("INSERT INTO seed VALUES (?)")
                .bind("credential-free")
                .run();
              return { value: yield* namespace.get("seed") };
            });
          }).pipe(
            Effect.provide(
              Layer.mergeAll(
                Cloudflare.KV.ReadWriteNamespaceLocal,
                Cloudflare.R2.ReadWriteBucketLocal,
                Cloudflare.D1.QueryDatabaseLocal,
              ),
            ),
          ),
        );
        const seeded = yield* Seed({});
        const worker = yield* Cloudflare.Worker("Worker", {
          main: `${import.meta.dirname}/fixtures/credential-free-worker.ts`,
          env: { KV: kv, BUCKET: bucket, DB: db },
        });
        const consumer = yield* Cloudflare.Queues.Consumer("Consumer", {
          queueId: queue.queueId,
          scriptName: worker.workerName,
        });
        return { kv, bucket, db, queue, store, worker, consumer, seeded };
      });
      const deployed = yield* stack.deploy(program);
      for (const resource of [
        deployed.kv,
        deployed.bucket,
        deployed.db,
        deployed.queue,
        deployed.store,
        deployed.worker,
        deployed.consumer,
      ]) {
        expect(resource.accountId).toBe(LOCAL_ACCOUNT_ID);
      }
      expect(deployed.seeded.value).toBe("credential-free");
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.get(deployed.worker.url!);
      expect(response.status).toBe(200);
      expect(yield* response.json).toEqual({
        kv: "credential-free",
        r2: "credential-free",
        d1: "credential-free",
      });
      const again = yield* stack.deploy(program);
      expect(again.kv.namespaceId).toBe(deployed.kv.namespaceId);
      expect(again.queue.queueId).toBe(deployed.queue.queueId);
      yield* stack.destroy();
    }).pipe(Effect.provide(noCredentials)),
  { tags: ["local", "provider:cloudflare"], timeout: 120_000 },
);

test.provider(
  "remote Cloudflare resources still require credentials",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* Effect.result(
        stack.deploy(
          Cloudflare.KV.Namespace("RemoteNamespace").pipe(Alchemy.remote()),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "CredentialsRequired",
          provider: "Cloudflare",
          reason: "remote",
        });
      }
      yield* stack.destroy();
    }).pipe(Effect.provide(noCredentials)),
  { tags: ["local", "provider:cloudflare"], timeout: 60_000 },
);

test.provider(
  "remote bindings still require credentials before starting a local Worker",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const result = yield* Effect.result(
        stack.deploy(
          Cloudflare.Worker("RemoteBindingWorker", {
            main: `${import.meta.dirname}/fixtures/credential-free-worker.ts`,
            env: {
              BROWSER: Cloudflare.Browser("BROWSER").pipe(Alchemy.remote()),
            },
          }),
        ),
      );
      expect(Result.isFailure(result)).toBe(true);
      if (Result.isFailure(result)) {
        expect(result.failure).toMatchObject({
          _tag: "CredentialsRequired",
          provider: "Cloudflare",
          reason: "remote-binding",
        });
      }
      yield* stack.destroy();
    }).pipe(Effect.provide(noCredentials)),
  { tags: ["local", "provider:cloudflare"], timeout: 60_000 },
);

test.provider(
  "Vite child starts without Cloudflare credentials",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const site = yield* stack.deploy(
        Cloudflare.Website.Vite("Site", {
          rootDir: `${import.meta.dirname}/../Website/vite-queue-fixture`,
          main: "worker.ts",
          compatibility: { flags: ["nodejs_compat"] },
          assets: { runWorkerFirst: true },
          dev: { port: 0 },
        }),
      );
      expect(site.accountId).toBe(LOCAL_ACCOUNT_ID);
      const http = yield* HttpClient.HttpClient;
      const response = yield* http.get(`${site.url}/api/received`);
      expect(response.status).toBe(200);
      expect(yield* response.json).toEqual({ received: [] });
      yield* stack.destroy();
    }).pipe(Effect.provide(noCredentials)),
  { tags: ["local", "provider:cloudflare"], timeout: 120_000 },
);

const configuredAccount = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const accountOnly = ConfigProvider.layer(
  ConfigProvider.fromUnknown({
    CI: true,
    CLOUDFLARE_ACCOUNT_ID: configuredAccount,
  }),
);
const configured = Test.make({
  providers: Cloudflare.providers().pipe(Layer.provide(accountOnly)),
  dev: true,
  sidecar: false,
});

configured.test.provider(
  "configured account propagates to local resources without credentials",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();
      const outputs = yield* stack.deploy(
        Effect.gen(function* () {
          const kv = yield* Cloudflare.KV.Namespace("ConfiguredKV");
          const worker = yield* Cloudflare.Worker("ConfiguredWorker", {
            dev: { mode: "external", url: "http://localhost:4321" },
          });
          return { kv, worker };
        }),
      );
      expect(outputs.kv.accountId).toBe(configuredAccount);
      expect(outputs.worker.accountId).toBe(configuredAccount);
      yield* stack.destroy();
    }).pipe(Effect.provide(accountOnly)),
  { tags: ["local", "provider:cloudflare"], timeout: 60_000 },
);

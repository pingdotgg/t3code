import * as Cloudflare from "@/Cloudflare/index.ts";
import * as Alchemy from "@/index.ts";
import * as Test from "@/Test/Alchemy";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
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
 * Under `alchemy dev` the Store and Secret resources are emulated by the
 * local providers (`dev:` ids, no cloud API calls): the Secret's reconcile
 * seeds its value into the local workerd Secrets Store simulator through
 * the admin gateway, and the worker's `secrets_store_secret` binding is
 * lowered onto the local secrets-store service, so `env.SECRET.get()`
 * returns the seeded value. A value update re-seeds the same key
 * (idempotent overwrite) and the worker sees the new value after redeploy.
 */
test.provider(
  "secrets store secret round-trips against the local simulator",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployAt = (value: string) =>
        Effect.gen(function* () {
          const store =
            yield* Cloudflare.SecretsStore.Store("LocalSecretsStore");
          const secret = yield* Cloudflare.SecretsStore.Secret("LocalApiKey", {
            store,
            value: Redacted.make(value),
          });
          const worker = yield* Cloudflare.Worker("secrets-local-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/secrets-local-worker.ts",
            ),
            env: { SECRET: secret },
          });
          return { store, secret, worker };
        });

      const v1 = yield* stack.deploy(deployAt("sk-local-value-1"));

      // The local providers fabricate `dev:` ids — proof no cloud call ran
      // — and the worker serves from the local dev proxy.
      expect(v1.store.storeId).toMatch(/^dev:/);
      expect(v1.secret.secretId).toMatch(/^dev:/);
      expect(v1.secret.storeId).toBe(v1.store.storeId);
      expect(v1.secret.status).toBe("active");
      expect(v1.worker.url).toMatch(/^http:\/\/localhost:\d+$/);

      const body1 = (yield* getJsonReady(`${v1.worker.url}/secret`)) as {
        value: string;
      };
      expect(body1.value).toBe("sk-local-value-1");

      // Update the value — same identity, re-seeded key.
      const v2 = yield* stack.deploy(deployAt("sk-local-value-2"));
      expect(v2.secret.secretId).toBe(v1.secret.secretId);
      expect(v2.secret.storeId).toBe(v1.secret.storeId);

      const body2 = (yield* getJsonReady(`${v2.worker.url}/secret`)) as {
        value: string;
      };
      expect(body2.value).toBe("sk-local-value-2");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 180_000 },
);

/**
 * `Alchemy.remote()` opts the resources OUT of local emulation: even under
 * `alchemy dev` the store/secret are created on real Cloudflare (live
 * providers) and the worker's binding proxies to the live secret remotely.
 * Out-of-band reads through the cloud API prove the secret landed in the
 * real store, and destroy (driven by the stamped `live` provider mode)
 * removes it again.
 */
test.provider(
  "Alchemy.remote() secret runs live in dev",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* Cloudflare.SecretsStore.Store(
            "RemoteSecretsStore",
          ).pipe(Alchemy.remote());
          const secret = yield* Cloudflare.SecretsStore.Secret(
            "RemoteDevApiKey",
            {
              store,
              value: Redacted.make("sk-remote-dev-value"),
            },
          ).pipe(Alchemy.remote());
          const worker = yield* Cloudflare.Worker("secrets-remote-worker", {
            main: pathe.resolve(
              import.meta.dirname,
              "fixtures/secrets-local-worker.ts",
            ),
            env: { SECRET: secret },
          });
          return { store, secret, worker };
        }),
      );

      // Real (non-`dev:`) identities — the live providers ran.
      expect(deployed.store.storeId).not.toMatch(/^dev:/);
      expect(deployed.secret.secretId).not.toMatch(/^dev:/);
      expect(deployed.secret.storeId).toBe(deployed.store.storeId);

      // The locally-served worker reads the live secret through the
      // remote-proxied binding.
      const body = (yield* getJsonReady(`${deployed.worker.url}/secret`)) as {
        value: string;
      };
      expect(body.value).toBe("sk-remote-dev-value");

      // Out-of-band: the secret exists in the real store.
      const { accountId } = yield* yield* CloudflareEnvironment;
      const live = yield* secretsStore.getStoreSecret({
        accountId,
        storeId: deployed.secret.storeId,
        secretId: deployed.secret.secretId,
      });
      expect(live.name).toBe(deployed.secret.secretName);

      yield* stack.destroy();

      // The secret was deleted from the cloud on destroy (its state row is
      // stamped live, so the live provider handles the delete even in a
      // dev run). The store itself is account-level infrastructure whose
      // delete is an intentional no-op.
      const gone = yield* secretsStore
        .getStoreSecret({
          accountId,
          storeId: deployed.secret.storeId,
          secretId: deployed.secret.secretId,
        })
        .pipe(
          Effect.as(false),
          Effect.catchTag("SecretNotFound", () => Effect.succeed(true)),
          Effect.catchTag("StoreNotFound", () => Effect.succeed(true)),
        );
      expect(gone).toBe(true);
    }).pipe(logLevel),
  { timeout: 180_000 },
);

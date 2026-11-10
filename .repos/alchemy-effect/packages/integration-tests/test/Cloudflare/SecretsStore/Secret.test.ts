import * as Cloudflare from "@alchemy.run/cloudflare";
import { expect } from "@alchemy.run/test";
import * as Test from "@alchemy.run/test/Alchemy";
import { adopt } from "alchemy/AdoptPolicy";
import * as Provider from "alchemy/Provider";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as HttpClient from "effect/http/HttpClient";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";
import { testName } from "../../names.ts";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(MinimumLogLevel, process.env.DEBUG ? "Debug" : "Info");

// Canonical `list()` test (parent fan-out): secrets are sub-resources of a
// Secrets Store and there is no account-wide secret enumeration API, so
// `list()` enumerates every store and lists the secrets inside each. Deploy a
// store + secret, then assert the deployed secret appears in the result.
test.provider(
  "list enumerates the deployed secret across stores",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* Cloudflare.SecretsStore.Store("ListSecretStore");
          return yield* Cloudflare.SecretsStore.Secret("ListSecret", {
            store,
            value: Redacted.make("sk-list-test-value"),
          });
        }),
      );

      const provider = yield* Provider.findProvider(Cloudflare.SecretsStore.Secret);
      const all = yield* provider.list();

      expect(all.some((s) => s.secretId === deployed.secretId)).toBe(true);
      const found = all.find((s) => s.secretId === deployed.secretId)!;
      expect(found.secretName).toEqual(deployed.secretName);
      expect(found.storeId).toEqual(deployed.storeId);

      yield* stack.destroy();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:secretsstore", "live"] },
);

class UnexpectedSecretValue extends Data.TaggedError("UnexpectedSecretValue")<{
  status: number;
  value: string | undefined;
}> {}

// Reads the secret back through a deployed Worker binding (the Secrets Store
// API never returns values). Fresh workers.dev URLs and freshly patched
// secrets take a moment to propagate, so retry until the expected value shows.
const readSecretValue = (url: string, expected: string) =>
  Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient;
    const res = yield* client.get(url);
    const value = res.status === 200 ? ((yield* res.json) as { value: string }).value : undefined;
    if (value !== expected) {
      return yield* Effect.fail(new UnexpectedSecretValue({ status: res.status, value }));
    }
    return value;
  }).pipe(
    Effect.retry({
      schedule: Schedule.max([Schedule.exponential("500 millis"), Schedule.spaced("5 seconds")]),
      times: 20,
    }),
  );

// #2441: changing only `value` updates the secret in place — same secret id,
// and a Worker bound to it reads the new value.
test.provider(
  "changing value updates the secret in place",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (value: string) =>
        stack.deploy(
          Effect.gen(function* () {
            const store = yield* Cloudflare.SecretsStore.Store("UpdateSecretStore");
            const secret = yield* Cloudflare.SecretsStore.Secret("UpdateSecret", {
              store,
              value: Redacted.make(value),
            });
            const worker = yield* Cloudflare.Worker("UpdateSecretWorker", {
              main: new URL("./fixtures/value-worker.ts", import.meta.url).pathname,
              workersDev: { enabled: true, previewsEnabled: false },
              env: { MY_SECRET: secret },
            });
            return { secret, worker };
          }),
        );

      const v1 = yield* deploy("sk-update-v1");
      expect(yield* readSecretValue(v1.worker.url!, "sk-update-v1")).toBe("sk-update-v1");

      const v2 = yield* deploy("sk-update-v2");
      expect(v2.secret.secretId).toBe(v1.secret.secretId);
      expect(v2.secret.secretName).toBe(v1.secret.secretName);
      expect(yield* readSecretValue(v2.worker.url!, "sk-update-v2")).toBe("sk-update-v2");

      yield* stack.destroy();
    }).pipe(logLevel),
  { timeout: 300_000, tags: ["provider:cloudflare", "provider:cloudflare:secretsstore", "live"] },
);

// A Secret with no state of its own is found by name. The store's listing
// order is not stable across pages, so the lookup searches by name, ordered
// by name. Deploy more than one page of secrets (the API pages by 20) whose
// names contain the target's and sort before it, so the search itself spans
// two pages, then adopt the target by name under a second logical id, which
// sends `read` through the lookup.
test.provider(
  "adopts a secret by name from a store with more than one page of secrets",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deploy = (adoptTarget: boolean) =>
        stack.deploy(
          Effect.gen(function* () {
            const store = yield* Cloudflare.SecretsStore.Store("PagedSecretStore");
            yield* Effect.forEach(
              Array.from({ length: 21 }, (_, i) => i),
              (i) =>
                Cloudflare.SecretsStore.Secret(`PagedFiller${i}`, {
                  store,
                  name: `filler-${i}-paged-secret-target`,
                  value: Redacted.make("filler"),
                }),
              { concurrency: "unbounded", discard: true },
            );
            const target = yield* Cloudflare.SecretsStore.Secret("PagedTarget", {
              store,
              name: testName("paged-secret-target"),
              value: Redacted.make("sk-paged"),
            });
            const adopted = adoptTarget
              ? yield* Cloudflare.SecretsStore.Secret("PagedTargetAdopted", {
                  store,
                  name: testName("paged-secret-target"),
                  value: Redacted.make("sk-paged"),
                }).pipe(adopt(true))
              : undefined;
            return { target, adopted };
          }),
        );

      const { target } = yield* deploy(false);
      const { adopted } = yield* deploy(true);
      expect(adopted?.secretId).toEqual(target.secretId);

      yield* stack.destroy();
    }).pipe(logLevel),
  {
    tags: ["provider:cloudflare", "provider:cloudflare:secretsstore", "live"],
    timeout: 180_000,
  },
);

// #995: an interrupted first deploy can persist `creating` props whose parent
// Outputs were stripped to holes, so `olds.store` survives as `{}`. `read`
// must treat an unresolved parent reference like a missing one (return
// `undefined` → plan falls through to the create path) instead of handing
// `storeId: undefined` to the API and crashing every later plan with a
// SchemaError defect.
test.provider(
  "read treats an unresolved parent store reference as missing",
  () =>
    Effect.gen(function* () {
      const provider = yield* Provider.findProvider(Cloudflare.SecretsStore.Secret);
      const attr = yield* provider.read!({
        id: "OrphanSecret",
        fqn: "OrphanSecret",
        instanceId: "orphan-instance",
        olds: { store: {} as never, value: Redacted.make("sk-orphan") },
        output: undefined,
      });
      expect(attr).toBeUndefined();
    }).pipe(logLevel),
  { tags: ["provider:cloudflare", "provider:cloudflare:secretsstore", "live"] },
);

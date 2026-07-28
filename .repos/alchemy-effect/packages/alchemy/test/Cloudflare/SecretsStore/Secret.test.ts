import * as Cloudflare from "@/Cloudflare";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import { MinimumLogLevel } from "effect/References";
import * as Redacted from "effect/Redacted";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// Canonical `list()` test (parent fan-out): secrets are sub-resources of a
// Secrets Store and there is no account-wide secret enumeration API, so
// `list()` enumerates every store and lists the secrets inside each. Deploy a
// store + secret, then assert the deployed secret appears in the result.
test.provider("list enumerates the deployed secret across stores", (stack) =>
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

    const provider = yield* Provider.findProvider(
      Cloudflare.SecretsStore.Secret,
    );
    const all = yield* provider.list();

    expect(all.some((s) => s.secretId === deployed.secretId)).toBe(true);
    const found = all.find((s) => s.secretId === deployed.secretId)!;
    expect(found.secretName).toEqual(deployed.secretName);
    expect(found.storeId).toEqual(deployed.storeId);

    yield* stack.destroy();
  }).pipe(logLevel),
);

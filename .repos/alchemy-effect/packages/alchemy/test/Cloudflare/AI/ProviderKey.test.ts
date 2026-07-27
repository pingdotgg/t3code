import * as Cloudflare from "@/Cloudflare";
import * as Test from "@/Test/Alchemy";
import * as secretsStore from "@distilled.cloud/cloudflare/secrets-store";
import { expect } from "alchemy-test";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

const GATEWAY_ID = "alchemy-test-aigw-providerkey";
const PROVIDER_SLUG = "openai";

test.provider(
  "provisions a Secret + GatewayProvider with the correct naming contract",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* Cloudflare.SecretsStore.Store("PkStore");
          const gateway = yield* Cloudflare.AI.Gateway("PkGateway", {
            id: GATEWAY_ID,
            storeId: store.storeId,
          });
          // ProviderKey composes Secret + GatewayProvider, deriving the secret
          // name from `{gatewayId}_{providerSlug}_{alias}`.
          return yield* Cloudflare.AI.ProviderKey("PkKey", {
            store,
            gatewayId: gateway.gatewayId,
            providerSlug: PROVIDER_SLUG,
            value: Redacted.make("alchemy-test-not-a-real-key"),
          });
        }),
      );

      // The secret must be named exactly `{gatewayId}_{providerSlug}_{alias}`.
      const expectedName = `${GATEWAY_ID}_${PROVIDER_SLUG}_default`;
      expect(deployed.secret.secretName).toEqual(expectedName);
      // The secret must be scoped to `ai_gateway` for BYOK resolution.
      expect(deployed.secret.scopes).toContain("ai_gateway");

      // The gateway provider must reference the backing secret's id.
      expect(deployed.gatewayProvider.secretId).toEqual(
        deployed.secret.secretId,
      );
      // The alias carried through is `"default"` (the omitted-alias default).
      expect(deployed.gatewayProvider.alias).toEqual("default");
      expect(deployed.gatewayProvider.providerSlug).toEqual(PROVIDER_SLUG);
      expect(deployed.gatewayProvider.gatewayId).toEqual(GATEWAY_ID);

      // Redeploying identical props is a no-op — same resource IDs.
      const redeployed = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* Cloudflare.SecretsStore.Store("PkStore");
          const gateway = yield* Cloudflare.AI.Gateway("PkGateway", {
            id: GATEWAY_ID,
            storeId: store.storeId,
          });
          return yield* Cloudflare.AI.ProviderKey("PkKey", {
            store,
            gatewayId: gateway.gatewayId,
            providerSlug: PROVIDER_SLUG,
            value: Redacted.make("alchemy-test-not-a-real-key"),
          });
        }),
      );
      expect(redeployed.secret.secretId).toEqual(deployed.secret.secretId);
      expect(redeployed.gatewayProvider.providerConfigId).toEqual(
        deployed.gatewayProvider.providerConfigId,
      );

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider("explicit alias threads through the naming contract", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const store = yield* Cloudflare.SecretsStore.Store("PkAliasStore");
        const gateway = yield* Cloudflare.AI.Gateway("PkAliasGateway", {
          id: GATEWAY_ID + "-alias",
          storeId: store.storeId,
        });
        return yield* Cloudflare.AI.ProviderKey("PkAliasKey", {
          store,
          gatewayId: gateway.gatewayId,
          providerSlug: "anthropic",
          alias: "evals",
          value: Redacted.make("alchemy-test-not-a-real-key"),
        });
      }),
    );

    expect(deployed.secret.secretName).toEqual(
      `${GATEWAY_ID}-alias_anthropic_evals`,
    );
    expect(deployed.gatewayProvider.alias).toEqual("evals");

    yield* stack.destroy();
  }).pipe(logLevel),
);

test.provider(
  "value rotation updates in place; alias change cascades a replacement",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const program = (opts: { value: string; alias?: string }) =>
        Effect.gen(function* () {
          const store = yield* Cloudflare.SecretsStore.Store("PkRotateStore");
          const gateway = yield* Cloudflare.AI.Gateway("PkRotateGateway", {
            id: GATEWAY_ID + "-rotate",
            storeId: store.storeId,
          });
          return yield* Cloudflare.AI.ProviderKey("PkRotateKey", {
            store,
            gatewayId: gateway.gatewayId,
            providerSlug: PROVIDER_SLUG,
            alias: opts.alias,
            value: Redacted.make(opts.value),
          });
        });

      const initial = yield* stack.deploy(
        program({ value: "alchemy-test-key-v1" }),
      );

      // Rotating the key value is an in-place update: the secret keeps its
      // id, so the provider config it feeds is untouched.
      const rotated = yield* stack.deploy(
        program({ value: "alchemy-test-key-v2" }),
      );
      expect(rotated.secret.secretId).toEqual(initial.secret.secretId);
      expect(rotated.gatewayProvider.providerConfigId).toEqual(
        initial.gatewayProvider.providerConfigId,
      );

      // Changing the alias renames the secret — a replacement (new id) —
      // and must cascade: the provider config is replaced (delete-first)
      // and re-pointed at the new secret.
      const renamed = yield* stack.deploy(
        program({ value: "alchemy-test-key-v2", alias: "rotated" }),
      );
      expect(renamed.secret.secretName).toEqual(
        `${GATEWAY_ID}-rotate_${PROVIDER_SLUG}_rotated`,
      );
      expect(renamed.secret.secretId).not.toEqual(initial.secret.secretId);
      expect(renamed.gatewayProvider.providerConfigId).not.toEqual(
        initial.gatewayProvider.providerConfigId,
      );
      expect(renamed.gatewayProvider.alias).toEqual("rotated");
      expect(renamed.gatewayProvider.secretId).toEqual(renamed.secret.secretId);

      // The replaced secret is reclaimed — no orphan left in the store.
      const oldSecret = yield* secretsStore
        .getStoreSecret({
          accountId: initial.secret.accountId,
          storeId: initial.secret.storeId,
          secretId: initial.secret.secretId,
        })
        .pipe(
          Effect.catchTag("SecretNotFound", () => Effect.succeed(undefined)),
        );
      expect(oldSecret).toBeUndefined();

      yield* stack.destroy();
    }).pipe(logLevel),
);

test.provider(
  "destroying the provider key removes the secret from the surviving store",
  (stack) =>
    Effect.gen(function* () {
      yield* stack.destroy();

      const deployed = yield* stack.deploy(
        Effect.gen(function* () {
          const store = yield* Cloudflare.SecretsStore.Store("PkDeleteStore");
          const gateway = yield* Cloudflare.AI.Gateway("PkDeleteGateway", {
            id: GATEWAY_ID + "-delete",
            storeId: store.storeId,
          });
          return yield* Cloudflare.AI.ProviderKey("PkDeleteKey", {
            store,
            gatewayId: gateway.gatewayId,
            providerSlug: PROVIDER_SLUG,
            value: Redacted.make("alchemy-test-not-a-real-key"),
          });
        }),
      );

      expect(deployed.secret.secretName).toEqual(
        `${GATEWAY_ID}-delete_${PROVIDER_SLUG}_default`,
      );

      yield* stack.destroy();

      // The account-level Secrets Store is adopted, not created, so it
      // survives `destroy` — the helper's Secret resource is the only thing
      // that reclaims the BYOK secret. Verify the secret is actually gone
      // (an orphaned secret is the one real leak this composition could
      // introduce). A surviving store means a missing secret surfaces as
      // `SecretNotFound`, not `StoreNotFound`.
      const secretAfter = yield* secretsStore
        .getStoreSecret({
          accountId: deployed.secret.accountId,
          storeId: deployed.secret.storeId,
          secretId: deployed.secret.secretId,
        })
        .pipe(
          Effect.catchTag("SecretNotFound", () => Effect.succeed(undefined)),
        );
      expect(secretAfter).toBeUndefined();
    }).pipe(logLevel),
);

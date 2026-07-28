import * as Cloudflare from "@/Cloudflare";
import { CloudflareEnvironment } from "@/Cloudflare/CloudflareEnvironment";
import * as Provider from "@/Provider";
import * as Test from "@/Test/Alchemy";
import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import { expect } from "alchemy-test";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import { MinimumLogLevel } from "effect/References";
import * as Schedule from "effect/Schedule";

const { test } = Test.make({ providers: Cloudflare.providers() });

const logLevel = Effect.provideService(
  MinimumLogLevel,
  process.env.DEBUG ? "Debug" : "Info",
);

// A gateway allows only one provider config per (providerSlug, alias). The
// two cases in this file run concurrently (test.provider), so they each get
// their OWN gateway to avoid colliding on the same slug+alias.
const LIFECYCLE_GATEWAY_ID = "alchemy-test-aigw-pc";
const LIST_GATEWAY_ID = "alchemy-test-aigw-pc-list";
const PROVIDER_SLUG = "openai";
const ALIAS = "default";
// Cloudflare requires the Secrets Store secret backing a provider config to
// be named exactly `{gatewayId}_{providerSlug}_{alias}`.
const secretName = (gatewayId: string) =>
  `${gatewayId}_${PROVIDER_SLUG}_${ALIAS}`;
const SECRET_VALUE = "sk-alchemy-test-provider-config-1234567890";

class ProviderConfigStillExists extends Data.TaggedError(
  "ProviderConfigStillExists",
) {}

// There is no get endpoint for provider configs — verify through the list.
// A missing parent gateway returns an empty list, so this also covers
// post-destroy verification.
const expectGone = (
  accountId: string,
  gatewayId: string,
  providerConfigId: string,
) =>
  aiGateway.listProviderConfigs({ accountId, gatewayId, perPage: 50 }).pipe(
    Effect.flatMap((page) =>
      page.result.some((c) => c.id === providerConfigId)
        ? Effect.fail(new ProviderConfigStillExists())
        : Effect.void,
    ),
    Effect.retry({
      while: (e): e is ProviderConfigStillExists =>
        e instanceof ProviderConfigStillExists,
      schedule: Schedule.max([
        Schedule.exponential("250 millis"),
        Schedule.recurs(10),
      ]),
    }),
  );

test.provider("create, noop, replace, delete a BYOK provider config", (stack) =>
  Effect.gen(function* () {
    const { accountId } = yield* yield* CloudflareEnvironment;

    yield* stack.destroy();

    const program = (rateLimit?: number) =>
      Effect.gen(function* () {
        // Cloudflare allows a single Secrets Store per account — the
        // resource adopts the existing one and never deletes it.
        const store = yield* Cloudflare.SecretsStore.Store("PcStore");
        const gateway = yield* Cloudflare.AI.Gateway("PcGateway", {
          id: LIFECYCLE_GATEWAY_ID,
          // BYOK resolution requires the gateway to reference the store.
          storeId: store.storeId,
        });
        const secret = yield* Cloudflare.SecretsStore.Secret("PcSecret", {
          store,
          name: secretName(LIFECYCLE_GATEWAY_ID),
          value: Redacted.make(SECRET_VALUE),
          scopes: ["ai_gateway"],
        });
        const config = yield* Cloudflare.AI.GatewayProvider("Byok", {
          gatewayId: gateway.gatewayId,
          providerSlug: PROVIDER_SLUG,
          alias: ALIAS,
          secretId: secret.secretId,
          defaultConfig: true,
          ...(rateLimit !== undefined && {
            rateLimit,
            rateLimitPeriod: 60,
          }),
        });
        return { secret, config };
      });

    const initial = yield* stack.deploy(program());

    expect(initial.config.providerConfigId).toBeDefined();
    expect(initial.config.accountId).toEqual(accountId);
    expect(initial.config.gatewayId).toEqual(LIFECYCLE_GATEWAY_ID);
    expect(initial.config.providerSlug).toEqual(PROVIDER_SLUG);
    expect(initial.config.alias).toEqual(ALIAS);
    expect(initial.config.secretId).toEqual(initial.secret.secretId);
    expect(initial.config.defaultConfig).toBe(true);
    expect(initial.config.rateLimit).toBeUndefined();

    // Verify out-of-band via the API.
    const live = yield* aiGateway.listProviderConfigs({
      accountId,
      gatewayId: LIFECYCLE_GATEWAY_ID,
      perPage: 50,
    });
    const liveConfig = live.result.find(
      (c) => c.id === initial.config.providerConfigId,
    );
    expect(liveConfig).toBeDefined();
    expect(liveConfig!.alias).toEqual(ALIAS);
    expect(liveConfig!.providerSlug).toEqual(PROVIDER_SLUG);
    expect(liveConfig!.secretId).toEqual(initial.secret.secretId);

    // Redeploying identical props is a no-op (still the same config).
    const noop = yield* stack.deploy(program());
    expect(noop.config.providerConfigId).toEqual(
      initial.config.providerConfigId,
    );

    // Provider configs have no update API — adding a rate limit is a
    // delete-first replacement (same provider slug + alias).
    const limited = yield* stack.deploy(program(100));
    expect(limited.config.providerConfigId).not.toEqual(
      initial.config.providerConfigId,
    );
    expect(limited.config.rateLimit).toEqual(100);
    expect(limited.config.rateLimitPeriod).toEqual(60);

    // The replaced config is gone.
    yield* expectGone(
      accountId,
      LIFECYCLE_GATEWAY_ID,
      initial.config.providerConfigId,
    );

    yield* stack.destroy();

    yield* expectGone(
      accountId,
      LIFECYCLE_GATEWAY_ID,
      limited.config.providerConfigId,
    );
  }).pipe(logLevel),
);

test.provider("list enumerates the deployed provider config", (stack) =>
  Effect.gen(function* () {
    yield* stack.destroy();

    const deployed = yield* stack.deploy(
      Effect.gen(function* () {
        const store = yield* Cloudflare.SecretsStore.Store("PcListStore");
        const gateway = yield* Cloudflare.AI.Gateway("PcListGateway", {
          id: LIST_GATEWAY_ID,
          storeId: store.storeId,
        });
        const secret = yield* Cloudflare.SecretsStore.Secret("PcListSecret", {
          store,
          name: secretName(LIST_GATEWAY_ID),
          value: Redacted.make(SECRET_VALUE),
          scopes: ["ai_gateway"],
        });
        return yield* Cloudflare.AI.GatewayProvider("ByokList", {
          gatewayId: gateway.gatewayId,
          providerSlug: PROVIDER_SLUG,
          alias: ALIAS,
          secretId: secret.secretId,
          defaultConfig: true,
        });
      }),
    );

    const provider = yield* Provider.findProvider(
      Cloudflare.AI.GatewayProvider,
    );
    const all = yield* provider.list();

    expect(
      all.some((c) => c.providerConfigId === deployed.providerConfigId),
    ).toBe(true);
    const found = all.find(
      (c) => c.providerConfigId === deployed.providerConfigId,
    )!;
    expect(found.gatewayId).toEqual(LIST_GATEWAY_ID);
    expect(found.providerSlug).toEqual(PROVIDER_SLUG);
    expect(found.alias).toEqual(ALIAS);

    yield* stack.destroy();
  }).pipe(logLevel),
);

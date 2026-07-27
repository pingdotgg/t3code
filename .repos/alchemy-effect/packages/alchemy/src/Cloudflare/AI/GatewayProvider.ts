import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.AI.GatewayProvider" as const;
type TypeId = typeof TypeId;

export type GatewayProviderProps = {
  /**
   * The AI Gateway the provider config (BYOK key) belongs to. The gateway
   * must have its `storeId` set to a Secrets Store id — Cloudflare resolves
   * the key inside that store. Changing the gateway triggers a replacement.
   */
  gatewayId: string;
  /**
   * The upstream provider the key authenticates against (e.g. `openai`,
   * `anthropic`, `workers-ai`). Changing the provider triggers a
   * replacement.
   */
  providerSlug: string;
  /**
   * Alias distinguishing multiple keys for the same provider. If omitted, a
   * unique name is generated from the app, stage, and logical ID.
   *
   * Cloudflare requires the referenced Secrets Store secret to be named
   * exactly `{gatewayId}_{providerSlug}_{alias}` and scoped to
   * `ai_gateway`. Changing the alias triggers a replacement.
   * @default ${app}-${stage}-${id}
   */
  alias?: string;
  /**
   * The Secrets Store secret holding the provider API key. The secret must
   * live in the gateway's `storeId` store, be scoped to `ai_gateway`, and
   * be named `{gatewayId}_{providerSlug}_{alias}`. Changing the secret
   * triggers a replacement.
   */
  secretId: string;
  /**
   * Whether this key is the gateway's default credential for the provider
   * (used when a request does not name a specific key).
   * @default false
   */
  defaultConfig?: boolean;
  /**
   * Maximum number of requests allowed per `rateLimitPeriod` through this
   * key. Omit for no limit. Changing the limit triggers a replacement
   * (Cloudflare exposes no update API for provider configs).
   */
  rateLimit?: number;
  /**
   * The rate limit window in seconds.
   * @default 60
   */
  rateLimitPeriod?: number;
};

export type GatewayProviderAttributes = {
  /**
   * Server-generated gateway provider identifier.
   */
  providerConfigId: string;
  /**
   * The Cloudflare account the gateway provider belongs to.
   */
  accountId: string;
  /**
   * The AI Gateway the gateway provider belongs to.
   */
  gatewayId: string;
  /**
   * Alias distinguishing multiple keys for the same provider.
   */
  alias: string;
  /**
   * The upstream provider the key authenticates against.
   */
  providerSlug: string;
  /**
   * The Secrets Store secret holding the gateway provider API key.
   */
  secretId: string;
  /**
   * Masked preview of the secret value.
   */
  secretPreview: string;
  /**
   * Whether this key is the gateway's default credential for the gateway provider.
   */
  defaultConfig: boolean;
  /**
   * Maximum number of requests allowed per `rateLimitPeriod`, if limited, for the gateway provider.
   */
  rateLimit: number | undefined;
  /**
   * The rate limit window in seconds for the gateway provider.
   */
  rateLimitPeriod: number | undefined;
  /**
   * When the gateway provider was last modified.
   */
  modifiedAt: string;
};

export type GatewayProvider = Resource<
  TypeId,
  GatewayProviderProps,
  GatewayProviderAttributes,
  never,
  Providers
>;

/**
 * A BYOK (bring-your-own-key) provider credential on a Cloudflare AI
 * Gateway.
 *
 * Provider configs let the gateway authenticate against upstream model
 * providers (OpenAI, Anthropic, Workers AI, ...) with your own API key,
 * stored in Cloudflare Secrets Store. Cloudflare exposes no update API for
 * provider configs, so every prop change replaces the config (the old one
 * is deleted first — a gateway allows only one config per provider slug
 * and alias).
 *
 * Cloudflare imposes a strict naming contract: the gateway must reference a
 * Secrets Store via its `storeId`, and the secret must be scoped to
 * `ai_gateway` and named exactly `{gatewayId}_{providerSlug}_{alias}`.
 * @resource
 * @product AI Gateway
 * @category AI
 * @section Creating a Provider Config
 * @example Bring your own OpenAI key
 * ```typescript
 * const store = yield* Cloudflare.SecretsStore.Store("Store");
 *
 * const gateway = yield* Cloudflare.AI.Gateway("Gateway", {
 *   id: "my-gateway",
 *   storeId: store.storeId,
 * });
 *
 * // The secret name must be `{gatewayId}_{providerSlug}_{alias}`.
 * // Prefer `Cloudflare.AI.ProviderKey` to wire this secret automatically.
 * const secret = yield* Cloudflare.SecretsStore.Secret("OpenAiKey", {
 *   store,
 *   name: "my-gateway_openai_default",
 *   value: yield* Config.redacted("OPENAI_API_KEY"),
 *   scopes: ["ai_gateway"],
 * });
 *
 * const byok = yield* Cloudflare.AI.GatewayProvider("OpenAi", {
 *   gatewayId: gateway.gatewayId,
 *   providerSlug: "openai",
 *   alias: "default",
 *   secretId: secret.secretId,
 *   defaultConfig: true,
 * });
 * ```
 *
 * @example Rate-limit a key
 * ```typescript
 * const byok = yield* Cloudflare.AI.GatewayProvider("OpenAi", {
 *   gatewayId: gateway.gatewayId,
 *   providerSlug: "openai",
 *   alias: "default",
 *   secretId: secret.secretId,
 *   rateLimit: 100,
 *   rateLimitPeriod: 60,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ai-gateway/configuration/bring-your-own-keys/
 */
export const GatewayProvider = Resource<GatewayProvider>(TypeId, {
  aliases: ["Cloudflare.AiGateway.ProviderConfig"],
});

/**
 * Returns true if the given value is a GatewayProvider resource.
 */
export const isGatewayProvider = (value: unknown): value is GatewayProvider =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const GatewayProviderProvider = () =>
  Provider.succeed(GatewayProvider, {
    stables: ["providerConfigId", "accountId", "gatewayId"],
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      if (!isResolved(news)) return undefined;
      const { accountId } = yield* yield* CloudflareEnvironment;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace", deleteFirst: true } as const;
      }
      if (output === undefined) return undefined;
      // Provider configs have no update API — any change is a replacement.
      // Delete first: a gateway rejects a second config for the same
      // provider slug/alias with "already exists".
      // Auto-generated aliases are engine-owned: the deployed alias stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided alias can force a replace.
      const newAlias = news.alias ?? output.alias;
      if (
        output.gatewayId !== news.gatewayId ||
        output.providerSlug !== news.providerSlug ||
        output.alias !== newAlias ||
        output.secretId !== news.secretId ||
        output.defaultConfig !== (news.defaultConfig ?? false) ||
        output.rateLimit !== news.rateLimit ||
        (output.rateLimitPeriod ?? 60) !== (news.rateLimitPeriod ?? 60)
      ) {
        return { action: "replace", deleteFirst: true } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const gatewayId =
        output?.gatewayId ?? (olds?.gatewayId as string | undefined);
      if (gatewayId === undefined) return undefined;

      const configs = yield* listProviderConfigs(acct, gatewayId);
      const match = output?.providerConfigId
        ? configs.find((c) => c.id === output.providerConfigId)
        : // Cold read — recover from lost state by matching the
          // deterministic alias.
          yield* Effect.gen(function* () {
            const alias = yield* createAlias(id, olds?.alias);
            return configs.find(
              (c) => c.alias === alias && c.providerSlug === olds?.providerSlug,
            );
          });
      return match ? toAttributes(match, acct) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      // An explicit user-provided alias always wins (an alias change can
      // reach reconcile as an update when diff saw unresolved inputs, e.g.
      // a secretId still pending from a same-deploy secret replacement).
      // Absent that, prefer the deployed alias: regenerating would target a
      // different resource if the generator's output for this id ever
      // drifts.
      const alias =
        news.alias ?? output?.alias ?? (yield* createAlias(id, undefined));
      return yield* reconcileProviderConfig({
        accountId,
        gatewayId: news.gatewayId as string,
        alias,
        providerSlug: news.providerSlug as string,
        secretId: news.secretId as string,
        defaultConfig: news.defaultConfig ?? false,
        rateLimit: news.rateLimit,
        rateLimitPeriod: news.rateLimitPeriod,
        currentId: output?.providerConfigId,
      });
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* aiGateway
        .deleteProviderConfig({
          accountId: output.accountId,
          gatewayId: output.gatewayId,
          id: output.providerConfigId,
        })
        // Cloudflare reports both a missing config and a missing parent
        // gateway with code 7002 — either way it's already gone.
        .pipe(Effect.catchTag("ProviderConfigNotFound", () => Effect.void));
    }),
    // Provider configs are nested under an AI Gateway, with no account-wide
    // collection endpoint. Enumerate every gateway in the account, then fan
    // out (bounded) over them and exhaustively paginate each gateway's
    // provider configs, hydrating each item into the same Attributes shape
    // `read` produces (via `toAttributes`). A gateway that disappears between
    // enumeration and listing returns an empty list, so no per-item not-found
    // mapping is needed.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;

      const gatewayIds = yield* aiGateway.listAiGateways
        .pages({ accountId })
        .pipe(
          Stream.runCollect,
          Effect.map((chunk) =>
            Array.from(chunk).flatMap((page) =>
              (page.result ?? []).map((gateway) => gateway.id),
            ),
          ),
        );

      const rows = yield* Effect.forEach(
        gatewayIds,
        (gatewayId) =>
          aiGateway.listProviderConfigs.pages({ accountId, gatewayId }).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.result ?? []).map((config) =>
                  toAttributes(config, accountId),
                ),
              ),
            ),
          ),
        { concurrency: 10 },
      );
      return rows.flat();
    }),
  });

/**
 * Reconcile a single BYOK provider config toward the desired props.
 *
 * A gateway allows only ONE config per (providerSlug, alias). There is no
 * update API and no get endpoint, so we observe through the list and:
 *   - already-desired occupant → adopt it (idempotent no-op / re-run)
 *   - stale occupant           → delete it, then create the desired one
 *   - no occupant              → create the desired one
 *
 * `createProviderConfig` can still race and fail with
 * `ProviderConfigAlreadyExists` when a leftover/sibling config the list had
 * not yet surfaced (eventual consistency) occupies the slot. Retrying the
 * whole observe→delete→create flow re-observes the now-visible occupant and
 * converges it, so re-runs and leftover state self-heal instead of failing.
 * Bounded so the engine never hangs.
 */
const reconcileProviderConfig = (desired: {
  accountId: string;
  gatewayId: string;
  alias: string;
  providerSlug: string;
  secretId: string;
  defaultConfig: boolean;
  rateLimit: number | undefined;
  rateLimitPeriod: number | undefined;
  currentId: string | undefined;
}) => {
  const {
    accountId,
    gatewayId,
    alias,
    providerSlug,
    secretId,
    defaultConfig,
    rateLimit,
    rateLimitPeriod,
    currentId,
  } = desired;

  const matchesDesired = (attrs: GatewayProviderAttributes) =>
    attrs.alias === alias &&
    attrs.providerSlug === providerSlug &&
    attrs.secretId === secretId &&
    attrs.defaultConfig === defaultConfig &&
    attrs.rateLimit === rateLimit &&
    (attrs.rateLimitPeriod ?? 60) === (rateLimitPeriod ?? 60);

  return Effect.gen(function* () {
    // Observe the config currently occupying this gateway's (slug, alias).
    const configs = yield* listProviderConfigs(accountId, gatewayId);
    const observed =
      configs.find((c) => c.id === currentId) ??
      configs.find((c) => c.alias === alias && c.providerSlug === providerSlug);

    if (observed) {
      const attrs = toAttributes(observed, accountId);
      if (matchesDesired(attrs)) {
        return attrs;
      }
      // No update API — delete the stale occupant before recreating.
      yield* aiGateway
        .deleteProviderConfig({ accountId, gatewayId, id: observed.id })
        .pipe(Effect.catchTag("ProviderConfigNotFound", () => Effect.void));
    }

    // Ensure — create. The referenced Secrets Store secret deploys
    // asynchronously (status `pending` → `active`), so retry the typed
    // "secret was not found" error with bounded backoff.
    const created = yield* aiGateway
      .createProviderConfig({
        accountId,
        gatewayId,
        alias,
        providerSlug,
        secretId,
        defaultConfig,
        ...(rateLimit !== undefined && { rateLimit }),
        ...(rateLimitPeriod !== undefined && { rateLimitPeriod }),
      })
      .pipe(
        Effect.retry({
          while: (e) => e._tag === "ProviderConfigSecretNotFound",
          schedule: Schedule.spaced("5 seconds"),
          times: 10,
        }),
      );
    return toAttributes(created, accountId);
  }).pipe(
    Effect.retry({
      while: (e) => e._tag === "ProviderConfigAlreadyExists",
      schedule: Schedule.spaced("1 second"),
      times: 5,
    }),
  );
};

/**
 * List all provider configs on a gateway. A missing gateway returns an
 * empty list on this endpoint, so no not-found mapping is needed.
 */
const listProviderConfigs = (accountId: string, gatewayId: string) =>
  aiGateway
    .listProviderConfigs({ accountId, gatewayId, perPage: 50 })
    .pipe(Effect.map((page) => page.result));

const createAlias = (id: string, alias: string | undefined) =>
  Effect.gen(function* () {
    return alias ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

const toAttributes = (
  config:
    | aiGateway.CreateProviderConfigResponse
    | aiGateway.ListProviderConfigsResponse["result"][number],
  accountId: string,
): GatewayProviderAttributes => ({
  providerConfigId: config.id,
  accountId,
  gatewayId: config.gatewayId,
  alias: config.alias,
  providerSlug: config.providerSlug,
  secretId: config.secretId,
  secretPreview: config.secretPreview,
  // Cloudflare returns 0/1 here, not booleans — normalize at the boundary.
  defaultConfig: Boolean(config.defaultConfig),
  rateLimit: config.rateLimit ?? undefined,
  rateLimitPeriod: config.rateLimitPeriod ?? undefined,
  modifiedAt: config.modifiedAt,
});

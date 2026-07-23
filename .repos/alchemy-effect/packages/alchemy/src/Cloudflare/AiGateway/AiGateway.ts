import * as aiGateway from "@distilled.cloud/cloudflare/ai-gateway";
import * as Effect from "effect/Effect";
import { deepEqual, isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";
import { AiGatewayBinding } from "./AiGatewayBinding.ts";

export type AiGatewayRateLimitingTechnique = "fixed" | "sliding";

export type AiGatewayLogManagementStrategy = "STOP_INSERTING" | "DELETE_OLDEST";

export type AiGatewayDlp =
  | {
      /**
       * Action to take when a DLP profile matches.
       */
      action: "BLOCK" | "FLAG";
      /**
       * Whether DLP is enabled.
       */
      enabled: boolean;
      /**
       * DLP profile identifiers to apply.
       */
      profiles: string[];
    }
  | {
      /**
       * Whether DLP is enabled.
       */
      enabled: boolean;
      /**
       * DLP policies to apply.
       */
      policies: {
        /**
         * DLP policy identifier.
         */
        id: string;
        /**
         * Action to take when the policy matches.
         */
        action: "FLAG" | "BLOCK";
        /**
         * Request or response phases checked by the policy.
         */
        check: ("REQUEST" | "RESPONSE")[];
        /**
         * Whether the policy is enabled.
         */
        enabled: boolean;
        /**
         * DLP profile identifiers to apply.
         */
        profiles: string[];
      }[];
    };

export type AiGatewayOtel = {
  /**
   * Authorization header value for the OpenTelemetry endpoint.
   */
  authorization: string;
  /**
   * Additional headers sent to the OpenTelemetry endpoint.
   */
  headers: Record<string, unknown>;
  /**
   * OpenTelemetry endpoint URL.
   */
  url: string;
};

export type AiGatewayStripe = {
  /**
   * Authorization header value for Stripe usage events.
   */
  authorization: string;
  /**
   * Stripe usage event payload definitions.
   */
  usageEvents: {
    /**
     * Usage event payload.
     */
    payload: string;
  }[];
};

export type AiGatewayProps = {
  /**
   * Gateway identifier. If omitted, a unique ID will be generated.
   *
   * Must be 1-64 characters and match Cloudflare's AI Gateway ID pattern:
   * lowercase letters, numbers, underscores, and hyphens.
   *
   * @default ${app}-${stage}-${id}
   */
  id?: string;
  /**
   * Whether cached responses are invalidated when a request changes.
   *
   * @default false
   */
  cacheInvalidateOnUpdate?: boolean;
  /**
   * Cache time-to-live in seconds. Set to `null` to disable caching.
   *
   * @default null
   */
  cacheTtl?: number | null;
  /**
   * Whether AI Gateway stores request logs.
   *
   * @default true
   */
  collectLogs?: boolean;
  /**
   * Rate limiting interval in seconds. Set to `null` to disable rate limiting.
   *
   * @default null
   */
  rateLimitingInterval?: number | null;
  /**
   * Maximum requests allowed during the rate limiting interval. Set to `null`
   * to disable rate limiting.
   *
   * @default null
   */
  rateLimitingLimit?: number | null;
  /**
   * Rate limiting algorithm.
   *
   * @default "fixed"
   */
  rateLimitingTechnique?: AiGatewayRateLimitingTechnique;
  /**
   * Whether gateway authentication is enabled.
   */
  authentication?: boolean;
  /**
   * DLP configuration. The installed distilled Cloudflare client applies this
   * through the update API after gateway creation.
   */
  dlp?: AiGatewayDlp;
  /**
   * Whether this gateway is the account default.
   */
  isDefault?: boolean;
  /**
   * Maximum number of log entries to retain.
   */
  logManagement?: number | null;
  /**
   * Strategy used when retained logs reach `logManagement`.
   */
  logManagementStrategy?: AiGatewayLogManagementStrategy | null;
  /**
   * Whether Logpush is enabled for this gateway.
   */
  logpush?: boolean;
  /**
   * Public key used for Logpush encryption.
   */
  logpushPublicKey?: string | null;
  /**
   * OpenTelemetry export configuration.
   */
  otel?: AiGatewayOtel[] | null;
  /**
   * Store identifier used by the gateway.
   */
  storeId?: string | null;
  /**
   * Stripe usage export configuration.
   */
  stripe?: AiGatewayStripe | null;
  /**
   * Whether Zero Data Retention is enabled.
   */
  zdr?: boolean;
};

export type AiGateway = Resource<
  "Cloudflare.AiGateway",
  AiGatewayProps,
  {
    gatewayId: string;
    accountId: string;
    cacheInvalidateOnUpdate: boolean;
    cacheTtl: number | null;
    collectLogs: boolean;
    createdAt: string;
    modifiedAt: string;
    rateLimitingInterval: number | null;
    rateLimitingLimit: number | null;
    rateLimitingTechnique: AiGatewayRateLimitingTechnique;
    authentication: boolean;
    dlp: AiGatewayDlp | undefined;
    isDefault: boolean;
    logManagement: number;
    logManagementStrategy: AiGatewayLogManagementStrategy;
    logpush: boolean;
    logpushPublicKey: string | undefined;
    otel: AiGatewayOtel[] | undefined;
    storeId: string;
    stripe: AiGatewayStripe | undefined;
    zdr: boolean;
  },
  never,
  Providers
>;

// Cloudflare's AI Gateway API uses 0 to mean "disabled" for cache TTL and
// rate limiting fields. Normalize back to null so user-facing semantics
// match what was passed in.
const nullIfZero = (value: number | null | undefined): number | null =>
  value == null || value === 0 ? null : value;

export const isAiGateway = (value: unknown): value is AiGateway =>
  typeof value === "object" &&
  value !== null &&
  "Type" in value &&
  (value as AiGateway).Type === "Cloudflare.AiGateway";

/**
 * A Cloudflare AI Gateway for observability, caching, rate limiting, and
 * governance across AI provider requests.
 *
 * AI Gateway gives your application a stable gateway ID and account-scoped
 * endpoint that can route model requests through Cloudflare. Once bound to a
 * Worker, `aiGateway.model({...})` returns an `effect/unstable/ai`
 * `LanguageModel` Layer so you use the standard `generateText` / `streamText`
 * APIs — provider-agnostic, with caching, rate limiting, retries, and a
 * unified request log handled by the gateway.
 *
 * @section Creating a Gateway
 * @example Basic gateway
 * ```typescript
 * const gateway = yield* Cloudflare.AiGateway("Gateway");
 * ```
 *
 * @example Gateway with caching and rate limiting
 * ```typescript
 * const gateway = yield* Cloudflare.AiGateway("Gateway", {
 *   id: "my-gateway",
 *   cacheTtl: 300,
 *   cacheInvalidateOnUpdate: true,
 *   rateLimitingInterval: 60,
 *   rateLimitingLimit: 100,
 *   rateLimitingTechnique: "sliding",
 * });
 * ```
 *
 * @section Logging
 * @example Gateway with log retention
 * ```typescript
 * const gateway = yield* Cloudflare.AiGateway("Gateway", {
 *   collectLogs: true,
 *   logManagement: 10000,
 *   logManagementStrategy: "STOP_INSERTING",
 * });
 * ```
 *
 * @section Binding into a Worker
 * @example Bind the gateway and provide the runtime layer
 * `AiGateway.bind(gateway)` returns a typed, Effect-native client during the
 * Worker's Init phase. Provide `Cloudflare.AiGatewayBindingLive` once at the
 * bottom of the Init layer chain so every `bind(...)` resolves at runtime.
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { Gateway } from "./AiGateway.ts";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "Api",
 *   { main: import.meta.path },
 *   Effect.gen(function* () {
 *     const aiGateway = yield* Cloudflare.AiGateway.bind(Gateway);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         // …routes
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.AiGatewayBindingLive)),
 * ) {}
 * ```
 *
 * @section Building a LanguageModel
 * @example `aiGateway.model(...)` -> Effect AI `LanguageModel`
 * Call `aiGateway.model({...})` with a Workers AI model id. It returns a
 * `Layer<LanguageModel, never, RuntimeContext>` directly — no API key and no
 * `Layer.unwrap`, since the binding handles auth and the gateway URL. Build it
 * in the Init phase; construction is pure.
 * ```typescript
 * const aiGateway = yield* Cloudflare.AiGateway.bind(Gateway);
 *
 * const languageModel = aiGateway.model({
 *   client: aiGateway,
 *   model: "@cf/meta/llama-3.1-8b-instruct",
 *   parameters: { temperature: 0.7, maxTokens: 1024 },
 * });
 * ```
 *
 * @section Generating Text
 * @example Generate text on a route
 * Provide the `languageModel` layer to the handler and call
 * `LanguageModel.generateText` like any other Effect. `Effect.orDie` collapses
 * `AiError` to a defect (a 500); use `Effect.catchTag("AiError", …)` for typed
 * handling instead.
 * ```typescript
 * import { LanguageModel } from "effect/unstable/ai";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * fetch: Effect.gen(function* () {
 *   const response = yield* LanguageModel.generateText({
 *     prompt: "Say hello.",
 *   }).pipe(Effect.orDie);
 *   return yield* HttpServerResponse.json({
 *     text: response.text,
 *     usage: {
 *       inputTokens: response.usage.inputTokens.total,
 *       outputTokens: response.usage.outputTokens.total,
 *     },
 *   });
 * }).pipe(Effect.provide(languageModel));
 * ```
 *
 * @section Streaming Text
 * @example Stream tokens as Server-Sent Events
 * `LanguageModel.streamText` returns a `Stream` of typed response parts.
 * `Stream.provide(languageModel)` keeps the model available for the whole
 * stream lifetime; pipe through `Sse.encode` for an SSE response.
 * ```typescript
 * import { LanguageModel } from "effect/unstable/ai";
 * import * as Stream from "effect/Stream";
 * import * as Sse from "effect/unstable/encoding/Sse";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * const stream = LanguageModel.streamText({ prompt }).pipe(
 *   Stream.provide(languageModel),
 *   Sse.encode,
 * );
 * return HttpServerResponse.stream(stream, {
 *   headers: {
 *     "content-type": "text/event-stream",
 *     "cache-control": "no-cache",
 *     "x-accel-buffering": "no",
 *   },
 * });
 * ```
 *
 * @section Tuning the Gateway
 * @example Production-grade caching, rate limits, and DLP
 * Every prop maps to an in-place update — no replacement, no downtime.
 * ```typescript
 * export const Gateway = Cloudflare.AiGateway("Gateway", {
 *   id: "prod-gateway",
 *   cacheTtl: 300,
 *   cacheInvalidateOnUpdate: true,
 *   rateLimitingInterval: 60,
 *   rateLimitingLimit: 100,
 *   rateLimitingTechnique: "sliding",
 *   collectLogs: true,
 *   logManagement: 100_000,
 *   logManagementStrategy: "DELETE_OLDEST",
 *   authentication: true,
 * });
 * ```
 */
export const AiGateway = Resource<AiGateway>("Cloudflare.AiGateway")({
  /**
   * Bind this gateway to the surrounding Worker, returning an Effect-native
   * client for the runtime AI Gateway binding.
   */
  bind: AiGatewayBinding.bind,
});

export const AiGatewayProvider = () =>
  Provider.effect(
    AiGateway,
    Effect.gen(function* () {
      const { accountId } = yield* CloudflareEnvironment;
      const createAiGateway = yield* aiGateway.createAiGateway;
      const getAiGateway = yield* aiGateway.getAiGateway;
      const updateAiGateway = yield* aiGateway.updateAiGateway;
      const deleteAiGateway = yield* aiGateway.deleteAiGateway;

      const createGatewayId = (id: string, gatewayId: string | undefined) =>
        Effect.gen(function* () {
          if (gatewayId) return gatewayId;
          return yield* createPhysicalName({
            id,
            maxLength: 64,
            lowercase: true,
          });
        });

      const desired = (id: string, props: AiGatewayProps | undefined) =>
        Effect.gen(function* () {
          return {
            gatewayId: yield* createGatewayId(id, props?.id),
            cacheInvalidateOnUpdate: props?.cacheInvalidateOnUpdate ?? false,
            cacheTtl: props?.cacheTtl ?? null,
            collectLogs: props?.collectLogs ?? true,
            rateLimitingInterval: props?.rateLimitingInterval ?? null,
            rateLimitingLimit: props?.rateLimitingLimit ?? null,
            rateLimitingTechnique: props?.rateLimitingTechnique ?? "fixed",
            // Defaults align with what Cloudflare's API returns for an
            // unconfigured gateway, so the reconciler converges to noop
            // when the user didn't explicitly set the field.
            authentication: props?.authentication ?? false,
            dlp: props?.dlp ?? undefined,
            isDefault: props?.isDefault ?? false,
            logManagement: props?.logManagement ?? 100_000,
            logManagementStrategy:
              props?.logManagementStrategy ?? "STOP_INSERTING",
            logpush: props?.logpush ?? false,
            logpushPublicKey: props?.logpushPublicKey ?? undefined,
            otel: props?.otel ?? undefined,
            storeId: props?.storeId ?? "",
            stripe: props?.stripe ?? undefined,
            zdr: props?.zdr ?? false,
          };
        });

      const mapGateway = (
        gateway:
          | aiGateway.GetAiGatewayResponse
          | aiGateway.CreateAiGatewayResponse
          | aiGateway.UpdateAiGatewayResponse,
        accountId: string,
      ): AiGateway["Attributes"] => ({
        gatewayId: gateway.id,
        accountId,
        // accountTag: gateway.accountTag ?? undefined,
        // internalId: gateway.internalId ?? undefined,
        cacheInvalidateOnUpdate: gateway.cacheInvalidateOnUpdate,
        cacheTtl: nullIfZero(gateway.cacheTtl),
        collectLogs: gateway.collectLogs,
        createdAt: gateway.createdAt,
        modifiedAt: gateway.modifiedAt,
        rateLimitingInterval: nullIfZero(gateway.rateLimitingInterval),
        rateLimitingLimit: nullIfZero(gateway.rateLimitingLimit),
        rateLimitingTechnique: gateway.rateLimitingTechnique ?? "fixed",
        authentication: gateway.authentication ?? false,
        // Distilled widened generated string enums to open unions (`string & {}`).
        dlp: (gateway.dlp ?? undefined) as AiGatewayDlp | undefined,
        isDefault: gateway.isDefault ?? false,
        logManagement: gateway.logManagement ?? 100_000,
        logManagementStrategy:
          gateway.logManagementStrategy ?? "STOP_INSERTING",
        logpush: gateway.logpush ?? false,
        logpushPublicKey: gateway.logpushPublicKey ?? undefined,
        otel: gateway.otel ?? undefined,
        storeId: gateway.storeId ?? "",
        stripe: gateway.stripe ?? undefined,
        zdr: gateway.zdr ?? false,
      });

      const mutable = (gateway: AiGateway["Attributes"]) => ({
        cacheInvalidateOnUpdate: gateway.cacheInvalidateOnUpdate,
        cacheTtl: gateway.cacheTtl,
        collectLogs: gateway.collectLogs,
        rateLimitingInterval: gateway.rateLimitingInterval,
        rateLimitingLimit: gateway.rateLimitingLimit,
        rateLimitingTechnique: gateway.rateLimitingTechnique,
        authentication: gateway.authentication,
        dlp: gateway.dlp,
        isDefault: gateway.isDefault,
        logManagement: gateway.logManagement,
        logManagementStrategy: gateway.logManagementStrategy,
        logpush: gateway.logpush,
        logpushPublicKey: gateway.logpushPublicKey,
        otel: gateway.otel,
        storeId: gateway.storeId,
        stripe: gateway.stripe,
        zdr: gateway.zdr,
      });

      const createRequest = Effect.fn(function* (
        id: string,
        props: AiGatewayProps | undefined,
      ) {
        const next = yield* desired(id, props);
        return {
          accountId,
          id: next.gatewayId,
          cacheInvalidateOnUpdate: next.cacheInvalidateOnUpdate,
          cacheTtl: next.cacheTtl,
          collectLogs: next.collectLogs,
          rateLimitingInterval: next.rateLimitingInterval,
          rateLimitingLimit: next.rateLimitingLimit,
          rateLimitingTechnique: next.rateLimitingTechnique,
          authentication: next.authentication,
          logManagement: next.logManagement,
          logManagementStrategy: next.logManagementStrategy,
          logpush: next.logpush,
          logpushPublicKey: next.logpushPublicKey,
          zdr: next.zdr,
        } satisfies aiGateway.CreateAiGatewayRequest;
      });

      const updateRequest = Effect.fn(function* (
        id: string,
        props: AiGatewayProps | undefined,
        accountId: string,
      ) {
        const next = yield* desired(id, props);
        return {
          accountId,
          id: next.gatewayId,
          cacheInvalidateOnUpdate: next.cacheInvalidateOnUpdate,
          cacheTtl: next.cacheTtl,
          collectLogs: next.collectLogs,
          rateLimitingInterval: next.rateLimitingInterval,
          rateLimitingLimit: next.rateLimitingLimit,
          rateLimitingTechnique: next.rateLimitingTechnique,
          authentication: next.authentication,
          dlp: next.dlp,
          logManagement: next.logManagement,
          logManagementStrategy: next.logManagementStrategy,
          logpush: next.logpush,
          logpushPublicKey: next.logpushPublicKey,
          otel: next.otel,
          storeId: next.storeId,
          stripe: next.stripe,
          zdr: next.zdr,
        } satisfies aiGateway.UpdateAiGatewayRequest;
      });

      return {
        stables: ["gatewayId", "accountId"],
        diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
          if (!isResolved(news)) return undefined;
          const next = yield* desired(id, news);
          const oldGatewayId =
            output?.gatewayId ?? (yield* createGatewayId(id, olds.id));
          if (
            (output?.accountId ?? accountId) !== accountId ||
            oldGatewayId !== next.gatewayId
          ) {
            return { action: "replace" } as const;
          }

          const oldMutable = mutable(
            output ?? ((yield* desired(id, olds)) as AiGateway["Attributes"]),
          );
          const nextMutable = mutable(next as AiGateway["Attributes"]);
          if (!deepEqual(oldMutable, nextMutable)) {
            return { action: "update" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news = {}, output }) {
          const acct = output?.accountId ?? accountId;
          const gatewayId =
            output?.gatewayId ?? (yield* createGatewayId(id, news.id));

          // Observe — fetch the gateway's current state. The Cloudflare API
          // returns 404 when the gateway is missing, which we tolerate so the
          // reconciler can fall through to create.
          const observed = yield* getAiGateway({
            accountId: acct,
            id: gatewayId,
          }).pipe(
            Effect.catchTag("GatewayNotFound", () => Effect.succeed(undefined)),
          );

          // Ensure — create if missing. Tolerate `GatewayAlreadyExists` for
          // idempotency: a peer reconciler may have created it concurrently,
          // or state persistence may have failed after a previous create.
          if (observed === undefined) {
            const request = yield* createRequest(id, news);
            yield* createAiGateway(request).pipe(
              Effect.catchTag("GatewayAlreadyExists", () =>
                getAiGateway({ accountId: acct, id: request.id }),
              ),
            );
          }

          // Sync — the Cloudflare AI Gateway update API is a full PATCH that
          // overwrites all mutable fields. We always apply the desired shape
          // so adoption, drift, and routine updates all converge.
          const update = yield* updateRequest(id, news, acct);
          const gateway = yield* updateAiGateway(update);
          return mapGateway(gateway, acct);
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deleteAiGateway({
            accountId: output.accountId,
            id: output.gatewayId,
          }).pipe(Effect.catchTag("GatewayNotFound", () => Effect.void));
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const gatewayId =
            output?.gatewayId ?? (yield* createGatewayId(id, olds?.id));
          const acct = output?.accountId ?? accountId;
          return yield* getAiGateway({
            accountId: acct,
            id: gatewayId,
          }).pipe(
            Effect.map((gateway) => mapGateway(gateway, acct)),
            Effect.catchTag("GatewayNotFound", () => Effect.succeed(undefined)),
          );
        }),
      };
    }),
  );

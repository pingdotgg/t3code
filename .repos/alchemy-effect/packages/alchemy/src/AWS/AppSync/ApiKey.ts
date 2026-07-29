import * as appsync from "@distilled.cloud/aws/appsync";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { retryConcurrentModification } from "./common.ts";
import type { GraphqlApi } from "./GraphqlApi.ts";

export interface ApiKeyProps {
  /**
   * ID of the GraphQL API. Usually derived from `api.apiId` by the
   * {@link ApiKey} wrapper.
   */
  apiId: string;
  /** Description of the key. */
  description?: string;
  /**
   * Expiry as epoch seconds, between 1 and 365 days from creation. AWS
   * rounds the value **down to the nearest hour**. When omitted, the key
   * expires 7 days after creation and expiry is left unmanaged.
   */
  expires?: number;
}

export interface AppSyncApiKey extends Resource<
  "AWS.AppSync.ApiKey",
  ApiKeyProps,
  {
    /** The API this key belongs to. */
    apiId: string;
    /**
     * The API key ID — this IS the secret key value (`da2-…`) clients send
     * in the `x-api-key` header. Wrapped in `Redacted` — unwrap with
     * `Redacted.value(key.id)` where the raw header value is needed.
     */
    id: Redacted.Redacted<string>;
    /** The key's expiry (epoch seconds, rounded down to the hour). */
    expires: number | undefined;
    /** The key's description. */
    description: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An AppSync API key for `API_KEY`-authenticated GraphQL APIs.
 *
 * The key's `id` attribute is the secret value (`da2-…`) sent in the
 * `x-api-key` request header. It is wrapped in `Redacted`; unwrap with
 * `Redacted.value(key.id)` where the raw header value is needed.
 * @resource
 * @section Creating API Keys
 * @example Key with the default 7-day expiry
 * ```typescript
 * const key = yield* AppSync.ApiKey("Key", { api });
 * // Redacted.value(key.id) → "da2-…" — send as the x-api-key header
 * ```
 *
 * @example Key with a managed expiry
 * ```typescript
 * const key = yield* AppSync.ApiKey("Key", {
 *   api,
 *   description: "mobile clients",
 *   expires: 1893456000, // rounded down to the hour by AWS
 * });
 * ```
 */
export const ApiKeyResource = Resource<AppSyncApiKey>("AWS.AppSync.ApiKey");

export interface ApiKeyInputProps extends Omit<
  {
    [K in keyof ApiKeyProps]?: Input<ApiKeyProps[K]>;
  },
  "apiId"
> {
  /**
   * The `GraphqlApi` this key belongs to (preferred). Alternatively pass a
   * raw `apiId`.
   */
  api?: GraphqlApi;
  apiId?: Input<string>;
}

/**
 * User-facing wrapper for the ApiKey resource. Accepts `api: GraphqlApi`
 * as the idiomatic way to mint a key for an API.
 */
export const ApiKey = (id: string, props: ApiKeyInputProps = {}) =>
  Effect.gen(function* () {
    const { api, ...rest } = props;
    const apiId = rest.apiId ?? api?.apiId;
    if (!apiId) {
      return yield* Effect.die(
        "ApiKey requires either `api` (preferred) or an explicit `apiId`.",
      );
    }
    return yield* ApiKeyResource(id, { ...rest, apiId } as any);
  });

/** AWS rounds key expiry down to the nearest hour. */
const floorToHour = (epochSeconds: number): number =>
  Math.floor(epochSeconds / 3600) * 3600;

export const ApiKeyProvider = () =>
  Provider.effect(
    ApiKeyResource,
    Effect.gen(function* () {
      /** Find a key by its ID (keys have no other stable identity). */
      const findKey = Effect.fn(function* (apiId: string, keyId: string) {
        const pages = yield* appsync.listApiKeys.pages({ apiId }).pipe(
          Stream.runCollect,
          Effect.catchTag("NotFoundException", () => Effect.succeed([])),
        );
        return Array.from(pages)
          .flatMap((page) => page.apiKeys ?? [])
          .find((key) => key.id === keyId);
      });

      const toAttributes = (
        apiId: string,
        key: appsync.ApiKey,
      ): AppSyncApiKey["Attributes"] => ({
        apiId,
        // The key id doubles as the secret `x-api-key` header value.
        id: Redacted.make(key.id!),
        expires: key.expires,
        description: key.description,
      });

      return ApiKeyResource.Provider.of({
        stables: ["apiId", "id"],

        // Sub-resource keyed entirely by its GraphQL API (apiId) with no global
        // enumeration API of its own — nuke reaches it through the parent's
        // deletion, so enumeration returns empty per the ProviderService
        // doctrine.
        list: () => Effect.succeed([]),

        read: Effect.fn(function* ({ output }) {
          // Keys carry no deterministic identity — without the cached id
          // there is nothing to look up (a fresh reconcile will mint one).
          if (output?.id === undefined) return undefined;
          const key = yield* findKey(output.apiId, Redacted.value(output.id));
          if (key?.id == null) return undefined;
          return toAttributes(output.apiId, key);
        }),

        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return undefined;
          if (news.apiId !== olds.apiId) {
            return { action: "replace" } as const;
          }
          // description/expires converge via updateApiKey
        }),

        reconcile: Effect.fn(function* ({ news, output, session }) {
          const apiId = output?.apiId ?? news.apiId;

          // 1. OBSERVE — the cached key id is the only handle.
          let observed =
            output?.id !== undefined
              ? yield* findKey(apiId, Redacted.value(output.id))
              : undefined;

          if (observed?.id == null) {
            // 2. ENSURE
            const created = yield* retryConcurrentModification(
              appsync.createApiKey({
                apiId,
                description: news.description,
                expires: news.expires,
              }),
            );
            observed = created.apiKey!;
            yield* session.note(`Created API key for ${apiId}`);
          } else {
            // 3. SYNC — update description/expiry on drift (expiry only
            //    when managed by props; AWS floors it to the hour).
            const expiresDrifted =
              news.expires !== undefined &&
              observed.expires !== floorToHour(news.expires);
            const descriptionDrifted =
              news.description !== undefined &&
              observed.description !== news.description;
            if (expiresDrifted || descriptionDrifted) {
              const updated = yield* retryConcurrentModification(
                appsync.updateApiKey({
                  apiId,
                  id: observed.id,
                  description: news.description,
                  expires: news.expires,
                }),
              );
              observed = updated.apiKey ?? observed;
              yield* session.note(`Updated API key ${observed.id}`);
            }
          }

          return toAttributes(apiId, observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* retryConcurrentModification(
            appsync
              .deleteApiKey({
                apiId: output.apiId,
                id: Redacted.value(output.id),
              })
              .pipe(Effect.catchTag("NotFoundException", () => Effect.void)),
          );
        }),
      });
    }),
  );

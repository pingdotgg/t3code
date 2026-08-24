import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.AI.SearchToken" as const;
type TypeId = typeof TypeId;

export type SearchTokenProps = {
  /**
   * Display name for the service token. Mutable in place.
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * Id of the underlying Cloudflare API token AI Search authenticates
   * with when syncing the data source. The token must carry the
   * "AI Search Index Engine" permission group — Cloudflare validates it
   * on create/update and rejects tokens without it.
   */
  cfApiId: string;
  /**
   * Plaintext value of the underlying Cloudflare API token. Write-only —
   * Cloudflare never returns it, so rotation is detected against the
   * previously-persisted props rather than observed cloud state.
   */
  cfApiKey: Redacted.Redacted<string>;
  /**
   * Whether this is a legacy (account-level instance) token.
   * @default false
   */
  legacy?: boolean;
};

export type TokenAttributes = {
  /**
   * AI Search service token id (a UUID). Stable across updates.
   */
  id: string;
  /**
   * The Cloudflare account the token belongs to.
   */
  accountId: string;
  /**
   * Display name of the service token.
   */
  name: string;
  /**
   * Id of the underlying Cloudflare API token.
   */
  cfApiId: string;
  /**
   * Whether the token is enabled.
   */
  enabled: boolean | undefined;
  /**
   * Whether this is a legacy (account-level instance) token.
   */
  legacy: boolean | undefined;
  /**
   * When the token was created.
   */
  createdAt: string | undefined;
  /**
   * When the token was last modified.
   */
  modifiedAt: string | undefined;
  /**
   * Who created the token.
   */
  createdBy: string | undefined;
  /**
   * Who last modified the token.
   */
  modifiedBy: string | undefined;
};

export type SearchToken = Resource<
  TypeId,
  SearchTokenProps,
  TokenAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare.AI. Search service token — the credential AI Search uses to
 * access your data source (R2 bucket, Vectorize index, Workers AI) when
 * indexing.
 *
 * The token wraps an existing Cloudflare API token (`cfApiId` +
 * `cfApiKey`). That API token must carry the "AI Search Index Engine"
 * permission group — Cloudflare validates the credential on create and
 * update and rejects tokens without it. Pair it with
 * `Cloudflare.ApiToken.AccountApiToken` to mint the underlying API token in the
 * same stack, then reference the service token's `id` from an AI Search
 * instance's `tokenId` prop.
 * @resource
 * @product AI Search
 * @category AI
 * @section Creating a Token
 * @example Minting the underlying API token in the same stack
 * ```typescript
 * const apiToken = yield* Cloudflare.ApiToken.AccountApiToken("SearchTokenSource", {
 *   policies: [
 *     {
 *       effect: "allow",
 *       permissionGroups: ["AI Search Index Engine"],
 *       resources: { [`com.cloudflare.api.account.${accountId}`]: "*" },
 *     },
 *   ],
 * });
 * const token = yield* Cloudflare.AI.SearchToken("SearchToken", {
 *   cfApiId: apiToken.tokenId,
 *   cfApiKey: apiToken.value,
 * });
 * ```
 *
 * @section Using the Token from a SearchInstance
 * @example Wiring the token into an AI Search instance
 * ```typescript
 * const search = yield* Cloudflare.AI.Search("Search", {
 *   source: bucket,
 *   tokenId: token.id,
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/ai-search/
 */
export const SearchToken = Resource<SearchToken>(TypeId, {
  aliases: ["Cloudflare.AiSearch.Token"],
});

/**
 * Returns true if the given value is a SearchToken resource.
 */
export const isSearchToken = (value: unknown): value is SearchToken =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const SearchTokenProvider = () =>
  Provider.succeed(SearchToken, {
    stables: ["id", "accountId", "createdAt", "createdBy"],
    diff: Effect.fn(function* ({ news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // Everything (name, credentials, legacy flag) is mutable via PUT —
      // let the engine apply its default update logic.
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const observed = output?.id
        ? yield* getToken(acct, output.id)
        : // Cold read (lost state): the display name is deterministic, so
          // scan the token list for it.
          yield* findTokenByName(acct, yield* createTokenName(id, olds?.name));
      return observed ? toAttributes(observed, acct) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      const name = yield* createTokenName(id, news.name);

      // Observe — `output.id` is a cache, not a guarantee: a missing
      // token falls through to "missing" and we recreate. Without an id
      // (greenfield or adoption-by-name), scan the list for the
      // deterministic display name.
      const observed = output?.id
        ? yield* getToken(acct, output.id)
        : yield* findTokenByName(acct, name);

      const body = {
        name,
        cfApiId: news.cfApiId as string,
        cfApiKey: Redacted.value(news.cfApiKey as Redacted.Redacted<string>),
        // Cloudflare defaults an omitted `legacy` to `true`, and legacy
        // (account-level instance) tokens cannot be managed via the per-token
        // routes — GET/DELETE `/ai-search/tokens/{id}` return 401, so they can
        // never be read or deleted, leaking on every teardown. Force
        // non-legacy unless the caller explicitly opts in.
        legacy: news.legacy ?? false,
      };

      if (!observed) {
        // Ensure — create with the full desired body. A freshly minted
        // underlying API token propagates eventually-consistently, so a
        // transient `InvalidTokenCredentials` (code 7012) is retried
        // briefly before being treated as a real validation failure.
        const created = yield* aisearch
          .createToken({ accountId: acct, ...body })
          .pipe(retryTokenPropagation);
        return toAttributes(created, acct);
      }

      // Sync — Cloudflare never returns `cfApiKey`, so the secret cannot
      // be diffed against observed state; fall back to the previously
      // persisted props for the key only. Everything else diffs against
      // the observed cloud state.
      const keyRotated =
        olds === undefined ||
        olds.cfApiKey === undefined ||
        !isResolved(olds.cfApiKey) ||
        Redacted.value(olds.cfApiKey) !== body.cfApiKey;
      const dirty =
        keyRotated ||
        observed.name !== name ||
        observed.cfApiId !== body.cfApiId ||
        (news.legacy !== undefined &&
          (observed.legacy ?? undefined) !== news.legacy);
      if (!dirty) {
        return toAttributes(observed, acct);
      }

      // The update is a PUT and always requires the full credential pair.
      const updated = yield* aisearch
        .updateToken({ accountId: acct, id: observed.id, ...body })
        .pipe(retryTokenPropagation);
      return toAttributes(updated, acct);
    }),
    list: () =>
      // Service tokens are account-scoped (`/accounts/{id}/ai-search/tokens`),
      // not nested under an instance — one paginated list per account.
      Effect.gen(function* () {
        const { accountId } = yield* yield* CloudflareEnvironment;
        return yield* aisearch.listTokens
          .pages({ accountId, perPage: 50 })
          .pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                // The list item shape matches the create/read response, so the
                // emitted Attributes are identical to `read` (the write-only
                // `cfApiKey` is never part of Attributes anyway).
                (page.result ?? []).map((t) => toAttributes(t, accountId)),
              ),
            ),
            // AI Search isn't enabled on every account — the route is gated
            // rather than returning an empty list. Treat it as "none".
            Effect.catchTag("InvalidRoute", () => Effect.succeed([])),
          );
      }),
    delete: Effect.fn(function* ({ output }) {
      // A missing token (already deleted) is success. An AI Search
      // instance that referenced this token may still be deleting
      // asynchronously — Cloudflare rejects the delete with
      // `token_in_use_by_instances` until the instance is gone, so ride
      // that out briefly.
      yield* aisearch
        .deleteToken({ accountId: output.accountId, id: output.id })
        .pipe(
          Effect.retry({
            while: (e) => e._tag === "TokenInUseByInstances",
            // The referencing instance tears down its managed Vectorize
            // index asynchronously and can hold the token well past two
            // minutes. Poll at a steady 5s and give it a generous overall
            // budget (~5min) so the token delete reliably waits out the
            // instance instead of racing the teardown and failing flakily.
            schedule: Schedule.spaced("5 seconds"),
            times: 60,
          }),
          Effect.catchTag("TokenNotFound", () => Effect.void),
        );
    }),
  });

type ObservedToken = aisearch.CreateTokenResponse;

/**
 * Read a token by id, mapping "gone" (`TokenNotFound`, Cloudflare error
 * code 7075) to `undefined`. The read response declares every field
 * optional, so observed identity fields are re-asserted from the request.
 */
const getToken = (accountId: string, id: string) =>
  aisearch.readToken({ accountId, id }).pipe(
    Effect.map(
      (t): ObservedToken => ({
        id: t.id ?? id,
        name: t.name ?? "",
        cfApiId: t.cfApiId ?? "",
        createdAt: t.createdAt ?? "",
        modifiedAt: t.modifiedAt ?? "",
        createdBy: t.createdBy,
        enabled: t.enabled,
        legacy: t.legacy,
        modifiedBy: t.modifiedBy,
      }),
    ),
    Effect.catchTag("TokenNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Scan the account's service tokens for an exact display-name match
 * (used for cold reads and greenfield creates after lost state). The
 * `search` query param chokes on long strings (generated physical names
 * can hit the limit), so this streams all pages and filters client-side.
 */
const findTokenByName = (accountId: string, name: string) =>
  aisearch.listTokens.items({ accountId, perPage: 50 }).pipe(
    Stream.filter((t) => t.name === name),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );

const createTokenName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    return name ?? (yield* createPhysicalName({ id, lowercase: true }));
  });

/**
 * A freshly minted underlying API token may not have propagated yet when
 * AI Search validates it — ride out transient `InvalidTokenCredentials`
 * (code 7012) with a short, bounded retry. Genuinely invalid credentials
 * still fail after the retries are exhausted.
 */
const retryTokenPropagation = <A, E extends { _tag: string }, R>(
  effect: Effect.Effect<A, E, R>,
) =>
  effect.pipe(
    Effect.retry({
      while: (e) => e._tag === "InvalidTokenCredentials",
      schedule: Schedule.exponential("1 second"),
      times: 6,
    }),
  );

const toAttributes = (
  token: ObservedToken | aisearch.UpdateTokenResponse,
  accountId: string,
): TokenAttributes => ({
  id: token.id,
  accountId,
  name: token.name,
  cfApiId: token.cfApiId,
  enabled: token.enabled ?? undefined,
  legacy: token.legacy ?? undefined,
  createdAt: token.createdAt || undefined,
  modifiedAt: token.modifiedAt || undefined,
  createdBy: token.createdBy ?? undefined,
  modifiedBy: token.modifiedBy ?? undefined,
});

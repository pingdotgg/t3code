import * as location from "@distilled.cloud/aws/location";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import { toTagRecord } from "./internal.ts";

/**
 * What a Location API key is allowed to call. Keys authorize *unsigned*
 * requests, so restrictions should be as narrow as possible.
 */
export interface ApiKeyRestrictions {
  /**
   * Allowed API actions, e.g. `["geo:GetMap*"]` or
   * `["geo:SearchPlaceIndexForText"]`. Wildcards are allowed at the end of
   * an action name.
   */
  allowActions: string[];
  /**
   * Allowed resource ARNs, e.g. a specific map's ARN or a wildcard like
   * `arn:aws:geo:*:*:map/*`.
   */
  allowResources: string[];
  /**
   * Optional HTTP referer patterns the key may be used from, e.g.
   * `["https://example.com/*"]`.
   */
  allowReferers?: string[];
}

export interface ApiKeyProps {
  /**
   * Name of the API key. Immutable — changing it replaces the key.
   * @default ${app}-${stage}-${id}
   */
  keyName?: string;
  /**
   * The actions, resources, and referers the key is allowed to be used
   * with. Updatable in place.
   */
  restrictions: ApiKeyRestrictions;
  /**
   * Optional description of the API key.
   */
  description?: string;
  /**
   * Expiry as an ISO-8601 timestamp, e.g. `"2027-01-01T00:00:00Z"`.
   * Mutually exclusive with `noExpiry`.
   */
  expireTime?: string;
  /**
   * Create the key without an expiry.
   * @default true when `expireTime` is omitted
   */
  noExpiry?: boolean;
  /**
   * Tags to associate with the API key.
   */
  tags?: Record<string, string>;
}

export interface ApiKey extends Resource<
  "AWS.Location.ApiKey",
  ApiKeyProps,
  {
    /** Physical name of the API key. */
    keyName: string;
    /** ARN of the API key resource. */
    keyArn: string;
    /**
     * The key value clients send (`v1.public.…`). Wrapped in `Redacted` —
     * unwrap with `Redacted.value(apiKey.key)` where the raw value is
     * needed.
     */
    key: Redacted.Redacted<string>;
    /** Restrictions currently applied to the key. */
    restrictions: ApiKeyRestrictions;
    /** Expiry timestamp (ISO-8601), if any. */
    expireTime: string | undefined;
    /** Description of the API key. */
    description: string | undefined;
    /** Tags currently associated with the key. */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Location Service API key. API keys authorize **unsigned**
 * requests (e.g. map tiles rendered directly in a browser) to a restricted
 * set of Location actions and resources. The key name is immutable;
 * restrictions, description, and expiry can be updated in place.
 *
 * The `key` attribute is the secret key value (`v1.public.…`) clients pass
 * as the `key` query parameter; it is wrapped in `Redacted`.
 *
 * Availability: Amazon Location classic (V1) is closed to newer AWS
 * accounts — `geo:CreateKey` is rejected service-side with an
 * `AccessDeniedException` regardless of IAM policy. Accounts onboarded to
 * Location before the V2 split can create keys normally.
 *
 * @resource
 * @section Creating API Keys
 * @example Map-Rendering Key for Browsers
 * ```typescript
 * import * as Location from "alchemy/AWS/Location";
 *
 * const map = yield* Location.Map("SiteMap", {
 *   configuration: { style: "VectorEsriStreets" },
 * });
 *
 * const key = yield* Location.ApiKey("SiteMapKey", {
 *   restrictions: {
 *     allowActions: ["geo:GetMap*"],
 *     allowResources: [map.mapArn],
 *   },
 * });
 * // Redacted.value(key.key) → "v1.public.…" — append as ?key=… to tile URLs
 * ```
 *
 * @example Key with Referer Restrictions and Expiry
 * ```typescript
 * const key = yield* Location.ApiKey("WebKey", {
 *   restrictions: {
 *     allowActions: ["geo:GetMap*"],
 *     allowResources: ["arn:aws:geo:*:*:map/*"],
 *     allowReferers: ["https://example.com/*"],
 *   },
 *   expireTime: "2027-01-01T00:00:00Z",
 * });
 * ```
 */
export const ApiKey = Resource<ApiKey>("AWS.Location.ApiKey");

const createKeyName = (id: string, props: { keyName?: string | undefined }) =>
  Effect.gen(function* () {
    if (props.keyName) return props.keyName;
    return yield* createPhysicalName({ id, maxLength: 100 });
  });

const unredact = (value: string | Redacted.Redacted<string>): string =>
  Redacted.isRedacted(value) ? Redacted.value(value) : value;

const toRestrictions = (
  restrictions: location.ApiKeyRestrictions,
): ApiKeyRestrictions => ({
  allowActions: [...restrictions.AllowActions],
  allowResources: [...restrictions.AllowResources],
  allowReferers:
    restrictions.AllowReferers === undefined
      ? undefined
      : (
          restrictions.AllowReferers as (string | Redacted.Redacted<string>)[]
        ).map(unredact),
});

/** Order-insensitive structural comparison of key restrictions. */
const sameRestrictions = (a: ApiKeyRestrictions, b: ApiKeyRestrictions) => {
  const norm = (r: ApiKeyRestrictions) =>
    JSON.stringify({
      actions: [...r.allowActions].sort(),
      resources: [...r.allowResources].sort(),
      referers: [...(r.allowReferers ?? [])].sort(),
    });
  return norm(a) === norm(b);
};

const readKey = Effect.fn(function* (keyName: string) {
  const found = yield* location
    .describeKey({ KeyName: keyName })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!found) return undefined;
  return {
    keyName: found.KeyName,
    keyArn: found.KeyArn,
    key: Redacted.make(unredact(found.Key)),
    restrictions: toRestrictions(found.Restrictions),
    expireTime: found.ExpireTime ? found.ExpireTime.toISOString() : undefined,
    description: found.Description ? found.Description : undefined,
    tags: toTagRecord(found.Tags),
  } satisfies ApiKey["Attributes"];
});

export const ApiKeyProvider = () =>
  Provider.effect(
    ApiKey,
    Effect.gen(function* () {
      return {
        stables: ["keyName", "keyArn", "key"],
        list: () =>
          Effect.gen(function* () {
            const names = yield* location.listKeys.pages({}).pipe(
              EffectStream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Entries ?? []).map((entry) => entry.KeyName),
                ),
              ),
            );
            const hydrated = yield* Effect.forEach(
              names,
              (name) => readKey(name),
              { concurrency: 10 },
            );
            return hydrated.filter(
              (attrs): attrs is ApiKey["Attributes"] => attrs !== undefined,
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const keyName =
            output?.keyName ?? (yield* createKeyName(id, olds ?? {}));
          const state = yield* readKey(keyName);
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags as Tags))
            ? state
            : Unowned(state);
        }),
        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return;
          const oldName = yield* createKeyName(id, olds);
          const newName = yield* createKeyName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const keyName = output?.keyName ?? (yield* createKeyName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredRestrictions: location.ApiKeyRestrictions = {
            AllowActions: news.restrictions.allowActions,
            AllowResources: news.restrictions.allowResources,
            AllowReferers: news.restrictions.allowReferers,
          };

          let state = yield* readKey(keyName);

          if (state === undefined) {
            yield* location
              .createKey({
                KeyName: keyName,
                Restrictions: desiredRestrictions,
                Description: news.description,
                ExpireTime: news.expireTime
                  ? new Date(news.expireTime)
                  : undefined,
                NoExpiry: news.expireTime ? undefined : (news.noExpiry ?? true),
                Tags: desiredTags,
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
            state = yield* readKey(keyName);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created API key ${keyName}`),
              );
            }
          }

          const desiredExpireTime = news.expireTime
            ? new Date(news.expireTime).toISOString()
            : undefined;
          if (
            state.description !== (news.description ?? undefined) ||
            !sameRestrictions(state.restrictions, news.restrictions) ||
            (desiredExpireTime !== undefined &&
              state.expireTime !== desiredExpireTime)
          ) {
            yield* location.updateKey({
              KeyName: keyName,
              Description: news.description,
              Restrictions: desiredRestrictions,
              ExpireTime: desiredExpireTime
                ? new Date(desiredExpireTime)
                : undefined,
              NoExpiry: desiredExpireTime ? undefined : true,
              // Required to update a key that has been used recently.
              ForceUpdate: true,
            });
          }

          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (removed.length > 0) {
            yield* location.untagResource({
              ResourceArn: state.keyArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* location.tagResource({
              ResourceArn: state.keyArn,
              Tags: Object.fromEntries(upsert.map((t) => [t.Key, t.Value])),
            });
          }

          yield* session.note(state.keyArn);

          const final = yield* readKey(keyName);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled API key ${keyName}`),
            );
          }
          return final;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* location
            .deleteKey({ KeyName: output.keyName, ForceDelete: true })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

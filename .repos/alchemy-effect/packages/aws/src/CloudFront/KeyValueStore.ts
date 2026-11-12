import * as cloudfront from "@distilled.cloud/aws/cloudfront";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";

export interface KeyValueStoreProps {
  /**
   * KeyValueStore name. If omitted, a deterministic name is generated.
   */
  name?: string;
  /**
   * Optional store comment.
   */
  comment?: string;
}

export interface KeyValueStore extends Resource<
  "AWS.CloudFront.KeyValueStore",
  KeyValueStoreProps,
  {
    /**
     * KeyValueStore ID.
     */
    keyValueStoreId: string;
    /**
     * Store ARN.
     */
    keyValueStoreArn: string;
    /**
     * Store name.
     */
    keyValueStoreName: string;
    /**
     * Current comment.
     */
    comment: string;
  },
  never,
  Providers
> {}

/**
 * A CloudFront KeyValueStore for edge metadata.
 *
 * KeyValueStores can be associated with CloudFront Functions and are useful for
 * routing metadata or other small edge-time lookup tables.
 * ### Creating KeyValueStores
 * **Example:** Basic Store
 * ```typescript
 * const store = yield* KeyValueStore("RouterStore", {
 *   comment: "Route metadata",
 * });
 * ```
 *
 * @resource
 */
export const KeyValueStore = Resource<KeyValueStore>("AWS.CloudFront.KeyValueStore");

export const KeyValueStoreProvider = () =>
  Provider.effect(
    KeyValueStore,
    Effect.gen(function* () {
      const getByName = Effect.fn(function* (name: string) {
        const store = yield* cloudfront.listKeyValueStores.pages({}).pipe(
          Stream.map((page) => page.KeyValueStoreList?.Items ?? []),
          Stream.flattenIterable,
          Stream.filter((item) => item.Name === name),
          Stream.runHead,
          Effect.map(Option.getOrUndefined),
        );
        if (!store?.Name) {
          return undefined;
        }
        return yield* cloudfront
          .describeKeyValueStore({ Name: store.Name })
          .pipe(Effect.catchTag("EntityNotFound", () => Effect.undefined));
      });

      return {
        stables: ["keyValueStoreId", "keyValueStoreArn", "keyValueStoreName"],
        diff: Effect.fn(function* ({ id, olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          if ((yield* createName(id, olds ?? {})) !== (yield* createName(id, news))) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const name = output?.keyValueStoreName ?? (yield* createName(id, olds ?? {}));
          const current = yield* cloudfront
            .describeKeyValueStore({ Name: name })
            .pipe(Effect.catchTag("EntityNotFound", () => getByName(name)));
          if (!current?.KeyValueStore) {
            return undefined;
          }
          return toAttrs(current.KeyValueStore, name);
        }),
        // CloudFront is global; `listKeyValueStores` enumerates every store in
        // the account.
        list: () =>
          cloudfront.listKeyValueStores.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.KeyValueStoreList?.Items ?? []).map((store) => toAttrs(store, store.Name)),
              ),
            ),
          ),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = output?.keyValueStoreName ?? (yield* createName(id, news));

          // Observe — describe the store, falling back to a list lookup
          // by name. Trust live state, not stale `olds`.
          const observed = yield* cloudfront
            .describeKeyValueStore({ Name: name })
            .pipe(Effect.catchTag("EntityNotFound", () => getByName(name)));

          // Ensure — create the store if it's missing. Tolerate
          // `EntityAlreadyExists` (race with a peer reconciler).
          if (!observed?.KeyValueStore) {
            const created = yield* cloudfront
              .createKeyValueStore({ Name: name, Comment: news.comment })
              .pipe(
                Effect.catchTag("EntityAlreadyExists", () =>
                  getByName(name).pipe(
                    Effect.flatMap((existing) =>
                      existing
                        ? Effect.succeed(existing)
                        : Effect.die(
                            `CloudFront KeyValueStore '${name}' already exists but could not be recovered`,
                          ),
                    ),
                  ),
                ),
              );
            if (!created.KeyValueStore) {
              return yield* Effect.die("createKeyValueStore returned no key value store");
            }
            yield* session.note(created.KeyValueStore.Id);
            return toAttrs(created.KeyValueStore, name);
          }

          // Sync — patch the observed comment via `updateKeyValueStore`
          // using the freshly observed ETag.
          const updated = yield* cloudfront.updateKeyValueStore({
            Name: observed.KeyValueStore.Name,
            Comment: news.comment ?? "",
            IfMatch: observed.ETag!,
          });
          if (!updated.KeyValueStore) {
            return yield* Effect.die("updateKeyValueStore returned no key value store");
          }
          yield* session.note(updated.KeyValueStore.Id);
          return toAttrs(updated.KeyValueStore, observed.KeyValueStore.Name);
        }),
        delete: Effect.fn(
          function* ({ output }) {
            const current = yield* cloudfront
              .describeKeyValueStore({ Name: output.keyValueStoreName })
              .pipe(Effect.catchTag("EntityNotFound", () => Effect.undefined));

            const etag = current?.ETag;
            if (!etag) {
              yield* Effect.logInfo(
                `CloudFront KeyValueStore delete: ${output.keyValueStoreName} already absent`,
              );
              return;
            }

            yield* Effect.logInfo(
              `CloudFront KeyValueStore delete: deleting ${output.keyValueStoreName} with etag=${etag}`,
            );
            yield* cloudfront
              .deleteKeyValueStore({ Name: output.keyValueStoreName, IfMatch: etag })
              .pipe(Effect.catchTag("EntityNotFound", () => Effect.void));
          },
          Effect.retry({
            // KV writes can invalidate the control-plane ETag before Describe
            // catches up. Retry the entire read/delete pair with a fresh ETag.
            while: (error) => error._tag === "PreconditionFailed",
            schedule: Schedule.spaced("500 millis"),
            times: 8,
          }),
        ),
      };
    }),
  );

const createName = (id: string, props: KeyValueStoreProps) =>
  props.name
    ? Effect.succeed(props.name)
    : createPhysicalName({ id, maxLength: 64, lowercase: true });

// Status, last-modified time and ETag change on their own (provisioning
// finishes, every key write bumps them), so they are not attributes: drift
// would never read a store as unchanged.
const toAttrs = (
  store: cloudfront.KeyValueStore,
  fallbackName: string,
): KeyValueStore["Attributes"] => ({
  keyValueStoreId: store.Id,
  keyValueStoreArn: store.ARN,
  keyValueStoreName: store.Name || fallbackName,
  comment: store.Comment ?? "",
});

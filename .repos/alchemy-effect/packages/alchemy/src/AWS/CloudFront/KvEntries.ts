import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import type { Input } from "../../Input.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  extractValue,
  getKvsEtag,
  isKvsPreconditionFailed,
  retryForKvsReadiness,
  withKvsRegionFn,
} from "./common.ts";

export interface KvEntriesProps {
  /** ARN of the CloudFront KeyValueStore. */
  store: string;
  /** Namespace prefix for all keys. Keys are stored as `{namespace}:{key}`. */
  namespace: string;
  /** Map of key → value entries to manage. */
  entries: Record<string, Input<string>>;
  /** Whether to delete keys under this namespace that are not in `entries`. @default false */
  purge?: boolean;
}

export interface KvEntries extends Resource<
  "AWS.CloudFront.KvEntries",
  KvEntriesProps,
  {
    /** ARN of the CloudFront KeyValueStore. */
    store: string;
    /** Namespace prefix used for keys. */
    namespace: string;
    /** Current entries managed under the namespace. */
    entries: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * Manages namespaced key-value entries in a CloudFront KeyValueStore.
 *
 * Entries are stored with a `{namespace}:{key}` prefix to allow multiple
 * logical groups within a single store. Updates use batched optimistic
 * concurrency with automatic ETag retry.
 *
 * @section Managing Entries
 * @example Basic Entries
 * ```typescript
 * const entries = yield* KvEntries("Routes", {
 *   store: store.keyValueStoreArn,
 *   namespace: "routes",
 *   entries: {
 *     "/": "/index.html",
 *     "/about": "/about.html",
 *   },
 * });
 * ```
 *
 * @example Purge Stale Keys
 * ```typescript
 * const entries = yield* KvEntries("Routes", {
 *   store: store.keyValueStoreArn,
 *   namespace: "routes",
 *   entries: { "/": "/index.html" },
 *   purge: true,
 * });
 * ```
 */
export const KvEntries = Resource<KvEntries>("AWS.CloudFront.KvEntries");

const BATCH_SIZE = 50;
type ResolvedEntries = {
  [key: string]: Input.Resolve<KvEntriesProps["entries"][string]>;
};

const resolveEntries = (entries: KvEntriesProps["entries"]): ResolvedEntries =>
  Object.fromEntries(
    Object.entries(entries).map(([key, value]) => [key, value]),
  ) as ResolvedEntries;

export const KvEntriesProvider = () =>
  Provider.effect(
    KvEntries,
    // @ts-expect-error
    Effect.gen(function* () {
      const collectAllKeys = Effect.fn(function* (store: string) {
        const keys: { Key: string; Value: string }[] = [];
        let nextToken: string | undefined;
        do {
          const resp = yield* kvs.listKeys({
            KvsARN: store,
            NextToken: nextToken,
          });
          for (const item of resp.Items ?? []) {
            keys.push({
              Key: item.Key,
              Value: extractValue(item.Value),
            });
          }
          nextToken = resp.NextToken;
        } while (nextToken);
        return keys;
      });

      const sendBatch = Effect.fn(function* (
        store: string,
        etag: string,
        puts: kvs.PutKeyRequestListItem[],
        deletes: kvs.DeleteKeyRequestListItem[],
      ) {
        return yield* kvs.updateKeys({
          KvsARN: store,
          IfMatch: etag,
          Puts: puts.length > 0 ? puts : undefined,
          Deletes: deletes.length > 0 ? deletes : undefined,
        });
      });

      const batchUpdateKeys = Effect.fn(function* (
        store: string,
        etag: string | undefined,
        puts: kvs.PutKeyRequestListItem[],
        deletes: kvs.DeleteKeyRequestListItem[],
      ) {
        let remainingPuts = puts;
        let remainingDeletes = deletes;
        let currentEtag = etag ?? (yield* getKvsEtag(store));

        while (remainingPuts.length > 0 || remainingDeletes.length > 0) {
          const batchPuts = remainingPuts.slice(0, BATCH_SIZE);
          const batchDeletes = remainingDeletes.slice(
            0,
            BATCH_SIZE - batchPuts.length,
          );

          const resp = yield* sendBatch(
            store,
            currentEtag,
            batchPuts,
            batchDeletes,
          ).pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "ValidationException" &&
                isKvsPreconditionFailed(error),
              schedule: Schedule.exponential("100 millis").pipe(
                Schedule.both(Schedule.recurs(24)),
              ),
            }),
          );

          currentEtag = resp.ETag;
          remainingPuts = remainingPuts.slice(batchPuts.length);
          remainingDeletes = remainingDeletes.slice(batchDeletes.length);
        }
      });

      const upload = Effect.fn(function* (
        store: string,
        namespace: string,
        entries: ResolvedEntries,
        oldEntries: ResolvedEntries | undefined,
      ) {
        const puts: kvs.PutKeyRequestListItem[] = [];
        for (const [key, value] of Object.entries(entries)) {
          if (oldEntries === undefined || oldEntries[key] !== value) {
            puts.push({ Key: `${namespace}:${key}`, Value: value as any });
          }
        }
        if (puts.length > 0) {
          yield* batchUpdateKeys(store, undefined, puts, []);
        }
      });

      const purge = Effect.fn(function* (
        store: string,
        namespace: string,
        keepEntries: ResolvedEntries | undefined,
      ) {
        const allKeys = yield* collectAllKeys(store);
        const prefix = `${namespace}:`;
        const deletes: kvs.DeleteKeyRequestListItem[] = [];
        for (const item of allKeys) {
          if (!item.Key.startsWith(prefix)) continue;
          const unprefixed = item.Key.slice(prefix.length);
          if (keepEntries && unprefixed in keepEntries) continue;
          deletes.push({ Key: item.Key });
        }
        if (deletes.length > 0) {
          yield* batchUpdateKeys(store, undefined, [], deletes);
        }
      });

      return {
        read: withKvsRegionFn(
          Effect.fn(function* ({ output }) {
            return output;
          }),
        ),
        reconcile: withKvsRegionFn(
          Effect.fn(function* ({ news, output }) {
            return yield* retryForKvsReadiness(
              Effect.gen(function* () {
                const entries = resolveEntries(news.entries);

                // Observe — diff against the prior persisted entries so
                // we only `Put` keys whose values actually changed. When
                // the store identity changes (or there's no prior
                // output), treat every key as new.
                const priorEntries =
                  output && output.store === news.store
                    ? resolveEntries(output.entries)
                    : undefined;

                // Sync entries — push the changed keys.
                yield* upload(
                  news.store,
                  news.namespace,
                  entries,
                  priorEntries,
                );

                // Sync stale keys — when `purge` is set, list every key
                // under the namespace and delete anything not in the
                // desired set. This converges adopted/drifted state.
                if (news.purge) {
                  yield* purge(news.store, news.namespace, entries);
                }

                return {
                  store: news.store,
                  namespace: news.namespace,
                  entries,
                };
              }),
            );
          }),
        ),
        delete: withKvsRegionFn(
          Effect.fn(function* ({ output }) {
            if (!output.store) return;
            yield* retryForKvsReadiness(
              purge(output.store, output.namespace, undefined),
            ).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
          }),
        ),
      };
    }),
  );

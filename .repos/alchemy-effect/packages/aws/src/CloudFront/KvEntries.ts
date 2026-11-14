import * as kvs from "@distilled.cloud/aws/cloudfront-keyvaluestore";
import type { Input } from "alchemy/Input";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import type { Providers } from "../Providers.ts";
import {
  extractValue,
  getKvsEtag,
  isKvsPreconditionFailed,
  cappedKvsRetrySchedule,
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
  /**
   * Whether to delete keys under this namespace that are not in `entries`.
   * With `purge`, deleting this resource clears the whole namespace; without
   * it, only the keys in `entries` are removed.
   * @default false
   */
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
 * ### Managing Entries
 * **Example:** Basic Entries
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
 * **Example:** Purge Stale Keys
 * ```typescript
 * const entries = yield* KvEntries("Routes", {
 *   store: store.keyValueStoreArn,
 *   namespace: "routes",
 *   entries: { "/": "/index.html" },
 *   purge: true,
 * });
 * ```
 *
 * @resource
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
        let currentEtag: string | undefined = etag;

        while (remainingPuts.length > 0 || remainingDeletes.length > 0) {
          const batchPuts = remainingPuts.slice(0, BATCH_SIZE);
          const batchDeletes = remainingDeletes.slice(0, BATCH_SIZE - batchPuts.length);

          // A precondition failure means a concurrent writer (another
          // KvEntries / KvRoutesUpdate on the same store) advanced the
          // etag between our read and this batch — the retry MUST re-read
          // the etag or it can never succeed. `stale` drops the cached
          // etag on the failed attempt so the retried generator fetches a
          // fresh one.
          let stale = currentEtag;
          const resp = yield* Effect.gen(function* () {
            const attemptEtag = stale ?? (yield* getKvsEtag(store));
            stale = undefined;
            return yield* sendBatch(store, attemptEtag, batchPuts, batchDeletes);
          }).pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "ValidationException" && isKvsPreconditionFailed(error),
              schedule: cappedKvsRetrySchedule,
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

      const remove = Effect.fn(function* (
        store: string,
        namespace: string,
        entries: ResolvedEntries,
      ) {
        const allKeys = yield* collectAllKeys(store);
        const prefix = `${namespace}:`;
        const deletes: kvs.DeleteKeyRequestListItem[] = [];
        for (const item of allKeys) {
          if (!item.Key.startsWith(prefix)) continue;
          if (!(item.Key.slice(prefix.length) in entries)) continue;
          deletes.push({ Key: item.Key });
        }
        if (deletes.length > 0) {
          yield* batchUpdateKeys(store, undefined, [], deletes);
        }
      });

      /**
       * The live values of a namespace's keys: every key under it with
       * `purge` (the namespace is owned), otherwise only `managed` keys.
       */
      const observeEntries = Effect.fn(function* (
        store: string,
        namespace: string,
        managed: Record<string, unknown>,
        owned: boolean,
      ) {
        const prefix = `${namespace}:`;
        const entries: Record<string, string> = {};
        for (const item of yield* collectAllKeys(store)) {
          if (!item.Key.startsWith(prefix)) continue;
          const key = item.Key.slice(prefix.length);
          if (owned || key in managed) entries[key] = item.Value;
        }
        return entries;
      });

      return {
        // Non-listable: a KvEntries resource is a logical group of key/value
        // data keyed entirely by its parent store ARN + namespace (both chosen
        // by the user). There is no account-wide API to enumerate these groups,
        // and the entries are managed content rather than nuke-able infra.
        list: () => Effect.succeed([]),
        read: withKvsRegionFn(
          Effect.fn(function* ({ olds, output }) {
            if (output === undefined) return undefined;
            // The entries are the managed state: report their live values
            // so drift sees edits, deletions and (with purge) extra keys.
            const entries = yield* retryForKvsReadiness(
              observeEntries(output.store, output.namespace, output.entries, olds?.purge ?? false),
            ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
            if (entries === undefined) return undefined;
            return { ...output, entries };
          }),
        ),
        reconcile: withKvsRegionFn(
          Effect.fn(function* ({ news }) {
            return yield* retryForKvsReadiness(
              Effect.gen(function* () {
                const entries = resolveEntries(news.entries);

                // Observe — diff against the live entries so we only `Put`
                // keys whose values actually differ.
                const priorEntries = yield* observeEntries(
                  news.store,
                  news.namespace,
                  entries,
                  false,
                );

                // Sync entries — push the changed keys.
                yield* upload(news.store, news.namespace, entries, priorEntries);

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
          Effect.fn(function* ({ olds, output }) {
            if (!output.store) return;
            // Without `purge` the namespace may hold keys this resource
            // doesn't own (e.g. a Router's `routes` table), so only remove
            // the entries it wrote.
            yield* retryForKvsReadiness(
              olds.purge
                ? purge(output.store, output.namespace, undefined)
                : remove(output.store, output.namespace, resolveEntries(output.entries)),
            ).pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
          }),
        ),
      };
    }),
  );

import * as kv from "@distilled.cloud/cloudflare/kv";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

export const isNamespace = (value: unknown): value is Namespace =>
  isResourceOfType(value, "Cloudflare.KV.Namespace");

export type NamespaceProps = {
  /**
   * A human-readable string name for the namespace.
   * If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  title?: string;
};

export type Namespace = Resource<
  "Cloudflare.KV.Namespace",
  NamespaceProps,
  {
    title: string;
    namespaceId: string;
    supportsUrlEncoding: boolean | undefined;
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Workers KV namespace for key-value storage at the edge.
 *
 * KV provides eventually-consistent, low-latency reads with global
 * replication. Create a namespace as a resource, then bind it to a Worker
 * to get/put values at runtime.
 * @resource
 * @product KV
 * @category Storage & Databases
 * @section Creating a Namespace
 * @example Basic KV namespace
 * ```typescript
 * const kv = yield* Cloudflare.KV.Namespace("MyKV");
 * ```
 *
 * @section Binding to a Worker
 * @example Using KV inside a Worker
 * ```typescript
 * const kv = yield* Cloudflare.KV.ReadWriteNamespace(MyKV);
 *
 * // Read a value
 * const value = yield* kv.get("my-key");
 *
 * // Write a value
 * yield* kv.put("my-key", "hello world");
 * ```
 *
 * Provide `Cloudflare.KV.ReadWriteNamespaceBinding` (native Worker
 * binding) or `Cloudflare.KV.ReadWriteNamespaceHttp` (scoped HTTP
 * token) in the worker's runtime layer. Use `Cloudflare.KV.ReadNamespace`
 * / `Cloudflare.KV.WriteNamespace` for least-privilege read- or
 * write-only access.
 */
export const Namespace = Resource<Namespace>("Cloudflare.KV.Namespace", {
  aliases: ["Cloudflare.KVNamespace"],
});

export const NamespaceProvider = () =>
  Provider.succeed(Namespace, {
    stables: ["namespaceId", "accountId"],
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      const oldTitle = output?.title ?? (yield* createTitle(id, olds.title));
      // Auto-generated titles are engine-owned: the deployed title stays
      // authoritative even if the generator would title this id differently
      // today. Only an explicit user-provided title can force a rename.
      const title = news.title ?? oldTitle;
      if (title !== oldTitle) {
        return { action: "update" } as const;
      }
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const title = yield* createTitle(id, news.title);
      const acct = output?.accountId ?? accountId;

      // Observe — re-fetch the cached namespace; fall back to a title
      // scan so we recover from out-of-band deletes or partial state
      // persistence failures.
      let observed:
        | {
            id: string;
            title: string;
            supportsUrlEncoding?: boolean | null | undefined;
          }
        | undefined;
      if (output?.namespaceId) {
        observed = yield* kv
          .getNamespace({
            accountId: acct,
            namespaceId: output.namespaceId,
          })
          .pipe(
            Effect.catchTag("NamespaceNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      }

      // Ensure — create if missing. Cloudflare returns
      // `NamespaceTitleAlreadyExists` on a concurrent create; tolerate
      // by adopting the namespace with the same title.
      if (!observed) {
        observed = yield* kv
          .createNamespace({
            accountId: acct,
            title,
          })
          .pipe(
            Effect.catchTag("NamespaceTitleAlreadyExists", () =>
              Effect.gen(function* () {
                const match = yield* findNamespaceByTitle(title);
                if (match) {
                  return match;
                }
                return yield* Effect.die(
                  `Namespace with title "${title}" already exists but could not be found`,
                );
              }),
            ),
          );
      }

      // Sync — KV's only mutable property is the title. Rename only
      // when the observed title drifts from desired so we avoid
      // unnecessary API calls on every reconcile.
      let namespaceId = observed.id;
      let resolvedTitle = observed.title;
      let supportsUrlEncoding = observed.supportsUrlEncoding ?? undefined;
      if (observed.title !== title) {
        const renamed = yield* kv.updateNamespace({
          accountId: acct,
          namespaceId: observed.id,
          title,
        });
        namespaceId = renamed.id;
        resolvedTitle = renamed.title;
        supportsUrlEncoding = renamed.supportsUrlEncoding ?? undefined;
      }

      return {
        title: resolvedTitle,
        namespaceId,
        supportsUrlEncoding,
        accountId: acct,
      };
    }),
    delete: Effect.fn(function* ({ output }) {
      yield* kv
        .deleteNamespace({
          accountId: output.accountId,
          namespaceId: output.namespaceId,
        })
        .pipe(Effect.catchTag("NamespaceNotFound", () => Effect.void));
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* kv.listNamespaces.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((ns) => ({
              title: ns.title,
              namespaceId: ns.id,
              supportsUrlEncoding: ns.supportsUrlEncoding ?? undefined,
              accountId,
            })),
          ),
        ),
      );
    }),
    read: Effect.fn(function* ({ id, olds, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output?.namespaceId) {
        return yield* kv
          .getNamespace({
            accountId: output.accountId,
            namespaceId: output.namespaceId,
          })
          .pipe(
            Effect.map((namespace) => ({
              title: namespace.title,
              namespaceId: namespace.id,
              supportsUrlEncoding: namespace.supportsUrlEncoding ?? undefined,
              accountId: output.accountId,
            })),
            Effect.catchTag("NamespaceNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
      }
      const title = yield* createTitle(id, olds?.title);
      const match = yield* findNamespaceByTitle(title);
      if (match) {
        return {
          title: match.title,
          namespaceId: match.id,
          supportsUrlEncoding: match.supportsUrlEncoding ?? undefined,
          accountId,
        };
      }
      return undefined;
    }),
  });

const createTitle = (id: string, title: string | undefined) =>
  Effect.gen(function* () {
    return title ?? (yield* createPhysicalName({ id }));
  });

// Cloudflare's `listNamespaces` accepts no title/prefix filter, so
// adoption-by-name has to scan every page. Use the paginated
// `.items` stream off the un-yielded operation method (yielding
// `kv.listNamespaces` collapses it to a single-page call).
const findNamespaceByTitle = Effect.fn(function* (title: string) {
  const { accountId } = yield* yield* CloudflareEnvironment;
  return yield* kv.listNamespaces.items({ accountId }).pipe(
    Stream.filter((ns) => ns.title === title),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );
});

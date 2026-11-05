import * as kv from "@distilled.cloud/cloudflare/kv";
import { isResolved } from "alchemy/Diff";
import * as ProviderLayer from "alchemy/Local/ProviderLayer";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { isResourceOfType, Resource } from "alchemy/Resource";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import { localAccountId } from "../LocalAccount.ts";
import type { Providers } from "../Providers.ts";
import {
  createInstantNamespaceLocalId,
  isInstantNamespaceLocalId,
} from "./InstantNamespaceLocal.ts";
import { NamespaceModeMismatch } from "./NamespaceTypes.ts";

export const isInstantNamespace = (value: unknown): value is InstantNamespace =>
  isResourceOfType(value, "Cloudflare.KV.InstantNamespace");

export type InstantNamespaceProps = {
  /**
   * A human-readable string name for the namespace.
   * If omitted, a unique name will be generated.
   * @default ${app}-${stage}-${id}
   */
  title?: string;
};

export type InstantNamespace = Resource<
  "Cloudflare.KV.InstantNamespace",
  InstantNamespaceProps,
  {
    /** Namespace storage mode, fixed at creation. */
    mode: "instant";
    /** Human-readable namespace title. */
    title: string;
    /** Cloudflare namespace identifier, stable across title updates. */
    namespaceId: string;
    /** Whether keys written in URLs are URL-decoded before storage. */
    supportsUrlEncoding: boolean | undefined;
    /** Account that owns the namespace. */
    accountId: string;
  },
  never,
  Providers
>;

/**
 * A Cloudflare Workers KV Instant namespace, powered by Quicksilver.
 *
 * Requires private beta access. Uses the same Worker binding as classic KV,
 * with fast global replication and no cold reads. Namespace mode is fixed at
 * creation; switching between Namespace and InstantNamespace replaces it.
 *
 * Metadata is unsupported. Use get instead of getWithMetadata, and do not
 * pass metadata to put. Listing returns all matching keys without pagination.
 * The beta limits namespaces to 1 MB and 10,000 pairs, keys to 300 bytes,
 * and writes to one per namespace per second.
 *
 * Storage and put/delete/list operations cost substantially more than classic
 * KV; reads cost less. See https://blog.cloudflare.com/workers-kv-instant/
 * for pricing and private beta availability.
 *
 * ### Creating an Instant Namespace
 * **Example:** Application configuration
 * ```typescript
 * const config = yield* Cloudflare.KV.InstantNamespace("Config");
 * ```
 *
 * ### Binding to a Worker
 * **Example:** Read configuration using the existing KV binding
 * ```typescript
 * const client = yield* Cloudflare.KV.ReadNamespace(config);
 * const enabled = yield* client.get("feature-enabled");
 * ```
 *
 * Provide ReadNamespaceBinding on the Worker runtime. WriteNamespace and
 * ReadWriteNamespace also accept Instant namespaces, as do their Http and
 * Local capability implementations.
 *
 * During `alchemy dev`, the namespace uses persistent local KV storage without
 * cloud credentials or beta access. Local mode rejects metadata and lists all
 * matching keys in one response. Local keys are limited to 300 UTF-8 bytes.
 * Namespace storage quotas, key-count limits, global replication, billing,
 * and write throttling are not emulated. Use Alchemy.remote()
 * to opt into a live namespace during development (requires beta access).
 *
 * @resource
 * @product KV
 * @category Storage & Databases
 */
export const InstantNamespace = Resource<InstantNamespace>("Cloudflare.KV.InstantNamespace");

const ProviderLive = () =>
  Provider.succeed(InstantNamespace, {
    stables: ["namespaceId", "accountId"],
    diff: Effect.fn(function* ({ id, olds = {}, news = {}, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (output && output.mode !== "instant") {
        return {
          action: "replace",
          // Titles are unique across modes; an unresolved title may also reuse it.
          deleteFirst: !isResolved(news) || news.title === output.title,
        } as const;
      }
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
      const title = news.title ?? output?.title ?? (yield* createTitle(id, undefined));
      const acct = output?.accountId ?? accountId;

      // Observe — re-fetch the cached namespace; fall back to a title
      // scan so we recover from out-of-band deletes or partial state
      // persistence failures.
      let observed:
        | {
            id: string;
            title: string;
            supportsUrlEncoding?: boolean | null | undefined;
            mode?: "instant" | null;
          }
        | undefined;
      if (output?.namespaceId) {
        observed = yield* kv
          .getNamespace({
            accountId: acct,
            namespaceId: output.namespaceId,
          })
          .pipe(Effect.catchTag("NamespaceNotFound", () => Effect.undefined));
      }

      // Ensure — create if missing. Cloudflare returns
      // `NamespaceTitleAlreadyExists` on a concurrent create; tolerate
      // by adopting the namespace with the same title.
      if (!observed) {
        observed = yield* kv
          .createNamespace({
            accountId: acct,
            title,
            mode: "instant",
          })
          .pipe(
            Effect.catchTag("NamespaceTitleAlreadyExists", (error) =>
              Effect.gen(function* () {
                const match = yield* findNamespaceByTitle(title);
                if (match) {
                  return match;
                }
                return yield* error;
              }),
            ),
          );
      }

      if (observed.mode !== "instant") {
        return yield* new NamespaceModeMismatch({ namespaceId: observed.id, expected: "instant" });
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
        mode: "instant" as const,
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
            (page.result ?? [])
              .filter((ns) => ns.mode === "instant")
              .map((ns) => ({
                mode: "instant" as const,
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
            Effect.flatMap((namespace) =>
              namespace.mode !== "instant"
                ? Effect.fail(
                    new NamespaceModeMismatch({ namespaceId: namespace.id, expected: "instant" }),
                  )
                : Effect.succeed({
                    mode: "instant" as const,
                    title: namespace.title,
                    namespaceId: namespace.id,
                    supportsUrlEncoding: namespace.supportsUrlEncoding ?? undefined,
                    accountId: output.accountId,
                  }),
            ),
            Effect.catchTag("NamespaceNotFound", () => Effect.undefined),
          );
      }
      const title = yield* createTitle(id, olds?.title);
      const match = yield* findNamespaceByTitle(title);
      if (match) {
        return {
          mode: "instant" as const,
          title: match.title,
          namespaceId: match.id,
          supportsUrlEncoding: match.supportsUrlEncoding ?? undefined,
          accountId,
        };
      }
      return undefined;
    }),
  });

/** Persistent local workerd namespace; no Cloudflare API calls. */
const ProviderLocal = () =>
  Provider.succeed(InstantNamespace, {
    stables: ["namespaceId", "accountId"],
    diff: Effect.fn(function* ({ output }) {
      const accountId = yield* localAccountId;
      if (output && !isInstantNamespaceLocalId(output.namespaceId)) {
        return { action: "replace" } as const;
      }
      if (output && output.accountId !== accountId) return { action: "replace" } as const;
    }),
    read: Effect.fn(function* ({ output }) {
      return output ?? undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news = {}, output }) {
      const accountId = yield* localAccountId;
      return {
        mode: "instant" as const,
        title: news.title ?? output?.title ?? (yield* createTitle(id, undefined)),
        namespaceId: output?.namespaceId ?? createInstantNamespaceLocalId(),
        supportsUrlEncoding: true,
        accountId: output?.accountId ?? accountId,
      };
    }),
    delete: Effect.fn(function* () {
      // Matches classic local KV: orphaned storage is reclaimed with .alchemy.
    }),
  });

export const InstantNamespaceProvider = () =>
  ProviderLayer.dual(InstantNamespace, {
    local: () => ProviderLocal(),
    live: () => ProviderLive(),
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
    Stream.filter((ns) => ns.title === title && ns.mode === "instant"),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
  );
});

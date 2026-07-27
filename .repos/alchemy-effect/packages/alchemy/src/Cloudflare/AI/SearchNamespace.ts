import * as aisearch from "@distilled.cloud/cloudflare/aisearch";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.AI.SearchNamespace" as const;
type TypeId = typeof TypeId;

export type SearchNamespaceProps = {
  /**
   * Namespace name. Lowercase letters, digits, and hyphens; must start and
   * end with an alphanumeric character; 1-28 characters. The name is the
   * namespace's identity (it appears in the API path) and cannot be
   * renamed — changing it triggers a replacement. If omitted, a unique
   * name is generated from the app, stage, and logical ID.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
  /**
   * Optional human-readable description for the namespace.
   * Max 256 characters.
   */
  description?: string;
};

export type SearchNamespaceAttributes = {
  /**
   * Namespace name (its identity within the account).
   */
  name: string;
  /**
   * The Cloudflare account the namespace belongs to.
   */
  accountId: string;
  /**
   * Human-readable description, when set.
   */
  description: string | undefined;
  /**
   * When the namespace was created.
   */
  createdAt: string | undefined;
};

export type SearchNamespace = Resource<
  TypeId,
  SearchNamespaceProps,
  SearchNamespaceAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare.AI. Search namespace — a logical grouping for AI Search
 * instances within an account.
 *
 * Namespaces partition AI Search (formerly AutoRAG) instances: each
 * namespace owns its own set of namespace-scoped instances and can be
 * searched or queried as a unit. The namespace `name` is its identity —
 * changing it triggers a replacement; only the `description` is mutable
 * in place.
 *
 * The account-provided `default` namespace is reserved: it always exists
 * and Cloudflare disallows modifying or deleting it. Alchemy adopts it so
 * it can be referenced and bound, but never updates or tears it down.
 *
 * @resource
 * @product AI Search
 * @category AI
 * @section Creating a Namespace
 * @example Generated name
 * ```typescript
 * const ns = yield* Cloudflare.AI.SearchNamespace("docs", {});
 * ```
 *
 * @example Explicit name and description
 * ```typescript
 * const ns = yield* Cloudflare.AI.SearchNamespace("docs", {
 *   name: "docs-search",
 *   description: "Search over the product documentation",
 * });
 * ```
 *
 * @section Updating a Namespace
 * @example Change the description in place
 * Only the `description` is mutable; changing `name` replaces the namespace.
 * ```typescript
 * const ns = yield* Cloudflare.AI.SearchNamespace("docs", {
 *   name: "docs-search",
 *   description: "Search over docs and changelogs",
 * });
 * ```
 *
 * @section Grouping pipelines
 * Group {@link Search} pipelines under the namespace by passing the
 * namespace resource itself to each pipeline's `namespace` prop. The engine
 * orders each pipeline after the namespace on deploy and tears them down
 * before it on destroy.
 * @example Two pipelines in one namespace
 * ```typescript
 * const ns = yield* Cloudflare.AI.SearchNamespace("docs", {});
 * const guides = yield* Cloudflare.AI.Search("guides", {
 *   source: guidesBucket,
 *   namespace: ns,
 * });
 * const api = yield* Cloudflare.AI.Search("api", {
 *   source: apiBucket,
 *   namespace: ns,
 * });
 * ```
 *
 * @section Binding to an Effect Worker
 * Bind the namespace with `Cloudflare.AI.QuerySearchNamespace(namespace)`,
 * which attaches the `ai_search_namespace` binding and returns a client
 * whose `.get(name)` selects an instance within the namespace at runtime.
 * Provide {@link QuerySearchNamespaceBinding} in the Worker's runtime
 * layer.
 * @example Select an instance per request
 * ```typescript
 * import * as Cloudflare from "alchemy/Cloudflare";
 * import * as Effect from "effect/Effect";
 * import { HttpServerRequest } from "effect/unstable/http/HttpServerRequest";
 * import * as HttpServerResponse from "effect/unstable/http/HttpServerResponse";
 *
 * export default class Api extends Cloudflare.Worker<Api>()(
 *   "api",
 *   { main: import.meta.url },
 *   Effect.gen(function* () {
 *     const ns = yield* Cloudflare.AI.QuerySearchNamespace(Docs);
 *
 *     return {
 *       fetch: Effect.gen(function* () {
 *         const url = new URL((yield* HttpServerRequest).url);
 *         const instance = url.searchParams.get("instance") ?? "guides";
 *         const query = url.searchParams.get("q") ?? "";
 *         const answer = yield* ns.get(instance).chatCompletions({
 *           messages: [{ role: "user", content: query }],
 *         });
 *         return yield* HttpServerResponse.json(answer);
 *       }),
 *     };
 *   }).pipe(Effect.provide(Cloudflare.AI.QuerySearchNamespaceBinding)),
 * ) {}
 * ```
 *
 * @section Binding to an Async Worker
 * For a vanilla `async fetch` Worker, pass the namespace under `Worker.env`.
 * `InferEnv` types `env.SEARCH` as the runtime `SearchNamespace` handle.
 * @example Async Worker via `env`
 * ```typescript
 * export const Api = Cloudflare.Worker("api", {
 *   main: "./worker.ts",
 *   env: { SEARCH: namespace },
 * });
 * export type ApiEnv = Cloudflare.InferEnv<typeof Api>;
 *
 * // worker.ts
 * export default {
 *   async fetch(request: Request, env: ApiEnv): Promise<Response> {
 *     const query = new URL(request.url).searchParams.get("q") ?? "";
 *     return Response.json(
 *       await env.SEARCH.get("guides").chatCompletions({
 *         messages: [{ role: "user", content: query }],
 *       }),
 *     );
 *   },
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/ai-search/
 */
export const SearchNamespace = Resource<SearchNamespace>(TypeId, {
  aliases: ["Cloudflare.AiSearch.Namespace"],
});

/**
 * Returns true if the given value is a SearchNamespace resource.
 */
export const isSearchNamespace = (value: unknown): value is SearchNamespace =>
  isResourceOfType(value, TypeId);

export const SearchNamespaceProvider = () =>
  Provider.succeed(SearchNamespace, {
    stables: ["name", "accountId", "createdAt"],
    diff: Effect.fn(function* ({ id, olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The name is the namespace's identity (it is the API path
      // parameter) — renaming is a replacement. Props are all optional, so a
      // no-props resource resolves `news`/`olds` to `undefined` at runtime.
      const oldName =
        output?.name ?? (yield* createNamespaceName(id, olds?.name));
      // Auto-generated names are engine-owned: the deployed name stays
      // authoritative even if the generator would name this id differently
      // today. Only an explicit user-provided name can force a replace.
      const newName = news?.name ?? oldName;
      if (newName !== oldName) {
        // A user-pinned name collides with the still-existing old
        // namespace only when both resolve to the same string — they
        // don't here, so create-before-delete is safe.
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // The name is deterministic (explicit prop or generated from the
      // logical id), so a cold read (lost state) resolves the same
      // identifier as the original create did.
      const name = output?.name ?? (yield* createNamespaceName(id, olds?.name));
      const observed = yield* getNamespace(acct, name);
      return observed ? toAttributes(observed, acct) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // Props are all optional, so a no-props resource resolves `news` to
      // `undefined` at runtime — fall back to the empty desired shape.
      const props = news ?? {};
      const name = output?.name ?? (yield* createNamespaceName(id, props.name));

      // Observe — `output.name` is a cache, not a guarantee: a missing
      // namespace falls through to create.
      let observed = yield* getNamespace(acct, name);

      if (!observed) {
        // Ensure — greenfield (or out-of-band delete). A concurrent
        // create surfaces as `NamespaceAlreadyExists` — treat it as a
        // race and fall through to the sync path against the observed
        // namespace.
        const ensured = yield* aisearch
          .createNamespace({
            accountId: acct,
            name,
            description: props.description,
          })
          .pipe(
            Effect.map((created) => ({ created: true as const, ns: created })),
            Effect.catchTag("NamespaceAlreadyExists", (originalError) =>
              Effect.gen(function* () {
                const existing = yield* getNamespace(acct, name);
                if (!existing) return yield* Effect.fail(originalError);
                return { created: false as const, ns: existing };
              }),
            ),
          );
        if (ensured.created) {
          return toAttributes(ensured.ns, acct);
        }
        observed = ensured.ns;
      }

      // The account-provided `default` namespace is reserved: it always
      // exists and its metadata cannot be modified
      // (`cannot_modify_default_namespace`). Adopt it as-is so it can be
      // referenced/bound, but never attempt to mutate it.
      if (name === "default") {
        return toAttributes(observed, acct);
      }

      // Sync — the description is the only mutable aspect. Diff observed
      // cloud state against desired; skip the PUT entirely on a no-op.
      const observedDescription = normalize(observed.description);
      if (observedDescription === props.description) {
        return toAttributes(observed, acct);
      }
      const updated = yield* aisearch
        .updateNamespace({
          accountId: acct,
          name,
          // `null` clears a previously-set description.
          description: props.description ?? null,
        })
        .pipe(
          // The observe read can be eventually consistent: a namespace
          // deleted out-of-band may still appear in `readNamespace` and
          // then 404 here. Treat that as "missing" and recreate with the
          // desired shape.
          Effect.catchTag("NamespaceNotFound", () =>
            aisearch.createNamespace({
              accountId: acct,
              name,
              description: props.description,
            }),
          ),
        );
      return toAttributes(updated, acct);
    }),
    delete: Effect.fn(function* ({ output }) {
      // The account-provided `default` namespace cannot be deleted
      // (`cannot_modify_default_namespace`); binding/adopting it must never
      // tear it down, so its delete is a no-op.
      if (output.name === "default") return;
      // A missing namespace (already deleted) is success. Instances inside
      // the namespace must be deleted first — the engine orders that via
      // the `namespace` reference on dependent resources.
      yield* aisearch
        .deleteNamespace({ accountId: output.accountId, name: output.name })
        .pipe(Effect.catchTag("NamespaceNotFound", () => Effect.void));
    }),
    // Account-scoped collection: namespaces are enumerated directly under
    // the account (no parent fan-out). Exhaustively paginate `listNamespaces`
    // and hydrate each item into the exact `read` Attributes shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* aisearch.listNamespaces.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? [])
              // The account-provided `default` namespace can't be deleted
              // (`cannot_modify_default_namespace`); never enumerate it for
              // account-wide teardown.
              .filter((ns) => ns.name !== "default")
              .map((ns) => toAttributes(ns, accountId)),
          ),
        ),
      );
    }),
  });

type ObservedNamespace = aisearch.ReadNamespaceResponse;

/**
 * Read a namespace by name, mapping "gone" (`NamespaceNotFound`,
 * Cloudflare error code 7063) to `undefined`.
 */
const getNamespace = (accountId: string, name: string) =>
  aisearch
    .readNamespace({ accountId, name })
    .pipe(
      Effect.catchTag("NamespaceNotFound", () => Effect.succeed(undefined)),
    );

const createNamespaceName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    // Cloudflare restricts namespace names to lowercase alphanumerics and
    // hyphens, 1-28 characters.
    return (
      name ??
      (yield* createPhysicalName({ id, lowercase: true, maxLength: 28 }))
    );
  });

/**
 * Cloudflare returns `null` for an unset description; desired-state
 * shapes leave it `undefined`. Collapse both to `undefined` for diffing.
 */
const normalize = <T>(value: T | null | undefined): T | undefined =>
  value ?? undefined;

const toAttributes = (
  ns:
    | ObservedNamespace
    | aisearch.CreateNamespaceResponse
    | aisearch.UpdateNamespaceResponse,
  accountId: string,
): SearchNamespaceAttributes => ({
  name: ns.name,
  accountId,
  description: normalize(ns.description),
  createdAt: ns.createdAt,
});

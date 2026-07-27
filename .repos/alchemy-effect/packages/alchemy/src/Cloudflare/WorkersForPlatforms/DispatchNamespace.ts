import * as wfp from "@distilled.cloud/cloudflare/workers-for-platforms";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { isResourceOfType, Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Workers.DispatchNamespace" as const;
type TypeId = typeof TypeId;

export interface DispatchNamespaceProps {
  /**
   * Name of the dispatch namespace. Must be lowercase, alphanumeric, and
   * contain no spaces or special characters except dashes. The name is the
   * namespace's identity — there is no rename API, so changing it triggers
   * a replacement. If omitted, a unique name is generated from the app,
   * stage, and logical ID.
   * @default ${app}-${id}-${stage}-${suffix}
   */
  name?: string;
}

export interface DispatchNamespaceAttributes {
  /**
   * API Resource UUID tag assigned by Cloudflare.
   */
  namespaceId: string;
  /**
   * Name of the dispatch namespace.
   */
  name: string;
  /**
   * The Cloudflare account the namespace belongs to.
   */
  accountId: string;
  /**
   * The current number of scripts in this dispatch namespace.
   */
  scriptCount: number;
  /**
   * Whether the Workers in the namespace are executed in a "trusted"
   * manner (access to shared zone caches and `request.cf`).
   */
  trustedWorkers: boolean;
  /**
   * When the namespace was created.
   */
  createdOn: string | undefined;
  /**
   * When the namespace was last modified.
   */
  modifiedOn: string | undefined;
}

export type DispatchNamespace = Resource<
  TypeId,
  DispatchNamespaceProps,
  DispatchNamespaceAttributes,
  never,
  Providers
>;

/**
 * A Workers for Platforms dispatch namespace — a container for customer
 * ("user") Workers that a platform Worker dispatches to at runtime via a
 * dynamic-dispatch binding.
 *
 * The namespace has no mutable properties: its `name` is its identity, so
 * changing the name triggers a replacement. Deleting a namespace also
 * deletes every script uploaded into it.
 *
 * Note: Workers for Platforms is a paid add-on. On accounts without the
 * subscription, namespace creation fails with an entitlement error.
 * @resource
 * @product Workers for Platforms
 * @category Workers & Compute
 * @section Creating a Dispatch Namespace
 * @example Namespace with a generated name
 * ```typescript
 * const namespace = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace("Customers", {});
 * ```
 *
 * @example Namespace with an explicit name
 * ```typescript
 * const namespace = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace("Customers", {
 *   name: "my-platform-customers",
 * });
 * ```
 *
 * @section Uploading user Workers
 * @example Upload a customer Worker into the namespace
 * A {@link Cloudflare.Worker} deploys into the namespace as a "user worker"
 * (rather than as a routable account-level script) when its `namespace` prop is
 * set. Reference the namespace by its `name` output so it deploys first.
 * ```typescript
 * const namespace = yield* Cloudflare.WorkersForPlatforms.DispatchNamespace("Customers", {});
 *
 * const customerA = yield* Cloudflare.Worker("CustomerA", {
 *   namespace: namespace.name,
 *   script: `export default { fetch() { return new Response("hi"); } }`,
 * });
 * ```
 *
 * @section Dispatching from a platform Worker
 * @example Effect-native binding via `Get`
 * `Cloudflare.WorkersForPlatforms.Get(namespace)` binds the namespace and
 * returns an Effect-native client; `get(name)` resolves a user Worker by script
 * name. Provide {@link GetBinding} on the Worker's runtime layer.
 * ```typescript
 * const dispatch = yield* Cloudflare.WorkersForPlatforms.Get(namespace);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     const request = yield* HttpServerRequest;
 *     const userWorker = yield* dispatch.get("CustomerA");
 *     return yield* Effect.promise(() => userWorker.fetch(request));
 *   }),
 * };
 * ```
 *
 * @example Async binding via `env` + `InferEnv`
 * Passing the namespace on a Worker's `env` binds it as a native
 * `dispatch_namespace` binding; `Cloudflare.InferEnv` types `env.DISPATCH` as
 * the runtime `DispatchNamespace`, so the async handler calls `.get(name)`
 * directly.
 * ```typescript
 * const platform = Cloudflare.Worker("Platform", {
 *   main: "./handler.ts",
 *   env: { DISPATCH: namespace },
 * });
 * type Env = Cloudflare.InferEnv<typeof platform>;
 *
 * // handler.ts
 * export default {
 *   async fetch(request: Request, env: Env) {
 *     return env.DISPATCH.get("CustomerA").fetch(request);
 *   },
 * };
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
 */
export const DispatchNamespace = Resource<DispatchNamespace>(TypeId);

/**
 * Returns true if the given value is a DispatchNamespace resource.
 */
export const isDispatchNamespace = (
  value: unknown,
): value is DispatchNamespace => isResourceOfType(value, TypeId);

export const DispatchNamespaceProvider = () =>
  Provider.succeed(DispatchNamespace, {
    stables: ["namespaceId", "name", "accountId", "createdOn"],
    diff: Effect.fn(function* ({ olds, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The name is the namespace's identity — no rename API. When `name`
      // is omitted on both sides, the generated physical name is identical
      // (same logical ID + instance ID), so an omitted name never diffs.
      const oldName = output?.name ?? olds?.name;
      const newName = news.name ?? olds?.name ?? oldName;
      if (oldName !== undefined && oldName !== newName) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* wfp.listDispatchNamespaces.pages({ accountId }).pipe(
        Stream.runCollect,
        Effect.map((chunk) =>
          Array.from(chunk).flatMap((page) =>
            (page.result ?? []).map((ns) =>
              toAttributes(ns, accountId, ns.namespaceName ?? ""),
            ),
          ),
        ),
      );
    }),
    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;
      // The name is the identity — a cold read (lost state) lands on the
      // same deterministic name as reconcile would.
      const name =
        output?.name ??
        olds?.name ??
        (yield* createPhysicalName({ id, lowercase: true }));
      const observed = yield* getNamespace(acct, name);
      return observed ? toAttributes(observed, acct, name) : undefined;
    }),
    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name =
        news.name ?? (yield* createPhysicalName({ id, lowercase: true }));

      // Observe — namespaces are looked up by name; `output` is only a
      // cache of the same identity. A missing namespace falls through to
      // the ensure step.
      const observed = yield* getNamespace(
        output?.accountId ?? accountId,
        name,
      );
      if (observed) {
        // Existence-only resource — nothing mutable to sync.
        return toAttributes(observed, output?.accountId ?? accountId, name);
      }

      // Ensure — create, tolerating the already-exists race by re-reading.
      const created = yield* wfp
        .createDispatchNamespace({ accountId, name })
        .pipe(
          Effect.catchTag("DispatchNamespaceAlreadyExists", () =>
            wfp.getDispatchNamespace({ accountId, dispatchNamespace: name }),
          ),
        );
      return toAttributes(created, accountId, name);
    }),
    delete: Effect.fn(function* ({ output }) {
      // Deleting a namespace also deletes the scripts inside it.
      yield* wfp
        .deleteDispatchNamespace({
          accountId: output.accountId,
          dispatchNamespace: output.name,
        })
        .pipe(Effect.catchTag("DispatchNamespaceNotFound", () => Effect.void));
    }),
  });

/**
 * Read a namespace by name, mapping "gone" (`DispatchNamespaceNotFound`,
 * Cloudflare error code 100119) to `undefined`.
 */
const getNamespace = (accountId: string, name: string) =>
  wfp
    .getDispatchNamespace({ accountId, dispatchNamespace: name })
    .pipe(
      Effect.catchTag("DispatchNamespaceNotFound", () =>
        Effect.succeed(undefined),
      ),
    );

const toAttributes = (
  ns: wfp.GetDispatchNamespaceResponse | wfp.CreateDispatchNamespaceResponse,
  accountId: string,
  name: string,
): DispatchNamespaceAttributes => ({
  namespaceId: ns.namespaceId ?? "",
  name: ns.namespaceName ?? name,
  accountId,
  scriptCount: ns.scriptCount ?? 0,
  trustedWorkers: ns.trustedWorkers ?? false,
  createdOn: ns.createdOn ?? undefined,
  modifiedOn: ns.modifiedOn ?? undefined,
});

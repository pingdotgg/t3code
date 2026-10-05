import * as compute from "@distilled.cloud/gcp/compute_v1";
import { waitGlobalOperation } from "./operations.ts";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  alchemyLabelKeys,
  createInternalLabels,
  hasAlchemyLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";

export type TargetGrpcProxyProps = {
  /**
   * TargetGrpcProxy name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the resource.
   */
  targetGrpcProxyName?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute TargetGrpcProxy has
   * no labels field).
   */
  description?: string;
  /**
   * URL map this proxy routes to. Accepts a UrlMap self-link, a
   * `projects/{project}/global/urlMaps/{name}` path, or the UrlMap name.
   * The referenced backend services must use protocol `GRPC`. Changing
   * this replaces the resource.
   */
  urlMap: string;
  /**
   * If true, BackendServices on the URL map may be reached by proxyless
   * gRPC clients using the `xds:///` target URI (Traffic Director
   * configuration checks apply). If false, clients use a sidecar proxy
   * and must not use `xds:///`. Changing this replaces the resource.
   * @default false
   */
  validateForProxyless?: boolean;
};

export type TargetGrpcProxy = Resource<
  "GCP.Compute.TargetGrpcProxy",
  TargetGrpcProxyProps,
  {
    /** TargetGrpcProxy name. */
    targetGrpcProxyName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** URL of the attached UrlMap. */
    urlMap: string;
    /** Whether proxyless gRPC clients are allowed. */
    validateForProxyless: boolean;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-defined URL that includes the numeric id. */
    selfLinkWithId: string | undefined;
    /** Server-assigned numeric id. */
    targetGrpcProxyId: string | undefined;
    /** Optimistic-locking fingerprint. */
    fingerprint: string | undefined;
    /** RFC3339 creation timestamp. */
    creationTimestamp: string | undefined;
    /** Resource kind. */
    kind: string | undefined;
  },
  never,
  Providers
>;

/**
 * A global Compute Engine target gRPC proxy.
 *
 * Target gRPC proxies are referenced by global forwarding rules with
 * load-balancing scheme `INTERNAL_SELF_MANAGED` (Traffic Director) and
 * point at a URL map whose backend services use protocol `GRPC`. This
 * resource maps to the global `targetGrpcProxies` collection. Compute
 * TargetGrpcProxy has no labels field — Alchemy ownership is stored in
 * the description so nuke can find leaked proxies.
 *
 * ### Creating a Target gRPC Proxy
 * **Example:** Generated name in front of a gRPC URL map
 * ```typescript
 * const backend = yield* GCP.Compute.BackendService("grpc", {
 *   protocol: "GRPC",
 *   loadBalancingScheme: "INTERNAL_SELF_MANAGED",
 * });
 * const map = yield* GCP.Compute.UrlMap("grpc", {
 *   defaultService: backend.selfLink,
 * });
 * const proxy = yield* GCP.Compute.TargetGrpcProxy("grpc", {
 *   urlMap: map.urlMapName,
 * });
 * ```
 *
 * **Example:** Explicit name, description, and proxyless validation
 * ```typescript
 * const proxy = yield* GCP.Compute.TargetGrpcProxy("grpc", {
 *   targetGrpcProxyName: "app-grpc",
 *   description: "traffic director frontend",
 *   urlMap: map.selfLink,
 *   validateForProxyless: true,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const TargetGrpcProxy = Resource<TargetGrpcProxy>(
  "GCP.Compute.TargetGrpcProxy",
);

export class TargetGrpcProxyNotResolved extends Data.TaggedError(
  "GCP.Compute.TargetGrpcProxyNotResolved",
)<{
  targetGrpcProxyName: string;
}> {}

const toName = (id: string, name: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    const generated = yield* createPhysicalName({
      id,
      maxLength: 63,
      lowercase: true,
    });
    return /^[a-z]/.test(generated) ? generated : `g${generated}`.slice(0, 63);
  });

const encodeDescription = (
  labels: Record<string, string>,
  description: string | undefined,
): string => {
  const marker = `[alchemy ${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]} ${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]} ${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}]`;
  return description ? `${marker}\n${description}` : marker;
};

const parseDescription = (
  description: string | undefined,
): {
  labels: Record<string, string>;
  description: string | undefined;
} => {
  if (!description?.startsWith("[alchemy ")) {
    return { labels: {}, description };
  }
  const end = description.indexOf("]");
  if (end < 0) return { labels: {}, description };
  const labels: Record<string, string> = {};
  for (const part of description.slice("[alchemy ".length, end).split(/\s+/)) {
    const eq = part.indexOf("=");
    if (eq > 0) {
      labels[part.slice(0, eq)] = part.slice(eq + 1);
    }
  }
  const rest = description.slice(end + 1).replace(/^\n/, "");
  return { labels, description: rest.length > 0 ? rest : undefined };
};

const resourceTail = (value: string | undefined): string => {
  if (value === undefined || value.length === 0) return "";
  const parts = value.split("/").filter((part) => part.length > 0);
  return parts[parts.length - 1] ?? "";
};

const toUrlMapRef = (project: string, urlMap: string): string => {
  if (urlMap.includes("/")) return urlMap;
  return `projects/${project}/global/urlMaps/${urlMap}`;
};

const toAttrs = (proxy: compute.TargetGrpcProxy, project: string) => {
  const parsed = parseDescription(proxy.description);
  return {
    targetGrpcProxyName: proxy.name ?? proxy.id ?? "",
    project,
    description: parsed.description,
    urlMap: proxy.urlMap ?? "",
    validateForProxyless: proxy.validateForProxyless === true,
    selfLink: proxy.selfLink,
    selfLinkWithId: proxy.selfLinkWithId,
    targetGrpcProxyId: proxy.id,
    fingerprint: proxy.fingerprint,
    creationTimestamp: proxy.creationTimestamp,
    kind: proxy.kind,
  };
};

const getByName = (project: string, targetGrpcProxy: string) =>
  compute
    .getTargetGrpcProxies({ project, targetGrpcProxy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const TargetGrpcProxyProvider = () =>
  Provider.succeed(TargetGrpcProxy, {
    stables: [
      "targetGrpcProxyName",
      "project",
      "targetGrpcProxyId",
      "selfLink",
      "selfLinkWithId",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.targetGrpcProxyName ?? output?.targetGrpcProxyName;
      const next = news.targetGrpcProxyName;
      if (previous !== undefined && next !== undefined && previous !== next) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousUrlMap = olds?.urlMap ?? output?.urlMap;
      if (
        previousUrlMap !== undefined &&
        resourceTail(previousUrlMap) !== resourceTail(news.urlMap)
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      const previousProxyless =
        olds?.validateForProxyless ?? output?.validateForProxyless ?? false;
      const nextProxyless = news.validateForProxyless ?? false;
      if (previousProxyless !== nextProxyless) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const targetGrpcProxyName = yield* toName(
        id,
        olds?.targetGrpcProxyName,
        output?.targetGrpcProxyName,
      );
      const existing = yield* getByName(env.project, targetGrpcProxyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listTargetGrpcProxies
          .items({ project: env.project, maxResults: 500 })
          .pipe(
            Stream.filter((proxy) => {
              const { labels } = parseDescription(proxy.description);
              return Object.keys(labels).some((key) =>
                key.startsWith("alchemy-"),
              );
            }),
            Stream.map((proxy) => toAttrs(proxy, env.project)),
            Stream.runCollect,
            Effect.map((chunk) => Array.from(chunk)),
          );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const targetGrpcProxyName = yield* toName(
        id,
        news.targetGrpcProxyName,
        output?.targetGrpcProxyName,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredUrlMap = toUrlMapRef(env.project, news.urlMap);
      const desiredProxyless = news.validateForProxyless === true;

      let current = yield* getByName(env.project, targetGrpcProxyName);

      if (current === undefined) {
        const body: compute.TargetGrpcProxy = {
          name: targetGrpcProxyName,
          description: desiredDescription,
          urlMap: desiredUrlMap,
        };
        if (news.validateForProxyless !== undefined) {
          body.validateForProxyless = news.validateForProxyless;
        }
        yield* compute
          .insertTargetGrpcProxies({
            project: env.project,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* getByName(env.project, targetGrpcProxyName);
      }

      if (current === undefined) {
        return yield* new TargetGrpcProxyNotResolved({ targetGrpcProxyName });
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const urlMapChanged =
        resourceTail(current.urlMap) !== resourceTail(desiredUrlMap);
      const proxylessChanged =
        (current.validateForProxyless === true) !== desiredProxyless;

      if (descriptionChanged || urlMapChanged || proxylessChanged) {
        const body: compute.TargetGrpcProxy = {
          fingerprint: current.fingerprint,
          description: desiredDescription,
        };
        if (urlMapChanged) {
          body.urlMap = desiredUrlMap;
        }
        if (proxylessChanged) {
          body.validateForProxyless = desiredProxyless;
        }
        yield* compute
          .patchTargetGrpcProxies({
            project: env.project,
            targetGrpcProxy: targetGrpcProxyName,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetGrpcProxyName);
        if (current === undefined) {
          return yield* new TargetGrpcProxyNotResolved({
            targetGrpcProxyName,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteTargetGrpcProxies({
          project: env.project,
          targetGrpcProxy: output.targetGrpcProxyName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitGlobalOperation(env.project, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });

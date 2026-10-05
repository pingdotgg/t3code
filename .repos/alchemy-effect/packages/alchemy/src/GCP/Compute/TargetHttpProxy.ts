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

export type TargetHttpProxyProps = {
  /**
   * TargetHttpProxy name (RFC1035, 1-63 characters). If omitted, a unique
   * name is generated from the stack, stage, and logical id. Changing it
   * replaces the resource.
   */
  targetHttpProxyName?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute TargetHttpProxy has
   * no labels field).
   */
  description?: string;
  /**
   * URL map this proxy routes to. Accepts a UrlMap self-link, a
   * `projects/{project}/global/urlMaps/{name}` path, or the UrlMap name.
   */
  urlMap: string;
  /**
   * Bind inbound traffic to the forwarding-rule address. Only applies when
   * the referencing forwarding rule uses `INTERNAL_SELF_MANAGED`.
   * @default false
   */
  proxyBind?: boolean;
  /**
   * Idle keep-alive timeout in seconds after a response completes with no
   * matching traffic. Global external Application Load Balancers allow
   * 5–1200 (default 610). Not supported on classic Application Load
   * Balancers.
   */
  httpKeepAliveTimeoutSec?: number;
};

export type TargetHttpProxy = Resource<
  "GCP.Compute.TargetHttpProxy",
  TargetHttpProxyProps,
  {
    /** TargetHttpProxy name. */
    targetHttpProxyName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** URL of the attached UrlMap. */
    urlMap: string;
    /** Whether Envoy inbound bind is enabled. */
    proxyBind: boolean;
    /** HTTP keep-alive timeout in seconds, if set. */
    httpKeepAliveTimeoutSec: number | undefined;
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    targetHttpProxyId: string | undefined;
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
 * A global Compute Engine target HTTP proxy.
 *
 * Target HTTP proxies are referenced by global forwarding rules and point
 * at a URL map that routes host/path to a backend service, backend bucket,
 * or redirect. This resource maps to the global `targetHttpProxies`
 * collection (`regionTargetHttpProxies` is a separate resource). Compute
 * TargetHttpProxy has no labels field — Alchemy ownership is stored in the
 * description so nuke can find leaked proxies.
 *
 * ### Creating a Target HTTP Proxy
 * **Example:** Generated name in front of a URL map
 * ```typescript
 * const map = yield* GCP.Compute.UrlMap("web", {
 *   defaultUrlRedirect: {
 *     httpsRedirect: true,
 *     hostRedirect: "example.com",
 *     stripQuery: false,
 *   },
 * });
 * const proxy = yield* GCP.Compute.TargetHttpProxy("http", {
 *   urlMap: map.urlMapName,
 * });
 * ```
 *
 * **Example:** Explicit name and description
 * ```typescript
 * const proxy = yield* GCP.Compute.TargetHttpProxy("http", {
 *   targetHttpProxyName: "app-http",
 *   description: "public http frontend",
 *   urlMap: map.selfLink,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const TargetHttpProxy = Resource<TargetHttpProxy>(
  "GCP.Compute.TargetHttpProxy",
);

export class TargetHttpProxyNotResolved extends Data.TaggedError(
  "GCP.Compute.TargetHttpProxyNotResolved",
)<{
  targetHttpProxyName: string;
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
    return /^[a-z]/.test(generated) ? generated : `p${generated}`.slice(0, 63);
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

const toAttrs = (proxy: compute.TargetHttpProxy, project: string) => {
  const parsed = parseDescription(proxy.description);
  return {
    targetHttpProxyName: proxy.name ?? proxy.id ?? "",
    project,
    description: parsed.description,
    urlMap: proxy.urlMap ?? "",
    proxyBind: proxy.proxyBind === true,
    httpKeepAliveTimeoutSec: proxy.httpKeepAliveTimeoutSec,
    selfLink: proxy.selfLink,
    targetHttpProxyId: proxy.id,
    fingerprint: proxy.fingerprint,
    creationTimestamp: proxy.creationTimestamp,
    kind: proxy.kind,
  };
};

const getByName = (project: string, targetHttpProxy: string) =>
  compute
    .getTargetHttpProxies({ project, targetHttpProxy })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const TargetHttpProxyProvider = () =>
  Provider.succeed(TargetHttpProxy, {
    nuke: {
      dependsOn: ["GCP.Compute.UrlMap"],
    },
    stables: [
      "targetHttpProxyName",
      "project",
      "targetHttpProxyId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.targetHttpProxyName ?? output?.targetHttpProxyName;
      const next = news.targetHttpProxyName;
      if (previous !== undefined && next !== undefined && previous !== next) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const targetHttpProxyName = yield* toName(
        id,
        olds?.targetHttpProxyName,
        output?.targetHttpProxyName,
      );
      const existing = yield* getByName(env.project, targetHttpProxyName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listTargetHttpProxies
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
      const targetHttpProxyName = yield* toName(
        id,
        news.targetHttpProxyName,
        output?.targetHttpProxyName,
      );
      const ownership = yield* createInternalLabels(id);
      const desiredDescription = encodeDescription(ownership, news.description);
      const desiredUrlMap = toUrlMapRef(env.project, news.urlMap);

      let current = yield* getByName(env.project, targetHttpProxyName);

      if (current === undefined) {
        const body: compute.TargetHttpProxy = {
          name: targetHttpProxyName,
          description: desiredDescription,
          urlMap: desiredUrlMap,
        };
        if (news.proxyBind !== undefined) {
          body.proxyBind = news.proxyBind;
        }
        if (news.httpKeepAliveTimeoutSec !== undefined) {
          body.httpKeepAliveTimeoutSec = news.httpKeepAliveTimeoutSec;
        }
        yield* compute
          .insertTargetHttpProxies({
            project: env.project,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* getByName(env.project, targetHttpProxyName);
      }

      if (current === undefined) {
        return yield* new TargetHttpProxyNotResolved({ targetHttpProxyName });
      }

      if (resourceTail(current.urlMap) !== resourceTail(desiredUrlMap)) {
        yield* compute
          .setUrlMapTargetHttpProxies({
            project: env.project,
            targetHttpProxy: targetHttpProxyName,
            body: { urlMap: desiredUrlMap },
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetHttpProxyName);
        if (current === undefined) {
          return yield* new TargetHttpProxyNotResolved({
            targetHttpProxyName,
          });
        }
      }

      const descriptionChanged =
        (current.description ?? "") !== desiredDescription;
      const proxyBindChanged =
        news.proxyBind !== undefined &&
        (current.proxyBind === true) !== news.proxyBind;
      const keepAliveChanged =
        news.httpKeepAliveTimeoutSec !== undefined &&
        current.httpKeepAliveTimeoutSec !== news.httpKeepAliveTimeoutSec;

      if (descriptionChanged || proxyBindChanged || keepAliveChanged) {
        const body: compute.TargetHttpProxy = {
          fingerprint: current.fingerprint,
          description: desiredDescription,
        };
        if (news.proxyBind !== undefined) {
          body.proxyBind = news.proxyBind;
        }
        if (news.httpKeepAliveTimeoutSec !== undefined) {
          body.httpKeepAliveTimeoutSec = news.httpKeepAliveTimeoutSec;
        }
        yield* compute
          .patchTargetHttpProxies({
            project: env.project,
            targetHttpProxy: targetHttpProxyName,
            body,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, targetHttpProxyName);
        if (current === undefined) {
          return yield* new TargetHttpProxyNotResolved({
            targetHttpProxyName,
          });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteTargetHttpProxies({
          project: env.project,
          targetHttpProxy: output.targetHttpProxyName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitGlobalOperation(env.project, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });

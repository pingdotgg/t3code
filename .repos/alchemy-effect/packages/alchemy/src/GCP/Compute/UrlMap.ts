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

export type HttpRedirectAction = compute.HttpRedirectAction;
export type HostRule = compute.HostRule;
export type PathMatcher = compute.PathMatcher;
export type PathRule = compute.PathRule;
export type UrlMapTest = compute.UrlMapTest;
export type HttpHeaderAction = compute.HttpHeaderAction;
export type HttpRouteAction = compute.HttpRouteAction;
export type CustomErrorResponsePolicy = compute.CustomErrorResponsePolicy;

export type UrlMapProps = {
  /**
   * UrlMap name (RFC1035, 1-63 characters). If omitted, a unique name is
   * generated from the stack, stage, and logical id. Changing it replaces
   * the resource.
   */
  urlMapName?: string;
  /**
   * Optional description. Alchemy ownership is stored in a `[alchemy …]`
   * prefix so `list` / nuke can find resources (Compute UrlMap has no
   * labels field).
   */
  description?: string;
  /**
   * Default backend service or backend bucket URL used when no host rule
   * matches. Mutually exclusive with `defaultUrlRedirect` and
   * `defaultRouteAction.weightedBackendServices`.
   */
  defaultService?: string;
  /**
   * Redirect used when no host rule matches. Mutually exclusive with
   * `defaultService`.
   */
  defaultUrlRedirect?: HttpRedirectAction;
  /**
   * Advanced routing used when no host rule matches. Mutually exclusive
   * with `defaultService` / `defaultUrlRedirect` when
   * `weightedBackendServices` is set.
   */
  defaultRouteAction?: HttpRouteAction;
  /**
   * Host-matching rules that select a named path matcher.
   */
  hostRules?: HostRule[];
  /**
   * Named path matchers referenced by `hostRules`.
   */
  pathMatchers?: PathMatcher[];
  /**
   * Optional header transformations applied after path-matcher headers.
   */
  headerAction?: HttpHeaderAction;
  /**
   * Custom error responses for unmatched requests. Global external
   * Application Load Balancers only.
   */
  defaultCustomErrorResponsePolicy?: CustomErrorResponsePolicy;
  /**
   * UrlMap tests that must pass before an update is accepted (max 100).
   */
  tests?: UrlMapTest[];
};

export type UrlMap = Resource<
  "GCP.Compute.UrlMap",
  UrlMapProps,
  {
    /** UrlMap name. */
    urlMapName: string;
    /** Project id. */
    project: string;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Default backend service / backend bucket URL. */
    defaultService: string | undefined;
    /** Default redirect, if configured. */
    defaultUrlRedirect: HttpRedirectAction | undefined;
    /** Default route action, if configured. */
    defaultRouteAction: HttpRouteAction | undefined;
    /** Host-matching rules. */
    hostRules: HostRule[];
    /** Named path matchers. */
    pathMatchers: PathMatcher[];
    /** Header transformations, if configured. */
    headerAction: HttpHeaderAction | undefined;
    /** Custom error policy, if configured. */
    defaultCustomErrorResponsePolicy: CustomErrorResponsePolicy | undefined;
    /** UrlMap tests. */
    tests: UrlMapTest[];
    /** Server-defined URL. */
    selfLink: string | undefined;
    /** Server-assigned numeric id. */
    urlMapId: string | undefined;
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
 * A global Compute Engine URL map.
 *
 * URL maps route hostnames and URL paths to a backend service, backend
 * bucket, or HTTP redirect. This resource maps to the global `urlMaps`
 * collection (`regionUrlMaps` is a separate resource). Compute UrlMap has
 * no labels field — Alchemy ownership is stored in the description so nuke
 * can find leaked maps.
 *
 * One of `defaultService`, `defaultUrlRedirect`, or
 * `defaultRouteAction.weightedBackendServices` is required.
 *
 * ### Creating a URL Map
 * **Example:** Generated name with a default HTTPS redirect
 * ```typescript
 * const map = yield* GCP.Compute.UrlMap("web", {
 *   defaultUrlRedirect: {
 *     httpsRedirect: true,
 *     hostRedirect: "example.com",
 *     stripQuery: false,
 *   },
 * });
 * ```
 *
 * **Example:** Host rules and path matchers
 * ```typescript
 * const map = yield* GCP.Compute.UrlMap("web", {
 *   description: "public https",
 *   defaultUrlRedirect: {
 *     httpsRedirect: true,
 *     stripQuery: false,
 *   },
 *   hostRules: [{ hosts: ["example.com"], pathMatcher: "all" }],
 *   pathMatchers: [
 *     {
 *       name: "all",
 *       defaultUrlRedirect: {
 *         httpsRedirect: true,
 *         hostRedirect: "www.example.com",
 *         stripQuery: false,
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Default backend service
 * ```typescript
 * const map = yield* GCP.Compute.UrlMap("web", {
 *   defaultService: backend.selfLink,
 * });
 * ```
 *
 * @resource
 * @category Compute
 */
export const UrlMap = Resource<UrlMap>("GCP.Compute.UrlMap");

export class UrlMapNotResolved extends Data.TaggedError(
  "GCP.Compute.UrlMapNotResolved",
)<{
  urlMapName: string;
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
    return /^[a-z]/.test(generated) ? generated : `u${generated}`.slice(0, 63);
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

const toBody = (
  urlMapName: string,
  props: UrlMapProps,
  ownership: Record<string, string>,
  fingerprint?: string,
): compute.UrlMap => ({
  name: urlMapName,
  fingerprint,
  description: encodeDescription(ownership, props.description),
  defaultService: props.defaultService,
  defaultUrlRedirect: props.defaultUrlRedirect,
  defaultRouteAction: props.defaultRouteAction,
  hostRules: props.hostRules,
  pathMatchers: props.pathMatchers,
  headerAction: props.headerAction,
  defaultCustomErrorResponsePolicy: props.defaultCustomErrorResponsePolicy,
  tests: props.tests,
});

const toAttrs = (urlMap: compute.UrlMap, project: string) => {
  const parsed = parseDescription(urlMap.description);
  return {
    urlMapName: urlMap.name ?? urlMap.id ?? "",
    project,
    description: parsed.description,
    defaultService: urlMap.defaultService,
    defaultUrlRedirect: urlMap.defaultUrlRedirect,
    defaultRouteAction: urlMap.defaultRouteAction,
    hostRules: urlMap.hostRules ?? [],
    pathMatchers: urlMap.pathMatchers ?? [],
    headerAction: urlMap.headerAction,
    defaultCustomErrorResponsePolicy: urlMap.defaultCustomErrorResponsePolicy,
    tests: urlMap.tests ?? [],
    selfLink: urlMap.selfLink,
    urlMapId: urlMap.id,
    fingerprint: urlMap.fingerprint,
    creationTimestamp: urlMap.creationTimestamp,
    kind: urlMap.kind,
  };
};

const isEmpty = (value: unknown): boolean =>
  value === undefined ||
  value === null ||
  (Array.isArray(value) && value.length === 0);

const subsetEqual = (observed: unknown, desired: unknown): boolean => {
  if (desired === undefined || desired === null) return isEmpty(observed);
  if (Array.isArray(desired)) {
    if (!Array.isArray(observed) || observed.length !== desired.length) {
      return false;
    }
    return desired.every((item, index) => subsetEqual(observed[index], item));
  }
  if (typeof desired === "object") {
    if (
      observed === undefined ||
      observed === null ||
      typeof observed !== "object"
    ) {
      return false;
    }
    const current = observed as Record<string, unknown>;
    for (const [key, value] of Object.entries(
      desired as Record<string, unknown>,
    )) {
      if (value === undefined) continue;
      if (!subsetEqual(current[key], value)) return false;
    }
    return true;
  }
  return observed === desired;
};

const needsUpdate = (current: compute.UrlMap, desired: compute.UrlMap) =>
  (current.description ?? "") !== (desired.description ?? "") ||
  !subsetEqual(current.defaultService, desired.defaultService) ||
  !subsetEqual(current.defaultUrlRedirect, desired.defaultUrlRedirect) ||
  !subsetEqual(current.defaultRouteAction, desired.defaultRouteAction) ||
  !subsetEqual(current.hostRules, desired.hostRules) ||
  !subsetEqual(current.pathMatchers, desired.pathMatchers) ||
  !subsetEqual(current.headerAction, desired.headerAction) ||
  !subsetEqual(
    current.defaultCustomErrorResponsePolicy,
    desired.defaultCustomErrorResponsePolicy,
  ) ||
  !subsetEqual(current.tests, desired.tests);

const getByName = (project: string, urlMap: string) =>
  compute
    .getUrlMaps({ project, urlMap })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const UrlMapProvider = () =>
  Provider.succeed(UrlMap, {
    stables: [
      "urlMapName",
      "project",
      "urlMapId",
      "selfLink",
      "creationTimestamp",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previous = olds?.urlMapName ?? output?.urlMapName;
      const next = news.urlMapName;
      if (previous !== undefined && next !== undefined && previous !== next) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const urlMapName = yield* toName(
        id,
        olds?.urlMapName,
        output?.urlMapName,
      );
      const existing = yield* getByName(env.project, urlMapName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      const { labels } = parseDescription(existing.description);
      return (yield* hasAlchemyLabels(id, labels)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* compute.listUrlMaps.items({ project: env.project }).pipe(
          Stream.filter((urlMap) => {
            const { labels } = parseDescription(urlMap.description);
            return Object.keys(labels).some((key) =>
              key.startsWith("alchemy-"),
            );
          }),
          Stream.map((urlMap) => toAttrs(urlMap, env.project)),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const urlMapName = yield* toName(id, news.urlMapName, output?.urlMapName);
      const ownership = yield* createInternalLabels(id);
      const desired = toBody(urlMapName, news, ownership);

      let current = yield* getByName(env.project, urlMapName);

      if (current === undefined) {
        yield* compute
          .insertUrlMaps({
            project: env.project,
            body: desired,
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        current = yield* getByName(env.project, urlMapName);
      }

      if (current === undefined) {
        return yield* new UrlMapNotResolved({ urlMapName });
      }

      if (needsUpdate(current, desired)) {
        yield* compute
          .updateUrlMaps({
            project: env.project,
            urlMap: urlMapName,
            body: toBody(urlMapName, news, ownership, current.fingerprint),
          })
          .pipe(
            Effect.flatMap((operation) =>
              waitGlobalOperation(env.project, operation),
            ),
          );
        current = yield* getByName(env.project, urlMapName);
        if (current === undefined) {
          return yield* new UrlMapNotResolved({ urlMapName });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      const operation = yield* compute
        .deleteUrlMaps({
          project: env.project,
          urlMap: output.urlMapName,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitGlobalOperation(env.project, operation).pipe(
          Effect.catchTag("NotFound", () => Effect.void),
        );
      }
    }),
  });

import * as networkservices from "@distilled.cloud/gcp/networkservices_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import type {
  GrpcRouteFaultInjectionPolicy,
  GrpcRouteStatefulSessionAffinityPolicy,
} from "./GrpcRoute.ts";
import {
  DEFAULT_GLOBAL,
  changedFields,
  collectPages,
  hasAlchemyLabelKeys,
  normalizeLocation,
  parentOf,
  parseName,
  resourceName,
  rfc1035,
  sameJson,
  sameStringList,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilGone,
  waitUntilPresent,
} from "./internal.ts";

const COLLECTION = "httpRoutes";

export type HttpRouteHeaderMatchIntegerRange = {
  /** Inclusive start of the range. */
  start?: number;
  /** Exclusive end of the range. */
  end?: number;
};

export type HttpRouteHeaderMatch = {
  /** Exact header value. */
  exactMatch?: string;
  /** RE2 regular expression. */
  regexMatch?: string;
  /** Prefix of the header value. */
  prefixMatch?: string;
  /** Suffix of the header value. */
  suffixMatch?: string;
  /** Header is present regardless of value. */
  presentMatch?: boolean;
  /** Integer range match. */
  rangeMatch?: HttpRouteHeaderMatchIntegerRange;
  /** HTTP header name. */
  header?: string;
  /** Invert the match result. */
  invertMatch?: boolean;
};

export type HttpRouteQueryParameterMatch = {
  /** Exact query parameter value. */
  exactMatch?: string;
  /** RE2 regular expression. */
  regexMatch?: string;
  /** Parameter is present regardless of value. */
  presentMatch?: boolean;
  /** Query parameter name. */
  queryParameter?: string;
};

export type HttpRouteRouteMatch = {
  /** Exact request path. Mutually exclusive with prefix/regex. */
  fullPathMatch?: string;
  /** Path prefix. Must start with `/`. */
  prefixMatch?: string;
  /** RE2 regular expression against the path. */
  regexMatch?: string;
  /** Case-insensitive prefix/full path matching. */
  ignoreCase?: boolean;
  /** Header matchers. All must match. */
  headers?: HttpRouteHeaderMatch[];
  /** Query parameter matchers. All must match. */
  queryParameters?: HttpRouteQueryParameterMatch[];
};

export type HttpRouteHeaderModifier = {
  /** Replace headers by name. */
  set?: Record<string, string>;
  /** Append headers by name. */
  add?: Record<string, string>;
  /** Header names to remove. */
  remove?: string[];
};

export type HttpRouteDestination = {
  /** BackendService URL. */
  serviceName?: string;
  /** Traffic weight relative to other destinations. */
  weight?: number;
  /** Request header modifiers applied before forwarding. */
  requestHeaderModifier?: HttpRouteHeaderModifier;
  /** Response header modifiers applied before returning. */
  responseHeaderModifier?: HttpRouteHeaderModifier;
};

export type HttpRouteRedirect = {
  /** Host used in the redirect. */
  hostRedirect?: string;
  /** Path used in the redirect. Mutually exclusive with `prefixRewrite`. */
  pathRedirect?: string;
  /** Replace the matched prefix with this value. */
  prefixRewrite?: string;
  /** HTTP status (`MOVED_PERMANENTLY_DEFAULT`, `FOUND`, …). */
  responseCode?: string;
  /** Redirect to HTTPS. */
  httpsRedirect?: boolean;
  /** Strip the original query string. */
  stripQuery?: boolean;
  /** Port used in the redirect. */
  portRedirect?: number;
};

export type HttpRouteURLRewrite = {
  /** Replace the matching path prefix. */
  pathPrefixRewrite?: string;
  /** Replace the Host header. */
  hostRewrite?: string;
};

export type HttpRouteRetryPolicy = {
  /**
   * Conditions that trigger a retry (`5xx`, `gateway-error`, `reset`,
   * `connect-failure`, `retriable-4xx`, `refused-stream`).
   */
  retryConditions?: string[];
  /** Allowed retry count. Defaults to 1. */
  numRetries?: number;
  /** Timeout per retry attempt. */
  perTryTimeout?: string;
};

export type HttpRouteRequestMirrorPolicy = {
  /** Shadow destination. Weight is ignored. */
  destination?: HttpRouteDestination;
  /** Percentage of requests mirrored. */
  mirrorPercent?: number;
};

export type HttpRouteCorsPolicy = {
  /** Allowed origins. */
  allowOrigins?: string[];
  /** Allowed origin RE2 patterns. */
  allowOriginRegexes?: string[];
  /** `Access-Control-Allow-Methods`. */
  allowMethods?: string[];
  /** `Access-Control-Allow-Headers`. */
  allowHeaders?: string[];
  /** `Access-Control-Expose-Headers`. */
  exposeHeaders?: string[];
  /** `Access-Control-Max-Age` in seconds. */
  maxAge?: string;
  /** `Access-Control-Allow-Credentials`. */
  allowCredentials?: boolean;
  /** Disable the CORS policy. */
  disabled?: boolean;
};

export type HttpRouteHttpDirectResponse = {
  /** Response body as a string. Max 1024 characters. */
  stringBody?: string;
  /** Response body as bytes. Max 4096B. */
  bytesBody?: string;
  /** HTTP status. */
  status?: number;
};

export type HttpRouteRouteAction = {
  /** Destinations that receive matched traffic. */
  destinations?: HttpRouteDestination[];
  /** Redirect instead of forwarding. */
  redirect?: HttpRouteRedirect;
  /** Fault injection. */
  faultInjectionPolicy?: GrpcRouteFaultInjectionPolicy;
  /** Request header modifiers. */
  requestHeaderModifier?: HttpRouteHeaderModifier;
  /** Response header modifiers. */
  responseHeaderModifier?: HttpRouteHeaderModifier;
  /** URL rewrite before forwarding. */
  urlRewrite?: HttpRouteURLRewrite;
  /** End-to-end timeout including retries. */
  timeout?: string;
  /** Retry policy. */
  retryPolicy?: HttpRouteRetryPolicy;
  /** Request mirroring. */
  requestMirrorPolicy?: HttpRouteRequestMirrorPolicy;
  /** CORS policy. */
  corsPolicy?: HttpRouteCorsPolicy;
  /** Cookie-based session affinity. */
  statefulSessionAffinity?: GrpcRouteStatefulSessionAffinityPolicy;
  /** Static HTTP response. */
  directResponse?: HttpRouteHttpDirectResponse;
  /** Idle timeout. `0s` disables it. */
  idleTimeout?: string;
};

export type HttpRouteRouteRule = {
  /**
   * Matchers. The rule matches if any matcher matches. Omitted matches
   * every request.
   */
  matches?: HttpRouteRouteMatch[];
  /** How to route matched traffic. */
  action?: HttpRouteRouteAction;
};

export type HttpRouteProps = {
  /**
   * HttpRoute id (the `{httpRoute}` segment of
   * `projects/{project}/locations/{location}/httpRoutes/{httpRoute}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters and not start with a number.
   * Immutable — changing it replaces the route.
   */
  httpRouteId?: string;
  /**
   * Location (`global`, `us-central1`, …). Immutable — changing it
   * replaces the route. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default "global"
   */
  location?: string;
  /**
   * Hostnames this route matches against the HTTP Host header, e.g.
   * `foo.example.com` or `*.example.com`.
   */
  hostnames: string[];
  /**
   * Routing rules matched in order. At least one rule is required.
   */
  rules: HttpRouteRouteRule[];
  /**
   * Mesh resource names this route attaches to. Attached meshes must be
   * sidecar meshes.
   */
  meshes?: string[];
  /**
   * Gateway resource names this route attaches to.
   */
  gateways?: string[];
  /**
   * Human-readable description. Max length 1024 characters.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type HttpRoute = Resource<
  "GCP.NetworkServices.HttpRoute",
  HttpRouteProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/httpRoutes/{httpRoute}`. */
    name: string;
    /** HttpRoute id (last path segment). */
    httpRouteId: string;
    /** Project id. */
    project: string;
    /** Location id (`global`, `us-central1`, …). */
    location: string;
    /** Server-defined resource URL. */
    selfLink: string | undefined;
    /** Hostnames this route matches. */
    hostnames: string[];
    /** Routing rules. */
    rules: HttpRouteRouteRule[];
    /** Attached Mesh resource names. */
    meshes: string[];
    /** Attached Gateway resource names. */
    gateways: string[];
    /** User-provided description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Network Services HttpRoute — how a Mesh or Gateway routes HTTP
 * traffic for a set of hostnames.
 *
 * Changing `httpRouteId` or `location` replaces the route. Hostnames,
 * rules, mesh/gateway attachments, description, and labels update in
 * place.
 *
 * ### Creating an HttpRoute
 * **Example:** Redirect
 * ```typescript
 * const route = yield* GCP.NetworkServices.HttpRoute("Web", {
 *   hostnames: ["www.example.com"],
 *   rules: [
 *     {
 *       matches: [{ prefixMatch: "/" }],
 *       action: {
 *         redirect: { hostRedirect: "example.com", httpsRedirect: true },
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * **Example:** Direct response
 * ```typescript
 * const route = yield* GCP.NetworkServices.HttpRoute("Health", {
 *   httpRouteId: "app-http",
 *   hostnames: ["health.example.com"],
 *   labels: { env: "prod" },
 *   rules: [
 *     {
 *       matches: [{ fullPathMatch: "/healthz" }],
 *       action: { directResponse: { status: 200, stringBody: "ok" } },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category NetworkServices
 */
export const HttpRoute = Resource<HttpRoute>("GCP.NetworkServices.HttpRoute");

const toStringMap = (
  value: Record<string, string | undefined> | undefined,
): Record<string, string> | undefined => {
  if (value === undefined) return undefined;
  return Object.fromEntries(
    Object.entries(value).filter(
      (entry): entry is [string, string] => entry[1] !== undefined,
    ),
  );
};

const toHeaderModifier = (
  value:
    | HttpRouteHeaderModifier
    | networkservices.HttpRouteHeaderModifier
    | undefined,
): HttpRouteHeaderModifier | undefined => {
  if (value === undefined) return undefined;
  return {
    set: toStringMap(value.set),
    add: toStringMap(value.add),
    remove: value.remove ?? [],
  };
};

const toHeaderMatch = (
  value: HttpRouteHeaderMatch | networkservices.HttpRouteHeaderMatch,
): HttpRouteHeaderMatch => ({
  exactMatch: value.exactMatch,
  regexMatch: value.regexMatch,
  prefixMatch: value.prefixMatch,
  suffixMatch: value.suffixMatch,
  presentMatch: value.presentMatch,
  rangeMatch: value.rangeMatch
    ? { start: value.rangeMatch.start, end: value.rangeMatch.end }
    : undefined,
  header: value.header,
  invertMatch: value.invertMatch,
});

const toQueryMatch = (
  value:
    | HttpRouteQueryParameterMatch
    | networkservices.HttpRouteQueryParameterMatch,
): HttpRouteQueryParameterMatch => ({
  exactMatch: value.exactMatch,
  regexMatch: value.regexMatch,
  presentMatch: value.presentMatch,
  queryParameter: value.queryParameter,
});

const toMatch = (
  value: HttpRouteRouteMatch | networkservices.HttpRouteRouteMatch,
): HttpRouteRouteMatch => ({
  fullPathMatch: value.fullPathMatch,
  prefixMatch: value.prefixMatch,
  regexMatch: value.regexMatch,
  ignoreCase: value.ignoreCase,
  headers: (value.headers ?? []).map(toHeaderMatch),
  queryParameters: (value.queryParameters ?? []).map(toQueryMatch),
});

const toDestination = (
  value: HttpRouteDestination | networkservices.HttpRouteDestination,
): HttpRouteDestination => ({
  serviceName: value.serviceName,
  weight: value.weight,
  requestHeaderModifier: toHeaderModifier(value.requestHeaderModifier),
  responseHeaderModifier: toHeaderModifier(value.responseHeaderModifier),
});

const toRedirect = (
  value: HttpRouteRedirect | networkservices.HttpRouteRedirect | undefined,
): HttpRouteRedirect | undefined => {
  if (value === undefined) return undefined;
  return {
    hostRedirect: value.hostRedirect,
    pathRedirect: value.pathRedirect,
    prefixRewrite: value.prefixRewrite,
    responseCode: value.responseCode,
    httpsRedirect: value.httpsRedirect,
    stripQuery: value.stripQuery,
    portRedirect: value.portRedirect,
  };
};

const toFault = (
  value:
    | GrpcRouteFaultInjectionPolicy
    | networkservices.GrpcRouteFaultInjectionPolicy
    | undefined,
): GrpcRouteFaultInjectionPolicy | undefined => {
  if (value === undefined) return undefined;
  return {
    delay: value.delay
      ? {
          fixedDelay: value.delay.fixedDelay,
          percentage: value.delay.percentage,
        }
      : undefined,
    abort: value.abort
      ? {
          httpStatus: value.abort.httpStatus,
          percentage: value.abort.percentage,
        }
      : undefined,
  };
};

const toRetry = (
  value:
    | HttpRouteRetryPolicy
    | networkservices.HttpRouteRetryPolicy
    | undefined,
): HttpRouteRetryPolicy | undefined => {
  if (value === undefined) return undefined;
  return {
    retryConditions: value.retryConditions ?? [],
    numRetries: value.numRetries,
    perTryTimeout: value.perTryTimeout,
  };
};

const toMirror = (
  value:
    | HttpRouteRequestMirrorPolicy
    | networkservices.HttpRouteRequestMirrorPolicy
    | undefined,
): HttpRouteRequestMirrorPolicy | undefined => {
  if (value === undefined) return undefined;
  return {
    destination: value.destination
      ? toDestination(value.destination)
      : undefined,
    mirrorPercent: value.mirrorPercent,
  };
};

const toCors = (
  value: HttpRouteCorsPolicy | networkservices.HttpRouteCorsPolicy | undefined,
): HttpRouteCorsPolicy | undefined => {
  if (value === undefined) return undefined;
  return {
    allowOrigins: value.allowOrigins ?? [],
    allowOriginRegexes: value.allowOriginRegexes ?? [],
    allowMethods: value.allowMethods ?? [],
    allowHeaders: value.allowHeaders ?? [],
    exposeHeaders: value.exposeHeaders ?? [],
    maxAge: value.maxAge,
    allowCredentials: value.allowCredentials,
    disabled: value.disabled,
  };
};

const toDirect = (
  value:
    | HttpRouteHttpDirectResponse
    | networkservices.HttpRouteHttpDirectResponse
    | undefined,
): HttpRouteHttpDirectResponse | undefined => {
  if (value === undefined) return undefined;
  return {
    stringBody: value.stringBody,
    bytesBody: value.bytesBody,
    status: value.status,
  };
};

const toAction = (
  value:
    | HttpRouteRouteAction
    | networkservices.HttpRouteRouteAction
    | undefined,
): HttpRouteRouteAction | undefined => {
  if (value === undefined) return undefined;
  return {
    destinations: (value.destinations ?? []).map(toDestination),
    redirect: toRedirect(value.redirect),
    faultInjectionPolicy: toFault(value.faultInjectionPolicy),
    requestHeaderModifier: toHeaderModifier(value.requestHeaderModifier),
    responseHeaderModifier: toHeaderModifier(value.responseHeaderModifier),
    urlRewrite: value.urlRewrite
      ? {
          pathPrefixRewrite: value.urlRewrite.pathPrefixRewrite,
          hostRewrite: value.urlRewrite.hostRewrite,
        }
      : undefined,
    timeout: value.timeout,
    retryPolicy: toRetry(value.retryPolicy),
    requestMirrorPolicy: toMirror(value.requestMirrorPolicy),
    corsPolicy: toCors(value.corsPolicy),
    statefulSessionAffinity: value.statefulSessionAffinity
      ? { cookieTtl: value.statefulSessionAffinity.cookieTtl }
      : undefined,
    directResponse: toDirect(value.directResponse),
    idleTimeout: value.idleTimeout,
  };
};

const toRule = (
  value: HttpRouteRouteRule | networkservices.HttpRouteRouteRule,
): HttpRouteRouteRule => ({
  matches: (value.matches ?? []).map(toMatch),
  action: toAction(value.action),
});

const toAttrs = (route: networkservices.HttpRoute, project: string) => {
  const name = route.name ?? "";
  const parsed = parseName(name, COLLECTION, DEFAULT_GLOBAL);
  return {
    name,
    httpRouteId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || DEFAULT_GLOBAL,
    selfLink: route.selfLink,
    hostnames: route.hostnames ?? [],
    rules: (route.rules ?? []).map(toRule),
    meshes: route.meshes ?? [],
    gateways: route.gateways ?? [],
    description: route.description,
    labels: userLabels(route.labels),
    createTime: route.createTime,
    updateTime: route.updateTime,
  };
};

const getByName = (name: string) =>
  networkservices
    .getProjectsLocationsHttpRoutes({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const HttpRouteProvider = () =>
  Provider.succeed(HttpRoute, {
    stables: [
      "name",
      "httpRouteId",
      "project",
      "location",
      "selfLink",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.httpRouteId ?? output?.httpRouteId;
      const nextId = news.httpRouteId
        ? rfc1035(news.httpRouteId, "http-route")
        : previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          nextId !== previousId) ||
        previousLocation !== nextLocation
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const httpRouteId = yield* toPhysicalId(
        id,
        olds?.httpRouteId,
        output?.httpRouteId,
        "http-route",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name =
        output?.name ??
        resourceName(env.project, location, COLLECTION, httpRouteId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* collectPages(
          networkservices.listProjectsLocationsHttpRoutes.pages({
            parent: parentOf(env.project, "-"),
            pageSize: 1000,
            returnPartialSuccess: true,
          }),
          (page) => page.httpRoutes,
        );
        return items
          .filter((item) => hasAlchemyLabelKeys(item.labels))
          .map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const httpRouteId = yield* toPhysicalId(
        id,
        news.httpRouteId,
        output?.httpRouteId,
        "http-route",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        DEFAULT_GLOBAL,
      );
      const name = resourceName(env.project, location, COLLECTION, httpRouteId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desiredRules = news.rules.map(toRule);
      const desiredHostnames = news.hostnames;
      const desiredMeshes = news.meshes ?? [];
      const desiredGateways = news.gateways ?? [];

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* networkservices
          .createProjectsLocationsHttpRoutes({
            parent: parentOf(env.project, location),
            httpRouteId,
            body: {
              labels: desiredLabels,
              description: news.description,
              hostnames: desiredHostnames,
              rules: desiredRules,
              meshes: desiredMeshes,
              gateways: desiredGateways,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 5,
              schedule: Schedule.spaced("2 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilPresent(getByName(name), name);
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const hostnamesChanged = !sameStringList(
        current.hostnames,
        desiredHostnames,
      );
      const rulesChanged = !sameJson(
        (current.rules ?? []).map(toRule),
        desiredRules,
      );
      const meshesChanged = !sameStringList(current.meshes, desiredMeshes);
      const gatewaysChanged = !sameStringList(
        current.gateways,
        desiredGateways,
      );

      const updateMask = changedFields([
        ["labels", labelsChanged],
        ["description", descriptionChanged],
        ["hostnames", hostnamesChanged],
        ["rules", rulesChanged],
        ["meshes", meshesChanged],
        ["gateways", gatewaysChanged],
      ]);

      if (updateMask.length > 0) {
        const operation =
          yield* networkservices.patchProjectsLocationsHttpRoutes({
            name: current.name ?? name,
            updateMask: updateMask.join(","),
            body: {
              name: current.name ?? name,
              labels: desiredLabels,
              description: news.description,
              hostnames: desiredHostnames,
              rules: desiredRules,
              meshes: desiredMeshes,
              gateways: desiredGateways,
            },
          });
        yield* waitForOperation(operation);
        current = yield* waitUntilPresent(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* networkservices
        .deleteProjectsLocationsHttpRoutes({ name: output.name })
        .pipe(
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });

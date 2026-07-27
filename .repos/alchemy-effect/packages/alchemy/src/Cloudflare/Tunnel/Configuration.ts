import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";

import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

/**
 * Per-origin connection tuning the cloudflared daemon applies when
 * forwarding requests upstream. Re-exports distilled's shape so every
 * server-recognised knob (TLS verify, keep-alives, HTTP/2, Access-protected
 * origin, etc.) is available without re-declaring the struct.
 */
export type OriginRequest = NonNullable<
  NonNullable<
    zeroTrust.PutTunnelCloudflaredConfigurationRequest["config"]
  >["originRequest"]
>;

/**
 * One ingress rule in the tunnel's routing list. cloudflared matches each
 * incoming connection against these in order; the first match wins.
 *
 * Omit `hostname` (and `path`) on the *final* rule to make it the catch-all
 * — by convention a `service: "http_status:404"` entry. If you don't author
 * a catch-all, the provider appends one for you so the tunnel config stays
 * valid (Cloudflare rejects PUTs whose last rule has a hostname).
 */
export interface IngressRule {
  /**
   * Public or private hostname this rule matches. Omit for the catch-all
   * rule (which must be last in the list).
   */
  hostname?: string;
  /**
   * Upstream URL or pseudo-service. Common values:
   * - `http://service.namespace.svc.cluster.local:80` — forward to a K8s Service
   * - `https://10.0.0.5:8443` — forward to a private IP
   * - `http_status:404` — return a literal status code (used for the catch-all)
   * - `hello_world` — cloudflared's built-in test page
   */
  service: string;
  /**
   * Optional URL path prefix the rule matches. When omitted, the rule
   * matches every path for the hostname.
   */
  path?: string;
  /**
   * Per-rule origin tuning. Merges with (and overrides) the resource-level
   * `originRequest` defaults.
   */
  originRequest?: OriginRequest;
}

export interface ConfigurationProps {
  /**
   * UUID of the `cfd_tunnel` this configuration belongs to. Each tunnel
   * has a single configuration document, so this both identifies the
   * resource and gates lifecycle operations.
   *
   * Stable — changing the tunnel triggers replacement.
   *
   * Declared as plain `string` (not `string`) so it is statically
   * knowable inside `diff` for the replacement check.
   */
  tunnelId: string;
  /**
   * Ordered ingress rules. cloudflared evaluates them top-down and the
   * first match wins. The catch-all rule is appended automatically — do
   * not include a trailing `{ service: "http_status:404" }` here unless
   * you want it to land mid-list.
   */
  ingress: ReadonlyArray<IngressRule>;
  /**
   * Default origin-request tuning applied to every rule that doesn't set
   * its own. Equivalent to the top-level `originRequest` block in a
   * cloudflared YAML config.
   */
  originRequest?: OriginRequest;
  /**
   * Service for the auto-appended catch-all rule. cloudflared requires
   * the last rule to omit `hostname`; this controls what it returns when
   * no earlier rule matches.
   *
   * @default "http_status:404"
   */
  catchAllService?: string;
}

export interface ConfigurationAttributes {
  /** The tunnel this configuration belongs to. */
  tunnelId: string;
  /** Account that owns the tunnel. */
  accountId: string;
  /**
   * Cloudflare-side config version. Bumped on every PUT, even when the
   * payload is unchanged — surface it so downstream consumers can wait
   * on a specific revision if needed.
   */
  version: number | undefined;
}

export type Configuration = Resource<
  "Cloudflare.Tunnel.Configuration",
  ConfigurationProps,
  ConfigurationAttributes,
  never,
  Providers
>;

/**
 * Routing configuration for a remotely-managed Cloudflare Tunnel.
 *
 * Cloudflare exposes the cfd_tunnel configuration as a single PUT-style
 * document per tunnel — `ingress` rules in order, plus optional default
 * `originRequest` settings. This resource owns that document; it is the
 * declarative equivalent of editing a tunnel's Public Hostname or Private
 * Hostname rules in the Zero Trust dashboard.
 *
 * The catch-all rule (final ingress entry with no hostname) is appended
 * automatically — Cloudflare rejects PUTs whose last rule has a hostname,
 * and forgetting it is a common foot-gun. Override the auto-appended
 * service via {@link ConfigurationProps.catchAllService}.
 * @resource
 * @product Tunnels
 * @category Cloudflare One (Zero Trust)
 * @section Routing a private hostname through a tunnel
 * @example Map an internal admin UI through a Cloudflare Tunnel to a K8s Service
 * ```typescript
 * yield* Cloudflare.Tunnel.Configuration("AdminIngress", {
 *   tunnelId: tunnel.tunnelId,
 *   ingress: [
 *     {
 *       hostname: "cluster-admin.microagi",
 *       service: "http://research-ui.admin.svc.cluster.local:80",
 *     },
 *   ],
 * });
 * ```
 *
 * @section Multiple hostnames + custom catch-all
 * @example Two services on one tunnel, returning 503 for unknown hosts
 * ```typescript
 * yield* Cloudflare.Tunnel.Configuration("Ingress", {
 *   tunnelId: tunnel.tunnelId,
 *   ingress: [
 *     { hostname: "ui.internal", service: "http://ui.app.svc.cluster.local:80" },
 *     { hostname: "api.internal", service: "http://api.app.svc.cluster.local:8080" },
 *   ],
 *   catchAllService: "http_status:503",
 * });
 * ```
 */
export const Configuration = Resource<Configuration>(
  "Cloudflare.Tunnel.Configuration",
);

// ---------------------------------------------------------------------------
// Observed-state types
// ---------------------------------------------------------------------------

interface ObservedIngressRule {
  readonly hostname?: string;
  readonly service?: string;
  readonly path?: string;
  readonly originRequest?: Record<string, unknown>;
}

interface ObservedConfig {
  readonly ingress?: ReadonlyArray<ObservedIngressRule>;
  readonly originRequest?: Record<string, unknown>;
  readonly version?: number;
}

const undef = <T>(v: T | null | undefined): T | undefined =>
  v == null ? undefined : v;

const stripNulls = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(stripNulls);
  if (v !== null && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (val === null || val === undefined) continue;
      out[k] = stripNulls(val);
    }
    return out;
  }
  return v;
};

const narrowConfig = (raw: {
  config?: {
    ingress?: ReadonlyArray<{
      hostname?: string | null;
      service?: string;
      path?: string | null;
      originRequest?: Record<string, unknown> | null;
    }> | null;
    originRequest?: Record<string, unknown> | null;
  } | null;
  version?: number | null;
}): ObservedConfig => ({
  ingress:
    raw.config?.ingress == null
      ? undefined
      : raw.config.ingress.map((r) => ({
          hostname: undef(r.hostname),
          service: r.service,
          path: undef(r.path),
          originRequest: undef(r.originRequest),
        })),
  originRequest: undef(raw.config?.originRequest),
  version: undef(raw.version),
});

// ---------------------------------------------------------------------------
// Body construction
// ---------------------------------------------------------------------------

const DEFAULT_CATCH_ALL_SERVICE = "http_status:404";

const buildIngress = (
  rules: ReadonlyArray<IngressRule>,
  catchAllService: string,
): Array<IngressRule> => {
  const out: Array<IngressRule> = [];
  for (const r of rules) {
    // Drop any catch-all the caller threaded into the middle — we always
    // append exactly one trailing catch-all of our own, and a mid-list
    // catch-all would short-circuit every following rule anyway.
    if (r.hostname === undefined && r.path === undefined) continue;
    out.push(r);
  }
  out.push({ service: catchAllService });
  return out;
};

// ---------------------------------------------------------------------------
// Drift detection
//
// Cloudflare echoes back a config object with every optional field filled in
// (often as `null`). Strip nulls before comparing so a server-supplied
// `path: null` doesn't endlessly diff against an unset desired `path`.
// ---------------------------------------------------------------------------

const configsEqual = (
  desiredIngress: ReadonlyArray<IngressRule>,
  desiredOrigin: OriginRequest | undefined,
  observed: ObservedConfig,
): boolean => {
  const left = stripNulls({
    ingress: desiredIngress,
    originRequest: desiredOrigin,
  });
  const right = stripNulls({
    ingress: observed.ingress ?? [],
    originRequest: observed.originRequest,
  });
  return JSON.stringify(left) === JSON.stringify(right);
};

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------

export const ConfigurationProvider = () =>
  Provider.effect(
    Configuration,
    Effect.gen(function* () {
      const env = yield* CloudflareEnvironment;

      const getConfig = yield* zeroTrust.getTunnelCloudflaredConfiguration;
      const putConfig = yield* zeroTrust.putTunnelCloudflaredConfiguration;

      const observe = (accountId: string, tunnelId: string) =>
        Effect.gen(function* () {
          // A tunnel with no configuration yet surfaces as the tagged
          // `TunnelConfigurationNotFound` (code 1055) — swallow into "missing".
          const r = yield* getConfig({ accountId, tunnelId }).pipe(
            Effect.catchTag("TunnelConfigurationNotFound", () =>
              Effect.succeed(undefined),
            ),
          );
          if (r === undefined) return undefined;
          return narrowConfig(r as Parameters<typeof narrowConfig>[0]);
        });

      return {
        stables: ["tunnelId", "accountId"],

        diff: Effect.fn(function* ({ olds = {}, news }) {
          // tunnelId is statically declared as Input<string>; by reconcile
          // time both sides resolve to strings. A change replaces because
          // a tunnel's configuration is keyed by tunnelId in the URL.
          const oldId = (olds as ConfigurationProps).tunnelId;
          const newId = (news as ConfigurationProps).tunnelId;
          if (
            typeof oldId === "string" &&
            typeof newId === "string" &&
            oldId !== newId
          ) {
            return { action: "replace" } as const;
          }
        }),

        reconcile: Effect.fn(function* ({ news }) {
          const { accountId } = yield* env;
          // Inputs have been resolved to concrete strings by the Plan layer.
          const tunnelId = news.tunnelId as string;
          const catchAllService =
            news.catchAllService ?? DEFAULT_CATCH_ALL_SERVICE;
          const desiredIngress = buildIngress(news.ingress, catchAllService);

          // Observe — falls through to a PUT if the tunnel has no config yet.
          let observed = yield* observe(accountId, tunnelId);

          // Sync — skip the PUT entirely when observed equals desired.
          if (
            observed === undefined ||
            !configsEqual(desiredIngress, news.originRequest, observed)
          ) {
            const updated = yield* putConfig({
              accountId,
              tunnelId,
              config: {
                ingress: desiredIngress.map((r) => ({
                  hostname: r.hostname,
                  service: r.service,
                  path: r.path,
                  originRequest: r.originRequest,
                })),
                originRequest: news.originRequest,
              },
            });
            observed = narrowConfig(
              updated as Parameters<typeof narrowConfig>[0],
            );
          }

          return {
            tunnelId,
            accountId,
            version: observed.version,
          } satisfies ConfigurationAttributes;
        }),

        delete: Effect.fn(function* ({ output }) {
          // Cloudflare's API has no DELETE for the configuration document —
          // PUT the catch-all-only shape so the tunnel stops routing
          // anything and idempotently converges.
          yield* putConfig({
            accountId: output.accountId,
            tunnelId: output.tunnelId,
            config: {
              ingress: [{ service: DEFAULT_CATCH_ALL_SERVICE }],
            },
          }).pipe(Effect.catch(() => Effect.void));
        }),

        read: Effect.fn(function* ({ output }) {
          if (!output) return undefined;
          const observed = yield* observe(output.accountId, output.tunnelId);
          if (observed === undefined) return undefined;
          return {
            tunnelId: output.tunnelId,
            accountId: output.accountId,
            version: observed.version,
          } satisfies ConfigurationAttributes;
        }),

        // The configuration is a per-tunnel singleton with no account-wide
        // enumeration API — fan out from the parent. Enumerate every
        // (non-deleted) cfd_tunnel in the account, then read each tunnel's
        // configuration document with bounded concurrency. Tunnels without a
        // config (`TunnelConfigurationNotFound`, handled inside `observe`) are
        // skipped, exactly mirroring `read`.
        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* env;

            const tunnelIds = yield* zeroTrust.listTunnelCloudflareds
              .pages({ accountId, isDeleted: false })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) =>
                    (page.result ?? []).flatMap((t) =>
                      t.id != null && t.deletedAt == null ? [t.id] : [],
                    ),
                  ),
                ),
              );

            const rows = yield* Effect.forEach(
              tunnelIds,
              (tunnelId) =>
                observe(accountId, tunnelId).pipe(
                  Effect.map((observed) =>
                    observed === undefined
                      ? undefined
                      : ({
                          tunnelId,
                          accountId,
                          version: observed.version,
                        } satisfies ConfigurationAttributes),
                  ),
                ),
              { concurrency: 10 },
            );

            return rows.filter(
              (row): row is ConfigurationAttributes => row !== undefined,
            );
          }),
      };
    }),
  );

void Option.none;

import * as zeroTrust from "@distilled.cloud/cloudflare/zero-trust";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Stream from "effect/Stream";

import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { arrayEqualsUnordered } from "../../Util/equal.ts";
import { CloudflareEnvironment } from "../CloudflareEnvironment.ts";
import type { Providers } from "../Providers.ts";

const TypeId = "Cloudflare.Gateway.ProxyEndpoint" as const;
type TypeId = typeof TypeId;

/**
 * The kind of proxy endpoint. `ip` endpoints admit traffic from a source
 * CIDR allowlist (Enterprise only); `identity` endpoints authenticate
 * per-user. Immutable — changing the kind triggers a replacement.
 */
export type ProxyEndpointKind = "ip" | "identity";

export interface ProxyEndpointProps {
  /**
   * Display name for the proxy endpoint. Used as a stable identifier so
   * the provider can locate it by name during adoption / state recovery.
   * If omitted, a unique name is generated from the app, stage, and
   * logical ID.
   *
   * @default ${app}-${stage}-${id}
   */
  name?: string;
  /**
   * The proxy endpoint kind. `ip` endpoints (source-CIDR allowlist)
   * require an Enterprise plan; `identity` endpoints work on all Zero
   * Trust plans. Immutable — changing the kind triggers a replacement.
   *
   * @default "ip"
   */
  kind?: ProxyEndpointKind;
  /**
   * Source CIDRs allowed to connect through the endpoint (e.g.
   * `203.0.113.1/32`). Required for (and only meaningful on) `ip`-kind
   * endpoints. Mutable — patched in place.
   */
  ips?: string[];
}

export interface ProxyEndpointAttributes {
  /** UUID of the proxy endpoint, assigned by Cloudflare. */
  proxyEndpointId: string;
  /** Cloudflare account that owns the proxy endpoint. */
  accountId: string;
  /** Display name of the proxy endpoint. */
  name: string;
  /** The proxy endpoint kind. */
  kind: ProxyEndpointKind;
  /** Source CIDR allowlist (empty for identity-kind endpoints). */
  ips: string[];
  /**
   * Server-assigned subdomain. The PAC-file proxy hostname is
   * `<subdomain>.proxy.cloudflare-gateway.com`.
   */
  subdomain: string | undefined;
  /** ISO8601 creation timestamp. */
  createdAt: string | undefined;
  /** ISO8601 last-update timestamp. */
  updatedAt: string | undefined;
}

export type ProxyEndpoint = Resource<
  TypeId,
  ProxyEndpointProps,
  ProxyEndpointAttributes,
  never,
  Providers
>;

/**
 * A Cloudflare Zero Trust Gateway proxy endpoint — an agentless HTTP
 * proxy for forwarding traffic to Gateway without installing the WARP
 * client, typically wired up via a PAC file pointing at the endpoint's
 * server-assigned `subdomain`.
 *
 * `ip`-kind endpoints admit traffic from a source-CIDR allowlist and
 * require an Enterprise plan (Cloudflare error code 2009 otherwise);
 * `identity`-kind endpoints authenticate individual users and work on all
 * Zero Trust plans. The kind is immutable; name and `ips` converge in
 * place. Accounts are limited to a small number of proxy endpoints, so
 * prefer reusing one per account.
 * @resource
 * @product Gateway
 * @category Cloudflare One (Zero Trust)
 * @section Creating a Proxy Endpoint
 * @example Identity-based endpoint (all plans)
 * ```typescript
 * const proxy = yield* Cloudflare.Gateway.ProxyEndpoint("UserProxy", {
 *   kind: "identity",
 * });
 * // PAC file target:
 * const host = `${proxy.subdomain}.proxy.cloudflare-gateway.com`;
 * ```
 *
 * @example IP allowlist endpoint (Enterprise)
 * ```typescript
 * const proxy = yield* Cloudflare.Gateway.ProxyEndpoint("OfficeProxy", {
 *   kind: "ip",
 *   ips: ["203.0.113.1/32"],
 * });
 * ```
 *
 * @see https://developers.cloudflare.com/cloudflare-one/connections/connect-devices/agentless/pac-files/
 */
export const ProxyEndpoint = Resource<ProxyEndpoint>(TypeId);

/**
 * Returns true if the given value is a ProxyEndpoint resource.
 */
export const isProxyEndpoint = (value: unknown): value is ProxyEndpoint =>
  Predicate.hasProperty(value, "Type") && value.Type === TypeId;

export const ProxyEndpointProvider = () =>
  Provider.succeed(ProxyEndpoint, {
    stables: ["proxyEndpointId", "accountId", "kind", "subdomain", "createdAt"],

    diff: Effect.fn(function* ({ olds = {}, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      if (!isResolved(news)) return undefined;
      if ((output?.accountId ?? accountId) !== accountId) {
        return { action: "replace" } as const;
      }
      // The endpoint kind is immutable on Cloudflare's side.
      const oldKind =
        output?.kind ?? (olds as ProxyEndpointProps).kind ?? undefined;
      if (oldKind !== undefined && oldKind !== (news.kind ?? "ip")) {
        return { action: "replace" } as const;
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, output, olds }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const acct = output?.accountId ?? accountId;

      // Owned path — refresh by the cached endpoint id.
      if (output?.proxyEndpointId) {
        const observed = yield* getEndpoint(acct, output.proxyEndpointId);
        if (observed) return toAttributes(observed, acct);
      }

      // Cold read — locate by deterministic name. Proxy endpoints carry no
      // ownership markers, so report the match as Unowned to gate adoption.
      const name = yield* resolveName(id, olds?.name ?? output?.name);
      const match = yield* findByName(acct, name);
      if (match) return Unowned(toAttributes(match, acct));
      return undefined;
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const { accountId } = yield* yield* CloudflareEnvironment;
      const name = yield* resolveName(id, news.name);
      const kind = news.kind ?? "ip";

      // 1. Observe — the cached id is a hint; fall back to a name scan.
      //    Accounts are limited to very few proxy endpoints, so converging
      //    onto an existing same-named endpoint matters more than usual.
      let observed = output?.proxyEndpointId
        ? yield* getEndpoint(accountId, output.proxyEndpointId)
        : undefined;
      if (!observed) {
        observed = yield* findByName(accountId, name);
      }

      // 2. Ensure — create with the full desired body when missing.
      //    `ip`-kind endpoints on a non-Enterprise account fail with the
      //    typed entitlement error IpProxyEndpointsRequireEnterprise
      //    (Cloudflare code 2009), which propagates.
      if (!observed) {
        observed = yield* zeroTrust.createGatewayProxyEndpoint({
          accountId,
          name,
          kind,
          ...(kind === "ip" ? { ips: news.ips ?? [] } : {}),
        });
      }

      // 3. Sync — diff observed name/ips against desired and PATCH only
      //    the delta; skip the call entirely on a no-op. `ips` compares as
      //    an unordered set and only applies to ip-kind endpoints.
      const observedIps = "ips" in observed ? [...observed.ips] : [];
      const dirty =
        observed.name !== name ||
        (kind === "ip" &&
          news.ips !== undefined &&
          !arrayEqualsUnordered(observedIps, news.ips));
      if (dirty) {
        observed = yield* zeroTrust.patchGatewayProxyEndpoint({
          accountId,
          proxyEndpointId: observed.id ?? "",
          name,
          ...(kind === "ip" && news.ips !== undefined ? { ips: news.ips } : {}),
        });
      }

      return toAttributes(observed, accountId);
    }),

    delete: Effect.fn(function* ({ output }) {
      // A missing endpoint (ProxyEndpointNotFound, code 2002) means we're
      // done.
      yield* zeroTrust
        .deleteGatewayProxyEndpoint({
          accountId: output.accountId,
          proxyEndpointId: output.proxyEndpointId,
        })
        .pipe(Effect.catchTag("ProxyEndpointNotFound", () => Effect.void));
    }),

    // Account-scoped collection: the proxy-endpoints list op returns each
    // endpoint's full body, so no per-item hydration is needed. Exhaustively
    // paginate (`.items` flattens `result` across pages) and map straight into
    // the `read` Attributes shape.
    list: Effect.fn(function* () {
      const { accountId } = yield* yield* CloudflareEnvironment;
      return yield* zeroTrust.listGatewayProxyEndpoints
        .items({ accountId })
        .pipe(
          Stream.map((e) => toAttributes(e as ObservedEndpoint, accountId)),
          Stream.runCollect,
          Effect.map((chunk) => Array.from(chunk)),
        );
    }),
  });

type ObservedEndpoint = zeroTrust.GetGatewayProxyEndpointResponse;

/**
 * Read a proxy endpoint by id, mapping "gone" (`ProxyEndpointNotFound`,
 * Cloudflare error code 2002) to `undefined`.
 */
const getEndpoint = (accountId: string, proxyEndpointId: string) =>
  zeroTrust.getGatewayProxyEndpoint({ accountId, proxyEndpointId }).pipe(
    Effect.map((e): ObservedEndpoint | undefined => e),
    Effect.catchTag("ProxyEndpointNotFound", () => Effect.succeed(undefined)),
  );

/**
 * Find a proxy endpoint by exact name. Pick the oldest match for
 * determinism.
 */
const findByName = (accountId: string, name: string) =>
  zeroTrust.listGatewayProxyEndpoints.items({ accountId }).pipe(
    Stream.filter((e) => e.name === name),
    Stream.runCollect,
    Effect.map(
      (chunk): ObservedEndpoint | undefined =>
        Array.from(chunk)
          .sort((a, b) => (a.createdAt ?? "").localeCompare(b.createdAt ?? ""))
          .at(0) as ObservedEndpoint | undefined,
    ),
  );

const resolveName = (id: string, name: string | undefined) =>
  Effect.gen(function* () {
    if (name) return name;
    return yield* createPhysicalName({ id, lowercase: true });
  });

const toAttributes = (
  endpoint: ObservedEndpoint,
  accountId: string,
): ProxyEndpointAttributes => ({
  proxyEndpointId: endpoint.id ?? "",
  accountId,
  name: endpoint.name,
  kind: (endpoint.kind ?? "ip") as ProxyEndpointKind,
  ips: "ips" in endpoint ? [...endpoint.ips] : [],
  subdomain: endpoint.subdomain ?? undefined,
  createdAt: endpoint.createdAt ?? undefined,
  updatedAt: endpoint.updatedAt ?? undefined,
});

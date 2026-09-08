import * as Effect from "effect/Effect";
import { createHash } from "node:crypto";
import { toPath } from "../../FQN.ts";
import type { Input } from "../../Input.ts";
import * as Namespace from "../../Namespace.ts";
import * as Output from "../../Output.ts";
import { Stack } from "../../Stack.ts";
import { Stage } from "../../Stage.ts";
import { KvEntries } from "../CloudFront/KvEntries.ts";
import { KvRoutesUpdate } from "../CloudFront/KvRoutesUpdate.ts";
import type { WebsiteDomainProps, WebsiteRouterDomainProps } from "./shared.ts";

/**
 * Narrow a normalized `domain` prop to its Router-attached shape.
 * @internal
 */
export const asRouterDomain = (
  domain: WebsiteDomainProps | undefined,
): WebsiteRouterDomainProps | undefined =>
  domain && "router" in domain && domain.router
    ? (domain as WebsiteRouterDomainProps)
    : undefined;

/**
 * Escape a host pattern into the regex form the Router's edge function
 * matches against. Mirrors `toHostPatternRegex` in StaticSite.ts.
 */
const toHostPatternRegex = (pattern: string) =>
  pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");

/**
 * Register a **dev-mode** site with its `AWS.Website.Router`.
 *
 * `alchemy dev` replaces a site's S3 bucket + asset upload with the
 * framework's own dev server, but the Router-facing subgraph stays exactly
 * the same resource types as a live deploy — `KvRoutesUpdate` route entries
 * (byte-identical to live) plus a `KvEntries` metadata blob. Only the
 * metadata *contents* differ: instead of an `s3` origin plus a file
 * manifest, dev writes a `servers` origin pointing at the local dev
 * server, which `routeSite()` in cfcode.ts already handles (every KV file
 * lookup misses, so it falls through to `setUrlOrigin`).
 *
 * There is deliberately no dev-only resource type and no `ctx.dev` branch
 * inside `Router`: switching between `alchemy dev` and `alchemy deploy`
 * must be a `providerMode` change on the same graph, not a different graph.
 *
 * Must be called from inside the site's own namespace (the composites call
 * it after `Namespace.push(id)`) so the KV namespace hash and the child
 * resource FQNs match the live path exactly.
 *
 * @returns the site's URLs, computed the same way the live Router
 * attachment computes them.
 * @internal
 */
export const registerDevRouterRoute = Effect.fn("AWS.Website.DevRouterRoute")(
  function* (
    domain: WebsiteRouterDomainProps,
    /** The local dev server's URL (e.g. `http://localhost:5173`). */
    devUrl: Input<string | undefined>,
  ) {
    const router = domain.router;
    const stack = yield* Stack;
    const stage = yield* Stage;
    const ns = yield* Namespace.CurrentNamespace;
    const fqn = ns ? toPath(ns).join("/") : "";
    const kvNamespace = createHash("md5")
      .update(`${stack.name}-${stage}-${fqn}`)
      .digest("hex")
      .substring(0, 4);

    const routerPathPrefix = domain.path
      ? "/" + domain.path.replace(/^\//, "").replace(/\/$/, "")
      : undefined;

    // One KV route entry per host pattern — identical shape, ids, and
    // ordering to the live attachment in `makeKvSite`.
    const hostPatterns: [id: string, pattern: string | undefined][] = [
      ["RoutesUpdate", domain.name],
      ...(domain.aliases ?? []).map((alias, index): [string, string] => [
        `RoutesUpdateAlias${index + 1}`,
        alias,
      ]),
      ...(domain.redirects ?? []).map((redirect, index): [string, string] => [
        `RoutesUpdateRedirect${index + 1}`,
        redirect,
      ]),
    ];

    yield* Effect.forEach(
      hostPatterns,
      ([routeId, pattern]) =>
        KvRoutesUpdate(routeId, {
          store: router.kvStoreArn,
          namespace: router.kvNamespace as any,
          key: "routes",
          entry: [
            "site",
            kvNamespace,
            pattern ? toHostPatternRegex(pattern) : "",
            routerPathPrefix ?? "/",
          ].join(","),
        }),
      { concurrency: "unbounded" },
    );

    const redirect =
      domain.redirects?.length && domain.name
        ? { hosts: domain.redirects, to: domain.name }
        : undefined;

    yield* KvEntries("KvEntries", {
      store: router.kvStoreArn,
      namespace: kvNamespace,
      entries: {
        metadata: Output.map(
          Output.asOutput(devUrl as any) as Output.Output<string | undefined>,
          (resolved) => {
            if (!resolved) {
              throw new Error(
                "A Router-attached site needs a dev server URL to route to during `alchemy dev` — set `dev.url` (or make the dev command print its own localhost URL).",
              );
            }
            return JSON.stringify({
              base:
                routerPathPrefix && routerPathPrefix !== "/"
                  ? routerPathPrefix
                  : undefined,
              // `[[host]]` — one server, no geo coordinates, so
              // `findNearestServer` returns it unconditionally. The host
              // carries the dev server's port; the emulated edge resolves
              // loopback origins to a container-reachable address.
              servers: [[new URL(resolved).host]],
              // Dev servers speak plain HTTP. `setUrlOrigin` in cfcode.ts
              // already threads `metadata.origin` through to
              // `cf.updateRequestOrigin`.
              origin: { protocol: "http" },
              redirect,
            });
          },
        ),
      },
      purge: true,
    });

    // The site's own `url` output stays the dev server's localhost address
    // (the point of `alchemy dev` is the HMR server); the Router serves the
    // same content at `router.url + domain.path`.
    return kvNamespace;
  },
);

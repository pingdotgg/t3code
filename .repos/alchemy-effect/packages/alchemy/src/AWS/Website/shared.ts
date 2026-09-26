import type { Input } from "../../Input.ts";
import type { Certificate } from "../ACM/Certificate.ts";
import type { Distribution } from "../CloudFront/Distribution.ts";
import type { Records } from "../Route53/Records.ts";
import type { AssetFileOption } from "./AssetDeployment.ts";
import type { Bucket } from "../S3/Bucket.ts";

/**
 * Same-stack resources a Router-attached site binds its concrete hostnames
 * onto, so declaring `domain: { name, router }` on the site alone is enough
 * for the hostname to be fully provisioned — distribution alias, certificate
 * SAN, and Route 53 record. Populated by `AWS.Website.Router` when it owns a
 * `domain`; absent on cross-stack references (bindings are same-stack), in
 * which case the site registers KV host-matching only and the hostname must
 * be covered by the Router's own `domain` configuration.
 */
export interface WebsiteRouterBindTargets {
  /**
   * The Router's CloudFront distribution — bound hostnames become
   * distribution aliases.
   */
  distribution?: Distribution;
  /**
   * The Router's managed ACM certificate — bound hostnames become
   * certificate SANs (a SAN change replaces the certificate, create-first).
   * Absent when the Router uses a user-provided `domain.cert`, which must
   * then already cover attached-site hostnames (e.g. a wildcard
   * certificate).
   */
  certificate?: Certificate;
  /**
   * The Router's Route 53 alias record set — bound hostnames get A-alias
   * records pointing at the distribution. Absent when the Router's domain
   * sets `dns: false`. Without an explicit `hostedZoneId`, the set infers
   * its zone from the first bound hostname.
   */
  records?: Records;
}

/**
 * Structural slice of an `AWS.Website.Router` that a site attaches to via
 * `domain.router` — satisfied by the Router's own return value.
 */
export interface WebsiteRouterRef {
  kvStoreArn: Input<string>;
  kvNamespace: Input<string>;
  distributionId: Input<string>;
  distributionArn: Input<string>;
  url: Input<string>;
  /**
   * Same-stack bind targets for attached-site hostnames (see
   * {@link WebsiteRouterBindTargets}). Cross-stack refs omit this — the
   * attached site then falls back to KV host-matching only.
   */
  bindTargets?: WebsiteRouterBindTargets | undefined;
}

/**
 * A standalone custom domain: the site (or Router) owns its own CloudFront
 * distribution, and the domain is attached as a distribution alias with an
 * ACM certificate and Route 53 records.
 */
export interface WebsiteStandaloneDomainProps {
  /**
   * The canonical hostname (e.g. `"www.example.com"`). Attached to the
   * distribution as an alias — certificate and Route 53 records are managed
   * automatically (see {@link cert} and {@link dns} to opt out).
   *
   * When set, `https://<name>` is the site's primary `url` output.
   */
  name: string;
  /**
   * Hosted zone used for Route 53 automation. Optional — when omitted,
   * the most specific PUBLIC hosted zone in the account containing each
   * hostname is inferred by walking its parent domains; the deploy fails
   * actionably when no zone matches. Pass an explicit id to pin the zone
   * (e.g. when several zones could match).
   */
  hostedZoneId?: string;
  /**
   * Additional hostnames that serve the site (e.g. `"example.com"`,
   * `"docs.example.com"`). Each is attached as its own distribution alias,
   * certificate SAN, and Route 53 record. Order matters: aliases follow
   * `name` in the `urls` output.
   */
  aliases?: string[];
  /**
   * Hostnames that permanently redirect (HTTP 301, path and query
   * preserved) to {@link name} — e.g. `"old.example.com"`. Each is attached
   * as a distribution alias (for TLS) with a certificate SAN and Route 53
   * record, and the generated viewer-request CloudFront Function issues the
   * redirect. Redirect hostnames serve no content, so they appear in the
   * `domain` output but never in `urls`.
   */
  redirects?: string[];
  /**
   * Existing ACM certificate ARN to use instead of creating one.
   */
  cert?: Input<string>;
  /**
   * Disable Route 53 automation. When set, no DNS records are created.
   */
  dns?: false;
  /**
   * Never set on a standalone domain — attach to a Router by setting
   * {@link WebsiteRouterDomainProps.router}.
   */
  router?: undefined;
  /**
   * Never set on a standalone domain — `path` only applies to
   * Router-attached sites ({@link WebsiteRouterDomainProps.path}).
   */
  path?: undefined;
}

/**
 * A Router-attached domain: the site owns no distribution — it registers
 * itself in the Router's KV store and is served through the Router's
 * distribution, matched by host pattern and path prefix.
 */
export interface WebsiteRouterDomainProps {
  /**
   * Host pattern this site is served for on the Router — an exact hostname
   * (`"docs.example.com"`) or a wildcard pattern (`"*.example.com"`). When
   * omitted, the site matches any host on the Router.
   *
   * Pattern semantics exist ONLY in Router mode: a standalone
   * {@link WebsiteStandaloneDomainProps.name} is always a concrete
   * hostname.
   *
   * A concrete hostname on a same-stack Router that owns a `domain` is
   * fully provisioned from this declaration alone: the site binds it onto
   * the Router's distribution (alias), certificate (SAN), and Route 53
   * record set (see {@link WebsiteRouterBindTargets}). Wildcard patterns
   * bind nothing concrete — a wildcard-matched site still needs the
   * Router's own `domain`/certificate to cover its hostnames (e.g. a
   * wildcard alias on the Router). The same applies to cross-stack Router
   * references, where bindings cannot flow.
   */
  name?: string;
  /**
   * Additional host patterns that serve the site through the Router. Each
   * registers its own KV route entry. Requires {@link name}. Order
   * matters: aliases follow `name` in the `urls` output.
   */
  aliases?: string[];
  /**
   * Exact hostnames that permanently redirect (HTTP 301, path and query
   * preserved) to {@link name}. The Router's edge function issues the
   * redirect when a matched request arrives on one of these hosts.
   * Requires a concrete (non-wildcard) {@link name}. Redirect hostnames
   * appear in the `domain` output but never in `urls`.
   */
  redirects?: string[];
  /**
   * The `AWS.Website.Router` to attach to (or any structural slice with
   * its KV store, namespace, distribution, and URL outputs).
   */
  router: WebsiteRouterRef;
  /**
   * Path prefix the site is served under (e.g. `"/docs"`).
   * @default "/"
   */
  path?: string;
}

/**
 * A website's custom-domain configuration: either a standalone domain (the
 * site owns its own CloudFront distribution) or a Router attachment (the
 * site is served through an existing `AWS.Website.Router`).
 */
export type WebsiteDomainProps =
  | WebsiteStandaloneDomainProps
  | WebsiteRouterDomainProps;

/**
 * Accepted `domain` prop shape: a bare hostname string (shorthand for
 * `{ name }`), a full config object, or `null` to explicitly clear.
 */
export type WebsiteDomainInput = string | WebsiteDomainProps | null;

/**
 * Normalize the accepted `domain` prop shapes (`string` shorthand, `null`
 * clear) into the object form. A bare string is always a standalone
 * canonical hostname, so the shorthand result satisfies any accepted
 * domain shape.
 * @internal
 */
export const normalizeWebsiteDomain = <D extends WebsiteDomainProps>(
  domain: string | D | null | undefined,
): D | undefined =>
  domain == null
    ? undefined
    : typeof domain === "string"
      ? ({ name: domain } as D)
      : domain;

export interface WebsiteRewrite {
  /**
   * Regex matched against the request URI.
   */
  regex: string;
  /**
   * Replacement path forwarded to the origin.
   */
  to: string;
}

export interface WebsiteEdgeInjection {
  /**
   * JavaScript injected into the generated CloudFront Function body.
   */
  injection: string;
  /**
   * Optional associated KeyValueStore ARN for the function.
   */
  keyValueStoreArn?: Input<string>;
}

export interface WebsiteEdgeProps {
  /**
   * Additional logic for viewer request handling.
   */
  viewerRequest?: WebsiteEdgeInjection;
  /**
   * Additional logic for viewer response handling.
   */
  viewerResponse?: WebsiteEdgeInjection;
}

export interface WebsiteInvalidationProps {
  /**
   * Wait for the CloudFront invalidation to finish.
   * @default false
   */
  wait?: boolean;
  /**
   * Paths to invalidate.
   * @default "all"
   */
  paths?: "all" | "versioned" | string[];
}

/**
 * Character encoding appended as `charset` to inferred text-based content
 * types (`none` omits the charset entirely).
 */
export type WebsiteTextEncoding =
  | "utf-8"
  | "iso-8859-1"
  | "windows-1252"
  | "ascii"
  | "none";

export interface StaticSiteBuildProps {
  /**
   * Command used to build the site before upload.
   */
  command: string;
  /**
   * Directory containing the build output, relative to `path`.
   */
  output: string;
  /**
   * Environment variables exposed to the build command.
   */
  env?: Record<string, Input<string>>;
  /**
   * Glob patterns of files to hash. Paths are relative to `path`.
   * When the hash of matched files changes, the build will re-run.
   *
   * @default ["**\/*"] (all files, filtered by `exclude`)
   * @example ["src/**", "package.json", "tsconfig.json"]
   */
  include?: string[];
  /**
   * Glob patterns to exclude from input hashing. Paths are relative to `path`.
   *
   * @default gitignore rules collected from the working directory up to the repo root
   */
  exclude?: string[];
  /**
   * Whether to include the nearest package-manager lockfile in the hash,
   * even when it lives above the site directory (e.g. monorepo root).
   *
   * @default true when both `include` and `exclude` are unset; false otherwise
   */
  lockfile?: boolean;
}

export interface StaticSiteAssetsProps {
  /**
   * Existing bucket used for asset uploads.
   * When a string bucket name is provided, bucket policies must be managed
   * separately because Alchemy cannot bind to an external bucket resource.
   */
  bucket?: Bucket;
  /**
   * Optional path prefix inside the bucket.
   */
  path?: string;
  /**
   * Remove stale files under the bucket path prefix.
   * @default true
   */
  purge?: boolean;
  /**
   * Additional route prefixes that should be served directly from the bucket.
   */
  routes?: string[];
  /**
   * Character encoding used for text-based assets.
   * @default "utf-8"
   */
  textEncoding?: WebsiteTextEncoding;
}

/**
 * Static-asset upload configuration for the website composites:
 * {@link StaticSiteAssetsProps} plus per-file overrides.
 */
export interface WebsiteAssetsConfig extends StaticSiteAssetsProps {
  /**
   * Per-file overrides for content type and cache-control.
   */
  fileOptions?: AssetFileOption[];
}

export interface RouterUrlRouteProps {
  /**
   * Destination URL.
   */
  url: Input<string>;
  /**
   * Optional rewrite applied before forwarding.
   */
  rewrite?: WebsiteRewrite;
  /**
   * Optional origin override configuration.
   */
  origin?: Record<string, any>;
  /**
   * Origin protocol policy (used by SsrSite for server origins).
   */
  originProtocolPolicy?: string;
}

export interface RouterBucketRouteProps {
  /**
   * Bucket or bucket regional domain name served by the route.
   */
  bucket: Bucket | string;
  /**
   * Optional rewrite applied before forwarding.
   */
  rewrite?: WebsiteRewrite;
  /**
   * Optional origin override configuration.
   */
  origin?: Record<string, any>;
  /**
   * Optional CloudFront OAC to attach to the S3 origin (used by SsrSite).
   */
  originAccessControlId?: Input<string>;
  /**
   * Additional origin path prefix (used by SsrSite).
   */
  originPath?: Input<string>;
  /**
   * Version token for invalidation (used by SsrSite).
   */
  version?: Input<string>;
}

/**
 * An inline route target: a destination URL string, a URL route with rewrite
 * options, or an S3 bucket route.
 */
export type RouterRoute = string | RouterUrlRouteProps | RouterBucketRouteProps;

export interface RouterProps {
  /**
   * Optional custom domain managed through Route 53. A string is shorthand
   * for `{ name }`; `null` explicitly clears a previously set domain.
   */
  domain?: string | WebsiteStandaloneDomainProps | null;
  /**
   * Serve the Router at its CloudFront default domain
   * (`https://dxxxx.cloudfront.net`). The default domain cannot be removed
   * from a distribution, so `false` is emulated at the edge: the Router's
   * viewer-request CloudFront Function 301s requests that arrive on the
   * default domain to `https://<domain.name>` (path and query preserved),
   * and the default domain is excluded from the `urls` output.
   *
   * Requires `domain` when `false` (the Router would be unreachable).
   * @default true
   */
  cloudfrontUrl?: boolean;
  /**
   * Optional inline routes keyed by path pattern.
   * Sites register lazily via the KV store; inline routes are for
   * URL-based or bucket-based origins that aren't managed by StaticSite.
   */
  routes?: Record<string, RouterRoute>;
  /**
   * Optional edge behavior shared by the router's default behavior.
   */
  edge?: WebsiteEdgeProps;
  /**
   * Optional invalidation behavior for route updates.
   * @default false
   */
  invalidation?: false | WebsiteInvalidationProps;
  /**
   * User-defined tags applied to created resources.
   */
  tags?: Record<string, string>;
}

/**
 * Route targets returned by `SsrSite` for composition with
 * `AWS.Website.Router` (used with `cdn: false`).
 */
export interface SsrSiteRouteTargets {
  /**
   * URL route pointing at the dynamic server origin.
   */
  server: RouterUrlRouteProps;
  /**
   * Optional bucket route for the static asset origin.
   */
  assets?: {
    /**
     * Path pattern the assets should be served under (e.g. `/_assets/*`).
     */
    pattern: string;
    /**
     * S3 bucket route for the assets, including the OAC and version token.
     */
    route: RouterBucketRouteProps;
  };
}

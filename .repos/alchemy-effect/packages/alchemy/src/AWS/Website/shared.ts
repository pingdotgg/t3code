import type { Input } from "../../Input.ts";
import type { Bucket } from "../S3/Bucket.ts";

export interface WebsiteDomainProps {
  /**
   * Primary domain name for the website or router.
   */
  name: string;
  /**
   * Hosted zone used for Route 53 automation.
   */
  hostedZoneId?: string;
  /**
   * Additional aliases that should point at the same distribution.
   */
  aliases?: string[];
  /**
   * Optional aliases that should redirect to the primary domain.
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
}

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

export interface StaticSiteRouterProps {
  /**
   * Optional path prefix used when composing with `AWS.Website.Router`.
   * This is metadata only; `StaticSite` still returns `routeTarget` for
   * explicit router composition.
   * @default "/"
   */
  path?: string;
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

export type RouterRoute = string | RouterUrlRouteProps | RouterBucketRouteProps;

export interface RouterProps {
  /**
   * Optional custom domain managed through Route 53.
   */
  domain?: WebsiteDomainProps;
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

export type StaticSiteRouteTarget = RouterBucketRouteProps;

export interface SsrSiteRouteTargets {
  server: RouterUrlRouteProps;
  assets?: {
    pattern: string;
    route: RouterBucketRouteProps;
  };
}

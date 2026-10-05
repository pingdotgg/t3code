import * as siteVerification from "@distilled.cloud/gcp/siteVerification_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  DEFAULT_SITE_TYPE,
  defaultVerificationMethod,
  deleteWebResource,
  findWebResource,
  getWebResource,
  getWebResourceToken,
  hasOwnershipMarker,
  listWebResources,
  sameOwners,
  sameText,
  sortedOwners,
  toGeneratedIdentifier,
  toPathId,
  type SiteType,
  type VerificationMethod,
} from "./internal.ts";

export type { SiteType, VerificationMethod };
export { getWebResourceToken };

export type WebResourceProps = {
  /**
   * Site or domain identifier. For `SITE`, a URL such as
   * `https://www.example.com/`. For `INET_DOMAIN`, a domain name such
   * as `example.com`. If omitted, a unique hostname under
   * `alchemy-site-verification.test` is generated from the stack,
   * stage, and logical id so `list` / nuke can find it. Immutable —
   * changing it replaces the web resource.
   */
  identifier?: string;
  /**
   * Resource type. `SITE` is a URL; `INET_DOMAIN` is a domain.
   * Immutable — changing it replaces the web resource.
   * @default "SITE"
   */
  siteType?: SiteType;
  /**
   * Verification method Google should check when inserting the
   * resource. Must match the token previously placed on the site
   * (from {@link getWebResourceToken}). Sites use `FILE`, `META`,
   * `ANALYTICS`, or `TAG_MANAGER`. Domains use `DNS_TXT` or
   * `DNS_CNAME`. Create-only — Google does not store it after
   * verification.
   * @default "FILE" for SITE, "DNS_TXT" for INET_DOMAIN
   */
  verificationMethod?: VerificationMethod;
  /**
   * Email addresses of verified owners. The authenticated user is
   * always an owner after a successful insert. Omitted means leave
   * the owner list unchanged on update. Replacing the list in place
   * notifies every owner by email.
   */
  owners?: string[];
};

export type WebResource = Resource<
  "GCP.SiteVerification.WebResource",
  WebResourceProps,
  {
    /**
     * API id for get / update / delete. Google returns this
     * percent-encoded (`http%3A%2F%2F…`).
     */
    webResourceId: string;
    /** Project id used when the resource was reconciled. */
    project: string;
    /** Site or domain identifier as stored by Google. */
    identifier: string;
    /** `SITE` or `INET_DOMAIN`. */
    siteType: string;
    /**
     * Verification method used on insert, if known. The API does not
     * return this after create.
     */
    verificationMethod: string | undefined;
    /** Email addresses of verified owners. */
    owners: string[];
  },
  never,
  Providers
>;

/**
 * A Google Site Verification web resource (verified site or domain).
 *
 * Site Verification has no labels or description field, so Alchemy
 * stamps ownership into generated identifiers under
 * `alchemy-site-verification.test` for `list` / nuke. User-provided
 * identifiers are identity — they are not rewritten — and are not
 * listed for nuke unless they contain that host. `identifier` and
 * `siteType` are identity (changing either replaces the resource).
 * `owners` update in place via `webResource.update`.
 *
 * Place the verification token from {@link getWebResourceToken} on
 * the site or domain before the first reconcile. Insert checks that
 * token; it fails with `BadRequest` if Google cannot find it. Creating
 * web resources as a service account requires a user OAuth token with
 * the `https://www.googleapis.com/auth/siteverification` scope (or
 * domain-wide delegation).
 *
 * ### Creating a Web Resource
 * **Example:** Verify a site with a FILE token
 * ```typescript
 * const token = yield* GCP.SiteVerification.getWebResourceToken({
 *   identifier: "https://www.example.com/",
 *   siteType: "SITE",
 *   verificationMethod: "FILE",
 * });
 * // Place token.token as a file at the site root, then:
 * const site = yield* GCP.SiteVerification.WebResource("Docs", {
 *   identifier: "https://www.example.com/",
 *   siteType: "SITE",
 *   verificationMethod: "FILE",
 * });
 * ```
 *
 * **Example:** Verify a domain with DNS TXT
 * ```typescript
 * const token = yield* GCP.SiteVerification.getWebResourceToken({
 *   identifier: "example.com",
 *   siteType: "INET_DOMAIN",
 *   verificationMethod: "DNS_TXT",
 * });
 * const domain = yield* GCP.SiteVerification.WebResource("Apex", {
 *   identifier: "example.com",
 *   siteType: "INET_DOMAIN",
 *   verificationMethod: "DNS_TXT",
 * });
 * ```
 *
 * ### Updating Owners
 * Re-declare the same logical id with changed props; the engine keeps the
 * physical resource and updates it in place.
 *
 * **Example:** Delegate a co-owner
 * ```typescript
 * const site = yield* GCP.SiteVerification.WebResource("Docs", {
 *   identifier: "https://www.example.com/",
 *   siteType: "SITE",
 *   owners: ["admin@example.com", "teammate@example.com"],
 * });
 * ```
 *
 * @resource
 * @category SiteVerification
 */
export const WebResource = Resource<WebResource>(
  "GCP.SiteVerification.WebResource",
);

export class WebResourceNotResolved extends Data.TaggedError(
  "GCP.SiteVerification.WebResourceNotResolved",
)<{
  identifier: string;
  siteType: string;
}> {}

const toAttrs = (
  resource: siteVerification.SiteVerificationWebResourceResource,
  project: string,
  verificationMethod: string | undefined,
) => ({
  webResourceId: resource.id ?? toPathId(resource.site?.identifier),
  project,
  identifier: resource.site?.identifier ?? "",
  siteType: resource.site?.type ?? DEFAULT_SITE_TYPE,
  verificationMethod,
  owners: sortedOwners(resource.owners),
});

const desiredSiteType = (
  news: WebResourceProps,
  current: siteVerification.SiteVerificationWebResourceResource | undefined,
  outputType: string | undefined,
) => news.siteType ?? current?.site?.type ?? outputType ?? DEFAULT_SITE_TYPE;

const desiredMethod = (
  news: WebResourceProps,
  siteType: string,
  outputMethod: string | undefined,
) =>
  news.verificationMethod ??
  outputMethod ??
  defaultVerificationMethod(siteType);

export const WebResourceProvider = () =>
  Provider.succeed(WebResource, {
    stables: ["webResourceId", "project", "identifier", "siteType"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousType = olds?.siteType ?? output?.siteType;
      if (
        previousType !== undefined &&
        news.siteType !== undefined &&
        news.siteType !== previousType
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.identifier ?? output?.identifier;
      if (
        previousId !== undefined &&
        news.identifier !== undefined &&
        !sameText(news.identifier, previousId) &&
        !sameText(
          news.identifier.endsWith("/")
            ? news.identifier
            : `${news.identifier}/`,
          previousId,
        )
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const siteType = olds?.siteType ?? output?.siteType ?? DEFAULT_SITE_TYPE;
      const identifier = yield* toGeneratedIdentifier(
        id,
        siteType,
        olds?.identifier,
        output?.identifier,
      );
      let existing = yield* getWebResource(output?.webResourceId);
      const foundById = existing !== undefined;
      if (existing === undefined) {
        existing = yield* findWebResource(identifier, siteType);
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(
        existing,
        env.project,
        olds?.verificationMethod ?? output?.verificationMethod,
      );
      return foundById || hasOwnershipMarker(existing.site?.identifier)
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listWebResources();
        return items
          .filter((item) => hasOwnershipMarker(item.site?.identifier))
          .map((item) => toAttrs(item, env.project, undefined));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const siteType = desiredSiteType(news, undefined, output?.siteType);
      const identifier = yield* toGeneratedIdentifier(
        id,
        siteType,
        news.identifier,
        output?.identifier,
      );
      const verificationMethod = desiredMethod(
        news,
        siteType,
        output?.verificationMethod,
      );

      let current = yield* getWebResource(output?.webResourceId);
      if (current === undefined) {
        current = yield* findWebResource(identifier, siteType);
      }

      if (current === undefined) {
        const created = yield* siteVerification
          .insertWebResource({
            verificationMethod,
            body: {
              site: { identifier, type: siteType },
              owners: news.owners,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findWebResource(identifier, siteType),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new WebResourceNotResolved({ identifier, siteType });
      }

      if (
        news.owners !== undefined &&
        !sameOwners(current.owners, news.owners)
      ) {
        const pathId = toPathId(current.id ?? output?.webResourceId);
        current = yield* siteVerification.updateWebResource({
          id: pathId,
          body: {
            site: {
              identifier: current.site?.identifier ?? identifier,
              type: current.site?.type ?? siteType,
            },
            owners: sortedOwners(news.owners),
          },
        });
      }

      return toAttrs(current, env.project, verificationMethod);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* deleteWebResource(output.webResourceId);
    }),
  });

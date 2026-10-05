import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { orgIdOf, orgParent } from "./ownership.ts";

const MAX_TITLE_LENGTH = 255;

export type SitesApidocProps = {
  /**
   * Portal site id (the `{site}` segment of
   * `organizations/{org}/sites/{site}`). Required. Immutable — changing
   * it replaces the catalog item.
   */
  siteId: string;
  /**
   * Name of the backing API product. Required and immutable — a portal
   * may have only one catalog item per API product. Changing it replaces
   * the catalog item.
   */
  apiProductName: string;
  /**
   * Apigee organization id. Defaults to the stack GCP project. Immutable —
   * changing it replaces the catalog item.
   */
  organization?: string;
  /**
   * Server-assigned catalog item id. Set when adopting an existing item.
   * Immutable — changing it replaces the catalog item.
   */
  apiDocId?: string;
  /**
   * User-facing catalog title. Max 255 characters. If omitted, a unique
   * title is generated from the stack, stage, and logical id.
   */
  title?: string;
  /**
   * Catalog item description shown on the portal (max 10,000
   * characters).
   */
  description?: string;
  /**
   * When true, the catalog item is published to the portal.
   * @default false
   */
  published?: boolean;
  /**
   * When true, anonymous users may view the catalog item.
   * @default false
   */
  anonAllowed?: boolean;
  /**
   * When true, a callback URL is required when the API product is enabled
   * in a developer app.
   * @default false
   */
  requireCallbackUrl?: boolean;
  /**
   * Image URL or portal file path shown in the catalog.
   */
  imageUrl?: string;
  /**
   * IDs of API categories this catalog item belongs to.
   */
  categoryIds?: string[];
};

export type SitesApidoc = Resource<
  "GCP.Apigee.SitesApidoc",
  SitesApidocProps,
  {
    /** Full resource name `organizations/{org}/sites/{site}/apidocs/{id}`. */
    name: string;
    /** Server-assigned catalog item id. */
    apiDocId: string;
    /** Apigee organization id. */
    organization: string;
    /** Portal site id. */
    siteId: string;
    /** Backing API product name. */
    apiProductName: string;
    /** User-facing title. */
    title: string;
    /** Catalog item description. */
    description: string | undefined;
    /** Whether the catalog item is published. */
    published: boolean;
    /** Whether anonymous users may view the item. */
    anonAllowed: boolean;
    /** Whether a callback URL is required. */
    requireCallbackUrl: boolean;
    /** Catalog image URL, if set. */
    imageUrl: string | undefined;
    /** Category ids. */
    categoryIds: string[];
    /** Last-modified time in milliseconds since epoch. */
    modified: string | undefined;
  },
  never,
  Providers
>;

/**
 * An Apigee integrated-portal catalog item (`apidoc`). Catalog items
 * present API documentation and link a portal to a backing API product.
 *
 * API docs have no labels field and every text field is shown to portal
 * users, so Alchemy finds its item by API product: `read` reports an item
 * as owned only when it carries the generated title (an explicit `title`
 * is reported as unowned — adopt it with `--adopt`), and nuke cannot
 * discover items. `siteId`, `organization`, and
 * `apiProductName` are identity — changing any of them replaces the item.
 * Title, description, publish flags, image, and categories update in
 * place.
 *
 * ### Creating a Catalog Item
 * **Example:** Draft item for an API product
 * ```typescript
 * const doc = yield* GCP.Apigee.SitesApidoc("Checkout", {
 *   siteId: portal.siteId,
 *   apiProductName: product.name,
 *   title: "Checkout API",
 *   description: "place orders",
 * });
 * ```
 *
 * ### Updating a Catalog Item
 * **Example:** Publish and recategorize
 * ```typescript
 * const doc = yield* GCP.Apigee.SitesApidoc("Checkout", {
 *   siteId: portal.siteId,
 *   apiProductName: product.name,
 *   title: "Checkout API",
 *   description: "place orders",
 *   published: true,
 *   categoryIds: [payments.categoryId],
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const SitesApidoc = Resource<SitesApidoc>("GCP.Apigee.SitesApidoc");

export class SitesApidocNotResolved extends Data.TaggedError(
  "GCP.Apigee.SitesApidocNotResolved",
)<{
  name: string;
}> {}

const siteParent = (org: string, siteId: string) =>
  `${orgParent(org)}/sites/${siteId}`;

const resourceName = (org: string, siteId: string, apiDocId: string) =>
  `${siteParent(org, siteId)}/apidocs/${apiDocId}`;

const toTitle = (id: string, title: string | undefined, existing?: string) =>
  Effect.gen(function* () {
    if (title !== undefined) return title.slice(0, MAX_TITLE_LENGTH);
    if (existing !== undefined) return existing.slice(0, MAX_TITLE_LENGTH);
    return (yield* createPhysicalName({
      id,
      maxLength: MAX_TITLE_LENGTH,
      lowercase: true,
    })).slice(0, MAX_TITLE_LENGTH);
  });

const unwrap = (
  response: apigee.GoogleCloudApigeeV1ApiDocResponse | undefined,
): apigee.GoogleCloudApigeeV1ApiDoc | undefined => response?.data;

const categoryIdsOf = (ids: ReadonlyArray<string> | undefined) =>
  [...(ids ?? [])].filter((id) => id.length > 0).sort();

const sameIds = (
  left: ReadonlyArray<string> | undefined,
  right: ReadonlyArray<string> | undefined,
) =>
  JSON.stringify(categoryIdsOf(left)) === JSON.stringify(categoryIdsOf(right));

const toAttrs = (
  doc: apigee.GoogleCloudApigeeV1ApiDoc,
  org: string,
  siteId: string,
) => {
  const apiDocId = doc.id ?? "";
  return {
    name: apiDocId ? resourceName(org, siteId, apiDocId) : "",
    apiDocId,
    organization: org,
    siteId: doc.siteId ?? siteId,
    apiProductName: doc.apiProductName ?? "",
    title: doc.title ?? "",
    description: doc.description,
    published: doc.published === true,
    anonAllowed: doc.anonAllowed === true,
    requireCallbackUrl: doc.requireCallbackUrl === true,
    imageUrl: doc.imageUrl,
    categoryIds: categoryIdsOf(doc.categoryIds),
    modified: doc.modified,
  };
};

const getByName = (name: string) =>
  apigee.getOrganizationsSitesApidocs({ name }).pipe(
    Effect.map((response) => unwrap(response)),
    Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const listBySite = (org: string, siteId: string) =>
  apigee.listOrganizationsSitesApidocs
    .pages({
      parent: siteParent(org, siteId),
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.data ?? [])),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed([]),
      ),
    );

const findByProduct = (org: string, siteId: string, apiProductName: string) =>
  listBySite(org, siteId).pipe(
    Effect.map((docs) =>
      docs.find((doc) => doc.apiProductName === apiProductName),
    ),
  );

const toBody = (
  news: SitesApidocProps,
  title: string,
  description: string | undefined,
): apigee.GoogleCloudApigeeV1ApiDoc => ({
  apiProductName: news.apiProductName,
  title,
  description,
  published: news.published === true ? true : undefined,
  anonAllowed: news.anonAllowed === true ? true : undefined,
  requireCallbackUrl: news.requireCallbackUrl === true ? true : undefined,
  imageUrl: news.imageUrl,
  categoryIds: news.categoryIds,
});

export const SitesApidocProvider = () =>
  Provider.succeed(SitesApidoc, {
    stables: ["name", "apiDocId", "organization", "siteId", "apiProductName"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousSite = olds?.siteId ?? output?.siteId;
      const siteChanged =
        previousSite !== undefined && news.siteId !== previousSite;
      const previousOrg = olds?.organization ?? output?.organization;
      const orgChanged =
        previousOrg !== undefined &&
        news.organization !== undefined &&
        orgIdOf(news.organization, previousOrg) !== previousOrg;
      const previousProduct = olds?.apiProductName ?? output?.apiProductName;
      const productChanged =
        previousProduct !== undefined &&
        news.apiProductName !== previousProduct;
      const previousId = olds?.apiDocId ?? output?.apiDocId;
      const idChanged =
        previousId !== undefined &&
        news.apiDocId !== undefined &&
        news.apiDocId !== previousId;
      if (siteChanged || orgChanged || productChanged || idChanged) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const org = orgIdOf(
        olds?.organization ?? output?.organization,
        env.project,
      );
      const siteId = olds?.siteId ?? output?.siteId;
      if (siteId === undefined) return undefined;
      const apiDocId = olds?.apiDocId ?? output?.apiDocId;
      const apiProductName = olds?.apiProductName ?? output?.apiProductName;
      const name =
        output?.name ??
        (apiDocId !== undefined
          ? resourceName(org, siteId, apiDocId)
          : undefined);
      const existing =
        name !== undefined
          ? yield* getByName(name)
          : apiProductName !== undefined
            ? yield* findByProduct(org, siteId, apiProductName)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, org, siteId);
      const generated = yield* toTitle(id, undefined);
      return attrs.title === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const org = orgIdOf(
        news.organization ?? output?.organization,
        env.project,
      );
      const siteId = news.siteId;
      const title = yield* toTitle(id, news.title, output?.title);
      const desiredDescription = news.description;

      let current =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : news.apiDocId !== undefined
            ? yield* getByName(resourceName(org, siteId, news.apiDocId))
            : yield* findByProduct(org, siteId, news.apiProductName);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsSitesApidocs({
            parent: siteParent(org, siteId),
            body: toBody(news, title, desiredDescription),
          })
          .pipe(
            Effect.map((response) => unwrap(response)),
            Effect.catchTag("Conflict", () =>
              findByProduct(org, siteId, news.apiProductName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined || !(current.id ?? "").length) {
        return yield* new SitesApidocNotResolved({
          name: siteParent(org, siteId),
        });
      }

      const desiredPublished = news.published === true;
      const desiredAnon = news.anonAllowed === true;
      const desiredCallback = news.requireCallbackUrl === true;
      const changed =
        (current.title ?? "") !== title ||
        (current.description ?? "") !== (desiredDescription ?? "") ||
        (current.published === true) !== desiredPublished ||
        (current.anonAllowed === true) !== desiredAnon ||
        (current.requireCallbackUrl === true) !== desiredCallback ||
        (current.imageUrl ?? "") !== (news.imageUrl ?? "") ||
        !sameIds(current.categoryIds, news.categoryIds);

      if (changed) {
        const updated = yield* apigee.updateOrganizationsSitesApidocs({
          name: resourceName(org, siteId, current.id ?? ""),
          body: toBody(news, title, desiredDescription),
        });
        current = unwrap(updated) ?? current;
      }

      return toAttrs(current, org, siteId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsSitesApidocs({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });

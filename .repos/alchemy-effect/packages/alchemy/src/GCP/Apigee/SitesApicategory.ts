import * as apigee from "@distilled.cloud/gcp/apigee_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { orgIdOf, orgParent } from "./ownership.ts";

const MAX_NAME_LENGTH = 255;

export type SitesApicategoryProps = {
  /**
   * Portal site id (the `{site}` segment of
   * `organizations/{org}/sites/{site}`). Required. Immutable — changing
   * it replaces the category.
   */
  siteId: string;
  /**
   * Apigee organization id. Defaults to the stack GCP project. Immutable —
   * changing it replaces the category.
   */
  organization?: string;
  /**
   * Server-assigned category UUID. Set when adopting an existing category.
   * Immutable — changing it replaces the category.
   */
  categoryId?: string;
  /**
   * User-facing category name shown on the portal. If omitted, a unique
   * name is generated from the stack, stage, and logical id.
   */
  name?: string;
};

export type SitesApicategory = Resource<
  "GCP.Apigee.SitesApicategory",
  SitesApicategoryProps,
  {
    /** Full resource name `organizations/{org}/sites/{site}/apicategories/{id}`. */
    name: string;
    /** Server-assigned category UUID. */
    categoryId: string;
    /** Apigee organization id. */
    organization: string;
    /** Portal site id. */
    siteId: string;
    /** User-facing category name. */
    categoryName: string | undefined;
    /** Last-modified time in milliseconds since epoch. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * An API category on an Apigee integrated portal. Catalog items can be
 * tagged with categories so portal users can browse by topic.
 *
 * API categories have no labels field and the name is shown to portal
 * users, so Alchemy finds its category by name: `read` reports a
 * category as owned only when it carries the generated name (an explicit
 * `name` is reported as unowned — adopt it with `--adopt`), and nuke
 * cannot discover categories. `siteId` and `organization` are identity —
 * changing either replaces the category. The display name updates in
 * place.
 *
 * ### Creating an API Category
 * **Example:** Named category
 * ```typescript
 * const category = yield* GCP.Apigee.SitesApicategory("Payments", {
 *   siteId: portal.siteId,
 *   name: "Payments",
 * });
 * ```
 *
 * ### Updating an API Category
 * **Example:** Rename
 * ```typescript
 * const category = yield* GCP.Apigee.SitesApicategory("Payments", {
 *   siteId: portal.siteId,
 *   name: "Billing",
 * });
 * ```
 *
 * @resource
 * @category Apigee
 */
export const SitesApicategory = Resource<SitesApicategory>(
  "GCP.Apigee.SitesApicategory",
);

export class SitesApicategoryNotResolved extends Data.TaggedError(
  "GCP.Apigee.SitesApicategoryNotResolved",
)<{
  name: string;
}> {}

const siteParent = (org: string, siteId: string) =>
  `${orgParent(org)}/sites/${siteId}`;

const resourceName = (org: string, siteId: string, categoryId: string) =>
  `${siteParent(org, siteId)}/apicategories/${categoryId}`;

const toDisplayName = (
  id: string,
  name: string | undefined,
  existing?: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined) return name;
    if (existing !== undefined) return existing;
    return yield* createPhysicalName({
      id,
      maxLength: MAX_NAME_LENGTH,
      lowercase: true,
    });
  });

const unwrap = (
  response: apigee.GoogleCloudApigeeV1ApiCategoryResponse | undefined,
): apigee.GoogleCloudApigeeV1ApiCategory | undefined => response?.data;

const toAttrs = (
  category: apigee.GoogleCloudApigeeV1ApiCategory,
  org: string,
  siteId: string,
) => {
  const categoryId = category.id ?? "";
  return {
    name: categoryId ? resourceName(org, siteId, categoryId) : "",
    categoryId,
    organization: org,
    siteId: category.siteId ?? siteId,
    categoryName: category.name,
    updateTime: category.updateTime,
  };
};

const getByName = (name: string) =>
  apigee.getOrganizationsSitesApicategories({ name }).pipe(
    Effect.map((response) => unwrap(response)),
    Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
      Effect.succeed(undefined),
    ),
  );

const listBySite = (org: string, siteId: string) =>
  apigee
    .listOrganizationsSitesApicategories({
      parent: siteParent(org, siteId),
    })
    .pipe(
      Effect.map((page) => page.data ?? []),
      Effect.catchTag(["NotFound", "ApigeeResourceNotFound"], () =>
        Effect.succeed([]),
      ),
    );

const findByDisplayName = (org: string, siteId: string, displayName: string) =>
  listBySite(org, siteId).pipe(
    Effect.map((categories) =>
      categories.find((category) => category.name === displayName),
    ),
  );

export const SitesApicategoryProvider = () =>
  Provider.succeed(SitesApicategory, {
    stables: ["name", "categoryId", "organization", "siteId"],

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
      const previousId = olds?.categoryId ?? output?.categoryId;
      const idChanged =
        previousId !== undefined &&
        news.categoryId !== undefined &&
        news.categoryId !== previousId;
      if (siteChanged || orgChanged || idChanged) {
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
      const categoryId = olds?.categoryId ?? output?.categoryId;
      const name =
        output?.name ??
        (categoryId !== undefined
          ? resourceName(org, siteId, categoryId)
          : undefined);
      const generated = yield* toDisplayName(id, undefined);
      const displayName = olds?.name ?? output?.categoryName ?? generated;
      const existing =
        name !== undefined
          ? yield* getByName(name)
          : yield* findByDisplayName(org, siteId, displayName);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, org, siteId);
      return existing.name === generated ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const org = orgIdOf(
        news.organization ?? output?.organization,
        env.project,
      );
      const siteId = news.siteId;
      const displayName = yield* toDisplayName(
        id,
        news.name,
        output?.categoryName,
      );
      const desiredName = displayName;

      let current =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : news.categoryId !== undefined
            ? yield* getByName(resourceName(org, siteId, news.categoryId))
            : yield* findByDisplayName(org, siteId, desiredName);

      if (current === undefined) {
        const created = yield* apigee
          .createOrganizationsSitesApicategories({
            parent: siteParent(org, siteId),
            body: {
              name: desiredName,
              siteId,
            },
          })
          .pipe(
            Effect.map((response) => unwrap(response)),
            Effect.catchTag("Conflict", () =>
              findByDisplayName(org, siteId, desiredName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined || !(current.id ?? "").length) {
        return yield* new SitesApicategoryNotResolved({
          name: siteParent(org, siteId),
        });
      }

      const resource = resourceName(org, siteId, current.id ?? "");
      if ((current.name ?? "") !== desiredName) {
        const patched = yield* apigee.patchOrganizationsSitesApicategories({
          name: resource,
          body: {
            name: desiredName,
            siteId,
            id: current.id,
          },
        });
        current = unwrap(patched) ?? current;
      }

      return toAttrs(current, org, siteId);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* apigee
        .deleteOrganizationsSitesApicategories({ name: output.name })
        .pipe(
          Effect.catchTag(
            ["NotFound", "ApigeeResourceNotFound"],
            () => Effect.void,
          ),
        );
    }),
  });

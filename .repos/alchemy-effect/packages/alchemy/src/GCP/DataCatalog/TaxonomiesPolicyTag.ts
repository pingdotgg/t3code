import * as datacatalog from "@distilled.cloud/gcp/datacatalog_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DatacatalogNotResolved,
  collectPages,
  emptyOnMissing,
  encodeOwnership,
  expandParent,
  findOwned,
  hasOwnershipMarker,
  ignoreGone,
  listAtLocation,
  missingGet,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  retryTransient,
  sameText,
  toDisplayName,
  updateMaskOf,
} from "./internal.ts";
import { isTransientGcpError } from "../Errors.ts";

export type TaxonomiesPolicyTagProps = {
  /**
   * Parent taxonomy. Full name
   * `projects/{project}/locations/{location}/taxonomies/{taxonomy}` or
   * the taxonomy id (combined with `location`). Immutable — changing it
   * replaces the policy tag.
   */
  taxonomy: string;
  /**
   * Location used when `taxonomy` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * User-defined display name. Unique within the taxonomy. Letters,
   * numbers, underscores, dashes, and spaces; max 200 bytes.
   */
  displayName?: string;
  /**
   * Human-readable description (max 2000 bytes). Policy tags have no
   * labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Parent policy tag resource name. Empty for a top-level tag.
   */
  parentPolicyTag?: string;
};

export type TaxonomiesPolicyTag = Resource<
  "GCP.DataCatalog.TaxonomiesPolicyTag",
  TaxonomiesPolicyTagProps,
  {
    /** Full resource name. */
    name: string;
    /** Server-assigned policy tag id (last path segment). */
    policyTagId: string;
    /** Parent taxonomy resource name. */
    taxonomy: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Parent policy tag resource name, if nested. */
    parentPolicyTag: string | undefined;
    /** Child policy tag resource names. */
    childPolicyTags: string[];
  },
  never,
  Providers
>;

/**
 * A Data Catalog policy tag inside a taxonomy.
 *
 * Policy tag ids are assigned by Policy Tag Manager. Taxonomy and parent
 * tag are immutable. Display name and description update in place.
 * Policy tags have no labels; Alchemy stamps ownership into the
 * description so `list` / nuke can find them.
 *
 * ### Creating a Policy Tag
 * **Example:** Top-level tag
 * ```typescript
 * const tag = yield* GCP.DataCatalog.TaxonomiesPolicyTag("Email", {
 *   taxonomy: taxonomy.name,
 *   displayName: "email",
 *   description: "email addresses",
 * });
 * ```
 *
 * @resource
 * @category DataCatalog
 */
export const TaxonomiesPolicyTag = Resource<TaxonomiesPolicyTag>(
  "GCP.DataCatalog.TaxonomiesPolicyTag",
);

const taxonomyOf = (taxonomy: string, project: string, location: string) =>
  expandParent(taxonomy, project, location, "taxonomies");

const toAttrs = (
  tag: datacatalog.GoogleCloudDatacatalogV1PolicyTag,
  project: string,
  region: string,
) => {
  const name = tag.name ?? "";
  const parsed = parseName(name, "policyTags", region);
  const ownership = parseOwnership(tag.description);
  return {
    name,
    policyTagId: parsed.id,
    taxonomy: parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: tag.displayName,
    description: ownership.text,
    parentPolicyTag:
      tag.parentPolicyTag && tag.parentPolicyTag.length > 0
        ? tag.parentPolicyTag
        : undefined,
    childPolicyTags: [...(tag.childPolicyTags ?? [])],
  };
};

const getByName = missingGet(
  datacatalog.getProjectsLocationsTaxonomiesPolicyTags,
);

const listPolicyTagsAt = (
  parent: string,
): Effect.Effect<
  datacatalog.GoogleCloudDatacatalogV1PolicyTag[],
  datacatalog.ListProjectsLocationsTaxonomiesPolicyTagsError,
  datacatalog.GcpOpContext
> =>
  emptyOnMissing(
    collectPages(
      datacatalog.listProjectsLocationsTaxonomiesPolicyTags.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.policyTags,
    ),
  );

const listTaxonomiesAt = (
  parent: string,
): Effect.Effect<
  datacatalog.GoogleCloudDatacatalogV1Taxonomy[],
  datacatalog.ListProjectsLocationsTaxonomiesError,
  datacatalog.GcpOpContext
> =>
  emptyOnMissing(
    collectPages(
      datacatalog.listProjectsLocationsTaxonomies.pages({
        parent,
        pageSize: 1000,
      }),
      (page) => page.taxonomies,
    ),
  );

const observe = (id: string, name: string | undefined, taxonomy: string) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const existing = yield* getByName(name);
      if (existing !== undefined) return existing;
    }
    const candidates = yield* listPolicyTagsAt(taxonomy);
    return yield* findOwned(candidates, id, (item) => item.description);
  });

export const TaxonomiesPolicyTagProvider = () =>
  Provider.succeed(TaxonomiesPolicyTag, {
    stables: ["name", "policyTagId", "taxonomy", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      return replaceOnIdentity({
        previousParent: olds?.taxonomy ?? output?.taxonomy,
        nextParent: taxonomyOf(news.taxonomy, env.project, location),
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: location,
        extra:
          (olds?.parentPolicyTag ?? output?.parentPolicyTag) !== undefined &&
          (news.parentPolicyTag ?? "") !==
            (olds?.parentPolicyTag ?? output?.parentPolicyTag ?? ""),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const taxonomy =
        olds?.taxonomy !== undefined
          ? taxonomyOf(olds.taxonomy, env.project, location)
          : (output?.taxonomy ?? "");
      const existing = yield* observe(id, output?.name, taxonomy);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const taxonomies = yield* listAtLocation(
          env.project,
          env.region,
          listTaxonomiesAt,
        );
        const groups = yield* Effect.forEach(
          taxonomies.filter((item) => (item.name ?? "").length > 0),
          (taxonomy) => listPolicyTagsAt(taxonomy.name!),
          { concurrency: 4 },
        );
        return groups
          .flat()
          .filter((item) => hasOwnershipMarker(item.description))
          .map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const taxonomy = taxonomyOf(news.taxonomy, env.project, location);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const parentPolicyTag = news.parentPolicyTag;

      let current = yield* observe(id, output?.name, taxonomy);

      if (current === undefined) {
        const created = yield* retryTransient(
          datacatalog.createProjectsLocationsTaxonomiesPolicyTags({
            parent: taxonomy,
            body: {
              displayName,
              description,
              parentPolicyTag,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = created ?? (yield* observe(id, undefined, taxonomy));
      }

      if (current === undefined) {
        return yield* new DatacatalogNotResolved({
          name: output?.name ?? `${taxonomy}/policyTags`,
        });
      }

      const currentName = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = (current.description ?? "") !== description;

      if (displayChanged || descriptionChanged) {
        current = yield* retryTransient(
          datacatalog.patchProjectsLocationsTaxonomiesPolicyTags({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              descriptionChanged ? "description" : undefined,
            ),
            body: {
              name: currentName,
              displayName,
              description,
              parentPolicyTag,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreGone(
        datacatalog
          .deleteProjectsLocationsTaxonomiesPolicyTags({
            name: output.name,
          })
          .pipe(
            Effect.retry({
              while: (error) =>
                error._tag === "Conflict" || isTransientGcpError(error),
              times: 8,
              schedule: Schedule.exponential("500 millis"),
            }),
          ),
      );
    }),
  });

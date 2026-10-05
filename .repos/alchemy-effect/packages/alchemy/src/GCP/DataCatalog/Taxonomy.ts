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
  findOwned,
  hasOwnershipMarker,
  ignoreGone,
  listAtLocation,
  locationParent,
  missingGet,
  normalizeLocation,
  ownedByAlchemy,
  parseName,
  parseOwnership,
  replaceOnIdentity,
  retryTransient,
  sameStringList,
  sameText,
  toDisplayName,
  updateMaskOf,
  type TaxonomyActivatedPolicyType,
} from "./internal.ts";
import { isTransientGcpError } from "../Errors.ts";

export type { TaxonomyActivatedPolicyType };

export type TaxonomyProps = {
  /**
   * Region (`us-central1`, `us`, …). Immutable — changing it replaces
   * the taxonomy. Policy Tag Manager assigns the taxonomy id; it is not
   * chosen by the caller.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * User-defined display name. Unique within an organization. Letters,
   * numbers, underscores, dashes, and spaces; max 200 bytes. If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   */
  displayName?: string;
  /**
   * Human-readable description (max 2000 bytes). Taxonomies have no
   * labels field, so Alchemy ownership is stored in a `[alchemy …]`
   * prefix and stripped from attributes.
   */
  description?: string;
  /**
   * Policy types activated on this taxonomy
   * (`FINE_GRAINED_ACCESS_CONTROL`).
   */
  activatedPolicyTypes?: TaxonomyActivatedPolicyType[];
};

export type Taxonomy = Resource<
  "GCP.DataCatalog.Taxonomy",
  TaxonomyProps,
  {
    /** Full resource name. */
    name: string;
    /** Server-assigned taxonomy id (last path segment). */
    taxonomyId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description (Alchemy ownership marker stripped). */
    description: string | undefined;
    /** Activated policy types. */
    activatedPolicyTypes: string[];
    /** Number of policy tags in this taxonomy. */
    policyTagCount: number | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Data Catalog taxonomy — a hierarchy of policy tags used to classify
 * data (for example PII vs financials).
 *
 * Taxonomy ids are assigned by Policy Tag Manager. Location is
 * immutable. Display name, description, and activated policy types
 * update in place. Taxonomies have no labels; Alchemy stamps
 * `alchemy-stack` / `alchemy-stage` / `alchemy-id` into the description
 * so `list` and `pnpm nuke:gcp` can identify owned taxonomies.
 *
 * ### Creating a Taxonomy
 * **Example:** Generated display name
 * ```typescript
 * const taxonomy = yield* GCP.DataCatalog.Taxonomy("Pii", {
 *   description: "sensitivity classes",
 * });
 * ```
 *
 * **Example:** Fine-grained access control
 * ```typescript
 * const taxonomy = yield* GCP.DataCatalog.Taxonomy("Pii", {
 *   displayName: "PII",
 *   activatedPolicyTypes: ["FINE_GRAINED_ACCESS_CONTROL"],
 * });
 * ```
 *
 * ### Updating a Taxonomy
 * **Example:** Description
 * ```typescript
 * // Same logical id, changed props: the engine updates it in place.
 * const taxonomy = yield* GCP.DataCatalog.Taxonomy("Pii", {
 *   displayName: "PII",
 *   description: "sensitivity classes v2",
 *   activatedPolicyTypes: ["FINE_GRAINED_ACCESS_CONTROL"],
 * });
 * ```
 *
 * @resource
 * @category DataCatalog
 */
export const Taxonomy = Resource<Taxonomy>("GCP.DataCatalog.Taxonomy");

const toAttrs = (
  taxonomy: datacatalog.GoogleCloudDatacatalogV1Taxonomy,
  project: string,
  region: string,
) => {
  const name = taxonomy.name ?? "";
  const parsed = parseName(name, "taxonomies", region);
  const ownership = parseOwnership(taxonomy.description);
  return {
    name,
    taxonomyId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    displayName: taxonomy.displayName,
    description: ownership.text,
    activatedPolicyTypes: [...(taxonomy.activatedPolicyTypes ?? [])],
    policyTagCount: taxonomy.policyTagCount,
    createTime: taxonomy.taxonomyTimestamps?.createTime,
    updateTime: taxonomy.taxonomyTimestamps?.updateTime,
  };
};

const getByName = missingGet(datacatalog.getProjectsLocationsTaxonomies);

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

const listOwned = (project: string, region: string) =>
  listAtLocation(project, region, listTaxonomiesAt).pipe(
    Effect.map((items) =>
      items.filter((item) => hasOwnershipMarker(item.description)),
    ),
  );

const observe = (
  id: string,
  name: string | undefined,
  project: string,
  location: string,
) =>
  Effect.gen(function* () {
    if (name !== undefined && name.length > 0) {
      const existing = yield* getByName(name);
      if (existing !== undefined) return existing;
    }
    const candidates = yield* listTaxonomiesAt(
      locationParent(project, location),
    );
    return yield* findOwned(candidates, id, (item) => item.description);
  });

export const TaxonomyProvider = () =>
  Provider.succeed(Taxonomy, {
    stables: ["name", "taxonomyId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const existing = yield* observe(id, output?.name, env.project, location);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, env.region);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const items = yield* listOwned(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project, env.region));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const parent = locationParent(env.project, location);
      const ownership = yield* createInternalLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const activatedPolicyTypes = news.activatedPolicyTypes;

      let current = yield* observe(id, output?.name, env.project, location);

      if (current === undefined) {
        const created = yield* retryTransient(
          datacatalog.createProjectsLocationsTaxonomies({
            parent,
            body: {
              displayName,
              description,
              activatedPolicyTypes,
            },
          }),
        ).pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current =
          created ?? (yield* observe(id, undefined, env.project, location));
      }

      if (current === undefined) {
        return yield* new DatacatalogNotResolved({
          name: output?.name ?? `${parent}/taxonomies`,
        });
      }

      const currentName = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = (current.description ?? "") !== description;
      const policyChanged =
        activatedPolicyTypes !== undefined &&
        !sameStringList(current.activatedPolicyTypes, activatedPolicyTypes);

      if (displayChanged || descriptionChanged || policyChanged) {
        current = yield* retryTransient(
          datacatalog.patchProjectsLocationsTaxonomies({
            name: currentName,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              descriptionChanged ? "description" : undefined,
              policyChanged ? "activated_policy_types" : undefined,
            ),
            body: {
              name: currentName,
              displayName,
              description,
              activatedPolicyTypes,
            },
          }),
        );
      }

      return toAttrs(current, env.project, env.region);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* ignoreGone(
        datacatalog
          .deleteProjectsLocationsTaxonomies({ name: output.name })
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

import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  DataplexNotResolved,
  collectPages,
  expandParent,
  hasAlchemyLabelMap,
  lastSegment,
  listAtLocation,
  normalizeLocation,
  parseName,
  replaceOnIdentity,
  retryQuota,
  toPhysicalId,
  userLabels,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type GlossariesCategoryProps = {
  /**
   * Parent Glossary. Full name
   * `projects/{project}/locations/{location}/glossaries/{glossary}` or
   * the glossary id (combined with `location`). Immutable — changing it
   * replaces the category.
   */
  glossary: string;
  /**
   * Category id (the `{category}` segment of
   * `.../glossaries/{glossary}/categories/{category}`). If omitted, a
   * unique name is generated from the stack, stage, and logical id.
   * Must be 1-63 characters, start with a letter, and match
   * `[a-z]([a-z0-9-]*[a-z0-9])?`. Immutable — changing it replaces the
   * category.
   */
  categoryId?: string;
  /**
   * Region used when `glossary` is a bare id. Immutable — changing it
   * replaces the category.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Immediate parent in the glossary hierarchy — the glossary itself
   * or another category. Defaults to the parent glossary.
   */
  parent?: string;
  /**
   * Human-readable description.
   */
  description?: string;
  /**
   * User-friendly display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type GlossariesCategory = Resource<
  "GCP.Dataplex.GlossariesCategory",
  GlossariesCategoryProps,
  {
    /** Full resource name. */
    name: string;
    /** Category id (last path segment). */
    categoryId: string;
    /** Parent glossary resource name. */
    glossary: string;
    /** Parent glossary id. */
    glossaryId: string;
    /** Immediate hierarchy parent. */
    parent: string | undefined;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-provided description. */
    description: string | undefined;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** System-generated uid. */
    uid: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataplex Glossary Category nested under a Glossary.
 *
 * Changing `categoryId`, `glossary`, or `location` replaces the
 * category. Description, display name, labels, and hierarchy `parent`
 * update in place.
 *
 * ### Creating a Glossary Category
 * **Example:** Category under a glossary
 * ```typescript
 * const category = yield* GCP.Dataplex.GlossariesCategory("Finance", {
 *   glossary: glossary.name,
 *   displayName: "Finance",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Glossary Category
 * **Example:** Description and labels
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const category = yield* GCP.Dataplex.GlossariesCategory("Finance", {
 *   glossary: glossary.name,
 *   description: "finance terms",
 *   labels: { env: "prod", team: "data" },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const GlossariesCategory = Resource<GlossariesCategory>(
  "GCP.Dataplex.GlossariesCategory",
);

const resolveParent = (
  project: string,
  glossary: string,
  location: string | undefined,
  defaultLocation: string,
) => {
  const parent = expandParent(
    glossary,
    project,
    normalizeLocation(location, defaultLocation),
    "glossaries",
  );
  const parsed = parseName(`${parent}/categories/_`, "categories");
  return {
    parent: parsed.parent,
    location: parsed.location,
    project: parsed.project || project,
    glossaryId: lastSegment(parsed.parent),
  };
};

const resourceName = (parent: string, categoryId: string) =>
  `${parent}/categories/${categoryId}`;

const toAttrs = (
  category: dataplex.GoogleCloudDataplexV1GlossaryCategory,
  project: string,
) => {
  const name = category.name ?? "";
  const parsed = parseName(name, "categories");
  const glossary = parseName(parsed.parent, "glossaries");
  return {
    name,
    categoryId: parsed.id,
    glossary: parsed.parent,
    glossaryId: glossary.id,
    parent: category.parent,
    project: parsed.project || project,
    location: parsed.location,
    description: category.description,
    displayName: category.displayName,
    labels: userLabels(category.labels),
    uid: category.uid,
    createTime: category.createTime,
    updateTime: category.updateTime,
  };
};

const getByName = (name: string) =>
  retryQuota(dataplex.getProjectsLocationsGlossariesCategories({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listCategoriesUnder = (parent: string, project: string) =>
  collectPages(
    dataplex.listProjectsLocationsGlossariesCategories.pages({
      parent,
      pageSize: 1000,
    }),
    (page) => page.categories,
  ).pipe(
    Effect.map((items) =>
      items
        .filter((item) => hasAlchemyLabelMap(item.labels))
        .map((item) => toAttrs(item, project)),
    ),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

export const GlossariesCategoryProvider = () =>
  Provider.succeed(GlossariesCategory, {
    stables: [
      "name",
      "categoryId",
      "glossary",
      "glossaryId",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.categoryId ?? output?.categoryId,
        nextId: news.categoryId ?? olds?.categoryId ?? output?.categoryId,
        previousLocation: normalizeLocation(
          olds?.location ?? output?.location,
          env.region,
        ),
        nextLocation: normalizeLocation(
          news.location ?? olds?.location ?? output?.location,
          env.region,
        ),
        previousParent: olds?.glossary ?? output?.glossary,
        nextParent: news.glossary ?? olds?.glossary ?? output?.glossary,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const resolved = resolveParent(
        env.project,
        olds?.glossary ?? output?.glossary ?? "",
        olds?.location ?? output?.location,
        env.region,
      );
      const categoryId = yield* toPhysicalId(
        id,
        olds?.categoryId,
        output?.categoryId,
        "category",
      );
      const name = output?.name ?? resourceName(resolved.parent, categoryId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const glossaries = yield* listAtLocation(
          env.project,
          env.region,
          (parent) =>
            collectPages(
              dataplex.listProjectsLocationsGlossaries.pages({
                parent,
                pageSize: 1000,
              }),
              (page) => page.glossaries,
            ).pipe(
              Effect.map((items) =>
                items.filter((item) => hasAlchemyLabelMap(item.labels)),
              ),
            ),
        );
        const nested = yield* Effect.forEach(
          glossaries,
          (glossary) =>
            glossary.name
              ? listCategoriesUnder(glossary.name, env.project)
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return nested.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const resolved = resolveParent(
        env.project,
        news.glossary,
        news.location ?? output?.location,
        env.region,
      );
      const categoryId = yield* toPhysicalId(
        id,
        news.categoryId,
        output?.categoryId,
        "category",
      );
      const name = resourceName(resolved.parent, categoryId);
      const hierarchyParent = news.parent ?? resolved.parent;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsGlossariesCategories({
            parent: resolved.parent,
            categoryId,
            body: {
              parent: hierarchyParent,
              description: news.description,
              displayName: news.displayName,
              labels: desiredLabels,
            },
          })
          .pipe(
            retryQuota,
            Effect.catchTag("Conflict", () => getByName(name)),
          );
        current = created ?? undefined;
        if (current === undefined) {
          current = yield* waitUntilExists(getByName(name), name);
        }
      }

      if (current === undefined) {
        return yield* new DataplexNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const parentChanged = (current.parent ?? "") !== hierarchyParent;

      if (
        labelsChanged ||
        descriptionChanged ||
        displayNameChanged ||
        parentChanged
      ) {
        current = yield* retryQuota(
          dataplex.patchProjectsLocationsGlossariesCategories({
            name: current.name ?? name,
            updateMask: [
              labelsChanged ? "labels" : undefined,
              descriptionChanged ? "description" : undefined,
              displayNameChanged ? "displayName" : undefined,
              parentChanged ? "parent" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              parent: hierarchyParent,
              labels: desiredLabels,
              description: news.description,
              displayName: news.displayName,
            },
          }),
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* retryQuota(
        dataplex.deleteProjectsLocationsGlossariesCategories({
          name: output.name,
        }),
      ).pipe(Effect.catchTag("NotFound", () => Effect.void));
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });

import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
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
  hasAlchemyLabelMap,
  listAtLocation,
  normalizeLocation,
  parentOf,
  parseName,
  replaceOnIdentity,
  retryQuota,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

export type GlossaryProps = {
  /**
   * Glossary id (the `{glossary}` segment of
   * `projects/{project}/locations/{location}/glossaries/{glossary}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be 1-63 characters, start with a letter, and match
   * `[a-z]([a-z0-9-]*[a-z0-9])?`. Immutable — changing it replaces the
   * glossary.
   */
  glossaryId?: string;
  /**
   * Region (`us-central1`, `us-east1`, …). Immutable — changing it
   * replaces the glossary. `US-CENTRAL1` is accepted and normalized to
   * `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
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

export type Glossary = Resource<
  "GCP.Dataplex.Glossary",
  GlossaryProps,
  {
    /** Full resource name. */
    name: string;
    /** Glossary id (last path segment). */
    glossaryId: string;
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
    /** Number of terms. */
    termCount: number | undefined;
    /** Number of categories. */
    categoryCount: number | undefined;
    /** Server etag. */
    etag: string | undefined;
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
 * A Dataplex Glossary — a collection of GlossaryCategories and
 * GlossaryTerms.
 *
 * Changing `glossaryId` or `location` replaces the glossary. Description,
 * display name, and labels update in place. Nested categories and terms
 * must be deleted before the glossary.
 *
 * ### Creating a Glossary
 * **Example:** Generated name
 * ```typescript
 * const glossary = yield* GCP.Dataplex.Glossary("BusinessTerms", {});
 * ```
 *
 * **Example:** Explicit id and labels
 * ```typescript
 * const glossary = yield* GCP.Dataplex.Glossary("BusinessTerms", {
 *   glossaryId: "app-glossary",
 *   displayName: "App glossary",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * ### Updating a Glossary
 * **Example:** Description and labels
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const glossary = yield* GCP.Dataplex.Glossary("BusinessTerms", {
 *   glossaryId: "app-glossary",
 *   description: "glossary v2",
 *   labels: { env: "prod", team: "data" },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const Glossary = Resource<Glossary>("GCP.Dataplex.Glossary");

const resourceName = (project: string, location: string, glossaryId: string) =>
  `projects/${project}/locations/${location}/glossaries/${glossaryId}`;

const toAttrs = (
  glossary: dataplex.GoogleCloudDataplexV1Glossary,
  project: string,
) => {
  const name = glossary.name ?? "";
  const parsed = parseName(name, "glossaries");
  return {
    name,
    glossaryId: parsed.id,
    project: parsed.project || project,
    location: parsed.location,
    description: glossary.description,
    displayName: glossary.displayName,
    labels: userLabels(glossary.labels),
    termCount: glossary.termCount,
    categoryCount: glossary.categoryCount,
    etag: glossary.etag,
    uid: glossary.uid,
    createTime: glossary.createTime,
    updateTime: glossary.updateTime,
  };
};

const getByName = (name: string) =>
  retryQuota(dataplex.getProjectsLocationsGlossaries({ name })).pipe(
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listGlossaries = (project: string, region: string) => {
  const collect = (parent: string) =>
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
    );
  return listAtLocation(project, region, collect);
};

export const listAlchemyGlossaries = (project: string, region: string) =>
  listGlossaries(project, region);

export const GlossaryProvider = () =>
  Provider.succeed(Glossary, {
    stables: ["name", "glossaryId", "project", "location", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      return replaceOnIdentity({
        previousId: olds?.glossaryId ?? output?.glossaryId,
        nextId: news.glossaryId ?? olds?.glossaryId ?? output?.glossaryId,
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
      const glossaryId = yield* toPhysicalId(
        id,
        olds?.glossaryId,
        output?.glossaryId,
        "glossary",
      );
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const name =
        output?.name ?? resourceName(env.project, location, glossaryId);
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
        const items = yield* listGlossaries(env.project, env.region);
        return items.map((item) => toAttrs(item, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const glossaryId = yield* toPhysicalId(
        id,
        news.glossaryId,
        output?.glossaryId,
        "glossary",
      );
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const name = resourceName(env.project, location, glossaryId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsGlossaries({
            parent: parentOf(env.project, location),
            glossaryId,
            body: {
              description: news.description,
              displayName: news.displayName,
              labels: desiredLabels,
            },
          })
          .pipe(
            retryQuota,
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
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

      if (labelsChanged || descriptionChanged || displayNameChanged) {
        const operation = yield* retryQuota(
          dataplex.patchProjectsLocationsGlossaries({
            name: current.name ?? name,
            updateMask: [
              labelsChanged ? "labels" : undefined,
              descriptionChanged ? "description" : undefined,
              displayNameChanged ? "displayName" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              etag: current.etag,
              labels: desiredLabels,
              description: news.description,
              displayName: news.displayName,
            },
          }),
        );
        yield* waitForOperation(operation);
        current = yield* waitUntilExists(
          getByName(current.name ?? name),
          current.name ?? name,
        );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const operation = yield* dataplex
        .deleteProjectsLocationsGlossaries({
          name: output.name,
        })
        .pipe(
          Effect.retry({
            while: (error) =>
              error._tag === "Conflict" || error._tag === "TooManyRequests",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
          Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        );
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });

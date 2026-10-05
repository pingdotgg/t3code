import * as dataplex from "@distilled.cloud/gcp/dataplex_v1";
import * as Data from "effect/Data";
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
  expandParent,
  hasAlchemyLabelMap,
  listGlossaries,
  listTerms,
  normalizeLocation,
  parseResourceName,
  replaceIfChanged,
  toPhysicalRfc1035,
  userLabels,
} from "./shared.ts";

export type GlossariesTermProps = {
  /**
   * Parent glossary. Full name
   * `projects/{project}/locations/{location}/glossaries/{glossary}` or the
   * glossary id (combined with `location`). Immutable — changing it
   * replaces the term.
   */
  glossary: string;
  /**
   * Immediate parent in the glossary tree — the glossary itself or a
   * category
   * `.../glossaries/{glossary}/categories/{category}`. Defaults to
   * `glossary`.
   */
  parent?: string;
  /**
   * Region used when `glossary` is a bare id.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * Term id (the `{term}` segment of
   * `.../glossaries/{glossary}/terms/{term}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Immutable —
   * changing it replaces the term.
   */
  termId?: string;
  /**
   * User-friendly display name. Defaults to the term id.
   */
  displayName?: string;
  /**
   * Rich-text description attached to catalog entries.
   */
  description?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
};

export type GlossariesTerm = Resource<
  "GCP.Dataplex.GlossariesTerm",
  GlossariesTermProps,
  {
    /** Full resource name `.../glossaries/{glossary}/terms/{term}`. */
    name: string;
    /** Term id (last path segment). */
    termId: string;
    /** Parent glossary resource name. */
    glossary: string;
    /** Immediate parent (glossary or category). */
    parent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User-friendly display name. */
    displayName: string | undefined;
    /** Description. */
    description: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-assigned uid. */
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
 * A Dataplex glossary term — a defined business concept that can be
 * attached to catalog entries.
 *
 * Changing `glossary`, `termId`, or `location` replaces the term. Display
 * name, description, labels, and immediate parent update in place.
 *
 * ### Creating a Term
 * **Example:** Term under a glossary
 * ```typescript
 * const term = yield* GCP.Dataplex.GlossariesTerm("Customer", {
 *   glossary: glossary.name,
 *   displayName: "Customer",
 *   description: "a paying account",
 *   labels: { env: "dev" },
 * });
 * ```
 *
 * **Example:** Named term
 * ```typescript
 * const term = yield* GCP.Dataplex.GlossariesTerm("Customer", {
 *   glossary: glossary.name,
 *   termId: "customer",
 *   labels: { env: "prod" },
 * });
 * ```
 *
 * @resource
 * @category Dataplex
 */
export const GlossariesTerm = Resource<GlossariesTerm>(
  "GCP.Dataplex.GlossariesTerm",
);

export class GlossariesTermNotResolved extends Data.TaggedError(
  "GCP.Dataplex.GlossariesTermNotResolved",
)<{
  name: string;
}> {}

const glossaryOf = (glossary: string, project: string, location: string) =>
  expandParent(glossary, project, location, "glossaries");

const resourceName = (glossary: string, termId: string) =>
  `${glossary}/terms/${termId}`;

const toAttrs = (
  term: dataplex.GoogleCloudDataplexV1GlossaryTerm,
  project: string,
) => {
  const name = term.name ?? "";
  const parsed = parseResourceName(name, "terms");
  const glossary = parseResourceName(name, "glossaries");
  return {
    name,
    termId: parsed.id,
    glossary: glossary.parent
      ? `${glossary.parent}/glossaries/${glossary.id}`
      : parsed.parent,
    parent: term.parent ?? parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: term.displayName,
    description: term.description,
    labels: userLabels(term.labels),
    uid: term.uid,
    createTime: term.createTime,
    updateTime: term.updateTime,
  };
};

const getByName = (name: string) =>
  dataplex
    .getProjectsLocationsGlossariesTerms({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const GlossariesTermProvider = () =>
  Provider.succeed(GlossariesTerm, {
    stables: [
      "name",
      "termId",
      "glossary",
      "project",
      "location",
      "uid",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.termId ?? output?.termId;
      const nextId = news.termId ?? previousId;
      const previousGlossary = olds?.glossary ?? output?.glossary;
      const nextGlossary = news.glossary ?? previousGlossary;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        replaceIfChanged(previousId, nextId) ||
        replaceIfChanged(previousGlossary, nextGlossary) ||
        (output !== undefined && previousLocation !== nextLocation)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousGlossary === nextGlossary &&
            previousLocation === nextLocation &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const glossary = glossaryOf(
        olds?.glossary ?? output?.glossary ?? "",
        env.project,
        location,
      );
      const termId = yield* toPhysicalRfc1035(id, olds?.termId, output?.termId);
      const name = output?.name ?? resourceName(glossary, termId);
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
        const glossaries = yield* listGlossaries(env.project, env.region);
        const terms = yield* Effect.forEach(
          glossaries.filter((glossary) => (glossary.name ?? "").length > 0),
          (glossary) => listTerms(glossary.name!),
          { concurrency: 4 },
        );
        return terms
          .flat()
          .filter((term) => hasAlchemyLabelMap(term.labels))
          .map((term) => toAttrs(term, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const glossary = glossaryOf(news.glossary, env.project, location);
      const termId = yield* toPhysicalRfc1035(id, news.termId, output?.termId);
      const name = output?.name ?? resourceName(glossary, termId);
      const immediateParent = news.parent ?? glossary;
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataplex
          .createProjectsLocationsGlossariesTerms({
            parent: glossary,
            termId,
            body: {
              parent: immediateParent,
              displayName: news.displayName,
              description: news.description,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new GlossariesTermNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayNameChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const descriptionChanged =
        (current.description ?? "") !== (news.description ?? "");
      const parentChanged = (current.parent ?? "") !== immediateParent;

      if (
        labelsChanged ||
        displayNameChanged ||
        descriptionChanged ||
        parentChanged
      ) {
        const updateMask = [
          labelsChanged ? "labels" : undefined,
          displayNameChanged ? "display_name" : undefined,
          descriptionChanged ? "description" : undefined,
          parentChanged ? "parent" : undefined,
        ].filter((field): field is string => field !== undefined);
        current = yield* dataplex.patchProjectsLocationsGlossariesTerms({
          name: current.name ?? name,
          updateMask: updateMask.join(","),
          body: {
            parent: immediateParent,
            displayName: news.displayName,
            description: news.description,
            labels: desiredLabels,
          },
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* dataplex
        .deleteProjectsLocationsGlossariesTerms({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

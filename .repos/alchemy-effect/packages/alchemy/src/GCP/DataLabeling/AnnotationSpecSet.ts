import * as datalabeling from "@distilled.cloud/gcp/datalabeling_v1beta1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  findOwned,
  hasOwnershipMarker,
  ignoreGone,
  listAnnotationSpecSets,
  noRetryLayer,
  ownedByAlchemy,
  parseOwnership,
  parseResourceName,
  projectParent,
  replaceOnIdentity,
  retryDelete,
  retryTransient,
  sameJson,
  sameText,
  toDisplayName,
  waitUntilGone,
} from "./internal.ts";

export type AnnotationSpec = {
  /**
   * Display name of this spec (the class label). Maximum 64 characters.
   */
  displayName: string;
  /**
   * Optional description of this spec. Maximum 10,000 characters.
   */
  description?: string;
};

export type AnnotationSpecSetProps = {
  /**
   * Annotation spec set id (the last segment of
   * `projects/{project}/annotationSpecSets/{annotation_spec_set}`).
   * Server-assigned on create. Immutable — changing it replaces the set.
   */
  annotationSpecSetId?: string;
  /**
   * Display name. Maximum 64 characters. Required by the API; Alchemy
   * falls back to a generated name. Immutable — changing it replaces
   * the set.
   */
  displayName?: string;
  /**
   * Human-readable description. Annotation spec sets have no labels
   * field, so Alchemy stamps ownership into this field. Immutable —
   * changing it replaces the set.
   */
  description?: string;
  /**
   * The possible labels for a labeling task. Required. Immutable —
   * changing them replaces the set.
   */
  annotationSpecs: AnnotationSpec[];
};

export type AnnotationSpecSet = Resource<
  "GCP.DataLabeling.AnnotationSpecSet",
  AnnotationSpecSetProps,
  {
    /** Full resource name `projects/{project}/annotationSpecSets/{id}`. */
    name: string;
    /** Annotation spec set id (last path segment). */
    annotationSpecSetId: string;
    /** Project id. */
    project: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Annotation specs (class labels). */
    annotationSpecs: AnnotationSpec[];
    /** Related resources blocking changes. */
    blockingResources: string[] | undefined;
  },
  never,
  Providers
>;

/**
 * A Data Labeling annotation spec set — a collection of class labels
 * used by labeling tasks.
 *
 * Spec sets are immutable after create. There is no labels API, so
 * Alchemy stamps ownership into `description` so `list` / nuke can find
 * them. Ids are server-assigned.
 *
 * ### Creating an Annotation Spec Set
 * **Example:** Image classes
 * ```typescript
 * const specs = yield* GCP.DataLabeling.AnnotationSpecSet("Classes", {
 *   displayName: "pets",
 *   annotationSpecs: [
 *     { displayName: "dog" },
 *     { displayName: "cat" },
 *   ],
 * });
 * ```
 *
 * **Example:** Specs with descriptions
 * ```typescript
 * const specs = yield* GCP.DataLabeling.AnnotationSpecSet("Classes", {
 *   displayName: "sentiment",
 *   description: "review polarity",
 *   annotationSpecs: [
 *     { displayName: "positive", description: "favorable" },
 *     { displayName: "negative", description: "unfavorable" },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category DataLabeling
 */
export const AnnotationSpecSet = Resource<AnnotationSpecSet>(
  "GCP.DataLabeling.AnnotationSpecSet",
);

export class AnnotationSpecSetNotResolved extends Data.TaggedError(
  "GCP.DataLabeling.AnnotationSpecSetNotResolved",
)<{
  name: string;
}> {}

const resourceName = (project: string, annotationSpecSetId: string) =>
  `${projectParent(project)}/annotationSpecSets/${annotationSpecSetId}`;

const specsOf = (
  specs:
    | readonly datalabeling.GoogleCloudDatalabelingV1beta1AnnotationSpec[]
    | readonly AnnotationSpec[]
    | undefined,
): AnnotationSpec[] =>
  (specs ?? []).map((spec) => ({
    displayName: spec.displayName ?? "",
    description: spec.description,
  }));

const toAttrs = (
  set: datalabeling.GoogleCloudDatalabelingV1beta1AnnotationSpecSet,
  project: string,
) => {
  const name = set.name ?? "";
  const parsed = parseResourceName(name, "annotationSpecSets");
  return {
    name,
    annotationSpecSetId: parsed.id,
    project: parsed.project || project,
    displayName: set.displayName,
    description: parseOwnership(set.description).text,
    annotationSpecs: specsOf(set.annotationSpecs),
    blockingResources: set.blockingResources,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : datalabeling.getProjectsAnnotationSpecSets({ name }).pipe(
        Effect.provide(noRetryLayer),
        Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
        Effect.catchTag("BadGateway", () => Effect.succeed(undefined)),
      );

const findByOwnership = (id: string, project: string) =>
  Effect.gen(function* () {
    const rows = yield* listAnnotationSpecSets(projectParent(project));
    return yield* findOwned(id, rows, (row) => row.description);
  });

export const AnnotationSpecSetProvider = () =>
  Provider.succeed(AnnotationSpecSet, {
    stables: ["name", "annotationSpecSetId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const extra =
        (news.displayName !== undefined &&
          output?.displayName !== undefined &&
          !sameText(news.displayName, output.displayName)) ||
        (olds !== undefined &&
          !sameText(news.description, output?.description)) ||
        (output !== undefined &&
          !sameJson(specsOf(news.annotationSpecs), output.annotationSpecs));
      return replaceOnIdentity({
        previousId: olds?.annotationSpecSetId ?? output?.annotationSpecSetId,
        nextId: news.annotationSpecSetId,
        extra,
      });
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const annotationSpecSetId =
        olds?.annotationSpecSetId ??
        output?.annotationSpecSetId ??
        (output?.name
          ? parseResourceName(output.name, "annotationSpecSets").id
          : "");
      const name =
        output?.name ??
        (annotationSpecSetId.length > 0
          ? resourceName(env.project, annotationSpecSetId)
          : "");
      const existing =
        (yield* getByName(name)) ?? (yield* findByOwnership(id, env.project));
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, existing.description))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const rows = yield* listAnnotationSpecSets(projectParent(env.project));
        return rows
          .filter((row) => hasOwnershipMarker(row.description))
          .map((row) => toAttrs(row, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const annotationSpecSetId =
        news.annotationSpecSetId ?? output?.annotationSpecSetId;
      const name =
        output?.name ??
        (annotationSpecSetId !== undefined
          ? resourceName(env.project, annotationSpecSetId)
          : "");
      const ownership = yield* createInternalLabels(id);
      const displayName = yield* toDisplayName(
        id,
        news.displayName,
        output?.displayName,
      );
      const description = encodeOwnership(ownership, news.description);
      const annotationSpecs = specsOf(news.annotationSpecs);

      let current =
        (yield* getByName(name)) ?? (yield* findByOwnership(id, env.project));

      if (current === undefined) {
        const created = yield* retryTransient(
          datalabeling.createProjectsAnnotationSpecSets({
            parent: projectParent(env.project),
            body: {
              annotationSpecSet: {
                displayName,
                description,
                annotationSpecs,
              },
            },
          }),
        ).pipe(
          Effect.catchTag("Conflict", () => findByOwnership(id, env.project)),
        );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AnnotationSpecSetNotResolved({
          name: name || projectParent(env.project),
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      yield* ignoreGone(
        retryDelete(
          datalabeling.deleteProjectsAnnotationSpecSets({ name: output.name }),
        ),
      );
      yield* waitUntilGone(getByName(output.name));
    }),
  });

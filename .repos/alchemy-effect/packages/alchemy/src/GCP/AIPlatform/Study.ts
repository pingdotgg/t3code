import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import { createHash } from "node:crypto";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { lastSegment, locationOf, locationParent } from "./ownership.ts";

export type StudyMetricSpec = {
  /** Metric id. Must be unique among metrics. */
  metricId: string;
  /** Optimization goal. */
  goal: "MAXIMIZE" | "MINIMIZE" | (string & {});
};

export type StudyParameterSpec = {
  /** Parameter id. Must be unique among parameters. */
  parameterId: string;
  /** Inclusive range for a `DOUBLE` parameter. */
  doubleValueSpec?: {
    minValue?: number;
    maxValue?: number;
    defaultValue?: number;
  };
  /** Inclusive range for an `INTEGER` parameter. */
  integerValueSpec?: {
    minValue?: string;
    maxValue?: string;
    defaultValue?: string;
  };
  /** Discrete feasible values. */
  discreteValueSpec?: { values?: number[]; defaultValue?: number };
  /** Categorical feasible values. */
  categoricalValueSpec?: { values?: string[]; defaultValue?: string };
  /** Scaling. Leave unset for categorical parameters. */
  scaleType?:
    | "UNIT_LINEAR_SCALE"
    | "UNIT_LOG_SCALE"
    | "UNIT_REVERSE_LOG_SCALE"
    | (string & {});
};

export type StudySpec = {
  /** Metrics to optimize. */
  metrics: StudyMetricSpec[];
  /** Parameters to tune. */
  parameters: StudyParameterSpec[];
  /** Search algorithm. */
  algorithm?:
    | "ALGORITHM_UNSPECIFIED"
    | "GRID_SEARCH"
    | "RANDOM_SEARCH"
    | (string & {});
  /** Which measurement to use when a trial reports several. */
  measurementSelectionType?:
    | "LAST_MEASUREMENT"
    | "BEST_MEASUREMENT"
    | (string & {});
};

export type StudyProps = {
  /**
   * Region (`us-central1`, …). Immutable — changing it replaces the Study.
   * @default the stack's GCP region (`GCP.Region`, else the profile region, else `us-central1`)
   */
  location?: string;
  /**
   * User-facing display name: letters, digits, and underscores, starting
   * with a letter. Vertex AI Studies have no labels field, so Alchemy
   * appends an `_alchemy_{hash}` ownership suffix (stripped from
   * attributes). Display name is the lookup key.
   * @default "study"
   */
  displayName?: string;
  /**
   * Study configuration. Immutable — changing it replaces the Study.
   */
  studySpec: StudySpec;
};

export type Study = Resource<
  "GCP.AIPlatform.Study",
  StudyProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/studies/{study}`. */
    name: string;
    /** Study id (last path segment). */
    studyId: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Study configuration. */
    studySpec: aiplatform.GoogleCloudAiplatformV1StudySpec | undefined;
    /** Server-reported state. */
    state: string | undefined;
    /** Why the study is inactive, if set. */
    inactiveReason: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Vizier Study for hyperparameter search.
 *
 * Studies have no labels field and no update RPC — Alchemy stamps an
 * ownership hash onto the display name. Location and study spec are immutable.
 *
 * ### Creating a Study
 * **Example:** Maximize accuracy over a double parameter
 * ```typescript
 * const study = yield* GCP.AIPlatform.Study("Tune", {
 *   studySpec: {
 *     metrics: [{ metricId: "accuracy", goal: "MAXIMIZE" }],
 *     parameters: [
 *       {
 *         parameterId: "learning_rate",
 *         doubleValueSpec: { minValue: 0.001, maxValue: 0.1 },
 *       },
 *     ],
 *     algorithm: "RANDOM_SEARCH",
 *   },
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const Study = Resource<Study>("GCP.AIPlatform.Study");

export class StudyNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.StudyNotResolved",
)<{
  name: string;
}> {}

const toStudySpec = (
  spec: StudySpec,
): aiplatform.GoogleCloudAiplatformV1StudySpec => ({
  metrics: spec.metrics.map((metric) => ({
    metricId: metric.metricId,
    goal: metric.goal,
  })),
  parameters: spec.parameters.map((parameter) => ({
    parameterId: parameter.parameterId,
    doubleValueSpec: parameter.doubleValueSpec,
    integerValueSpec: parameter.integerValueSpec,
    discreteValueSpec: parameter.discreteValueSpec,
    categoricalValueSpec: parameter.categoricalValueSpec,
    scaleType: parameter.scaleType,
  })),
  algorithm: spec.algorithm,
  measurementSelectionType: spec.measurementSelectionType,
});

const specKey = (spec: StudySpec) =>
  JSON.stringify({
    metrics: spec.metrics,
    parameters: spec.parameters,
    algorithm: spec.algorithm ?? "",
    measurementSelectionType: spec.measurementSelectionType ?? "",
  });

/**
 * Study display names allow only `[A-Za-z0-9_]`, so ownership is a
 * `_alchemy_{hash}` suffix over the stack, stage, and logical id rather
 * than the bracketed marker other Vertex AI resources use.
 */
const OWNER_SEPARATOR = "_alchemy_";
const DEFAULT_DISPLAY_NAME = "study";

const ownerSuffix = (id: string) =>
  createInternalLabels(id).pipe(
    Effect.flatMap((labels) =>
      Effect.sync(
        () =>
          OWNER_SEPARATOR +
          createHash("sha256")
            .update(JSON.stringify(labels))
            .digest("hex")
            .slice(0, 20),
      ),
    ),
  );

const encodeDisplayName = (suffix: string, displayName: string | undefined) =>
  `${displayName ?? DEFAULT_DISPLAY_NAME}${suffix}`;

const parseDisplayName = (displayName: string | undefined) => {
  const at = displayName?.lastIndexOf(OWNER_SEPARATOR) ?? -1;
  return displayName !== undefined && at > 0
    ? displayName.slice(0, at)
    : displayName;
};

/** Whether a study's display name carries an Alchemy ownership suffix. */
export const hasStudyOwnership = (displayName: string | undefined) =>
  (displayName?.lastIndexOf(OWNER_SEPARATOR) ?? -1) > 0;

const ownedByAlchemy = (id: string, displayName: string | undefined) =>
  ownerSuffix(id).pipe(
    Effect.map((suffix) => displayName?.endsWith(suffix) === true),
  );

const toAttrs = (
  study: aiplatform.GoogleCloudAiplatformV1Study,
  project: string,
) => {
  const name = study.name ?? "";
  const parsed = { text: parseDisplayName(study.displayName) };
  return {
    name,
    studyId: lastSegment(name),
    location: locationOf(name),
    project,
    displayName: parsed.text,
    studySpec: study.studySpec,
    state: study.state,
    inactiveReason: study.inactiveReason,
    createTime: study.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getProjectsLocationsStudies({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

// `lookupProjectsLocationsStudies` answers a missing display name with a
// 500 ("There was an issue when sending 'LookupStudyRequest'"), so scan
// the listing instead.
const lookupByDisplayName = (parent: string, displayName: string) =>
  aiplatform.listProjectsLocationsStudies.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.studies ?? [])),
    Stream.filter((study) => study.displayName === displayName),
    Stream.runHead,
    Effect.map(Option.getOrUndefined),
    Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
  );

const listAt = (parent: string, project: string) =>
  aiplatform.listProjectsLocationsStudies.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.studies ?? [])),
    Stream.filter((study) => hasStudyOwnership(study.displayName)),
    Stream.map((study) => toAttrs(study, project)),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([])),
  );

export const StudyProvider = () =>
  Provider.succeed(Study, {
    stables: ["name", "studyId", "location", "project", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousLocation = olds?.location ?? output?.location;
      const nextLocation = news.location ?? previousLocation;
      if (previousLocation !== undefined && previousLocation !== nextLocation) {
        return { action: "replace" as const, deleteFirst: false };
      }
      if (olds?.studySpec !== undefined) {
        if (specKey(olds.studySpec) !== specKey(news.studySpec)) {
          return { action: "replace" as const, deleteFirst: false };
        }
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getByName(output?.name ?? "");
      if (existing !== undefined) {
        const attrs = toAttrs(existing, env.project);
        return (yield* ownedByAlchemy(id, existing.displayName))
          ? attrs
          : Unowned(attrs);
      }
      const location = olds?.location ?? output?.location ?? env.region;
      const parent = locationParent(env.project, location);
      const displayName = encodeDisplayName(
        yield* ownerSuffix(id),
        olds?.displayName,
      );
      const lookedUp = yield* lookupByDisplayName(parent, displayName);
      if (lookedUp === undefined) return undefined;
      const attrs = toAttrs(lookedUp, env.project);
      return (yield* ownedByAlchemy(id, lookedUp.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return (yield* Effect.forEach(listLocations(env.region), (location) =>
          listAt(locationParent(env.project, location), env.project),
        )).flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = news.location ?? output?.location ?? env.region;
      const parent = locationParent(env.project, location);
      const displayName = encodeDisplayName(
        yield* ownerSuffix(id),
        news.displayName,
      );
      const studySpec = toStudySpec(news.studySpec);

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        current = yield* lookupByDisplayName(parent, displayName);
      }

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsStudies({
            parent,
            body: {
              displayName,
              studySpec,
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              lookupByDisplayName(parent, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new StudyNotResolved({
          name: output?.name ?? `${parent}/studies/-`,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* aiplatform
        .deleteProjectsLocationsStudies({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { hasStudyOwnership } from "./Study.ts";
import {
  lastSegment,
  locationOf,
  locationParent,
  parentOf,
} from "./ownership.ts";

export type TrialParameter = {
  /** Parameter id defined on the parent Study. */
  parameterId: string;
  /** Assigned value (`number` for numeric parameters, `string` for categorical). */
  value?: unknown;
};

export type StudiesTrialProps = {
  /**
   * Parent Study resource name
   * (`projects/{project}/locations/{location}/studies/{study}`).
   * Immutable — changing it replaces the Trial.
   */
  parent: string;
  /**
   * User-provided parameter assignments. Immutable after create.
   */
  parameters?: TrialParameter[];
  /**
   * Client identifier recorded on the Trial. Alchemy stores the logical
   * id here when omitted so `list` / nuke can find user-provided trials.
   */
  clientId?: string;
};

export type StudiesTrial = Resource<
  "GCP.AIPlatform.StudiesTrial",
  StudiesTrialProps,
  {
    /** Full resource name. */
    name: string;
    /** Trial id assigned by Vizier. */
    trialId: string;
    /** Parent Study resource name. */
    parent: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** Client identifier. */
    clientId: string | undefined;
    /** Parameter assignments. */
    parameters: TrialParameter[];
    /** Server-reported state. */
    state: string | undefined;
    /** Final measurement, if the trial completed. */
    finalMeasurement: aiplatform.GoogleCloudAiplatformV1Measurement | undefined;
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A user-provided Vertex AI Vizier Trial attached to a Study.
 *
 * Trials have no labels and no update RPC. Alchemy records the logical
 * id in `clientId` so `list` can find them. Parent and parameters are
 * immutable.
 *
 * ### Creating a Trial
 * **Example:** User-provided trial
 * ```typescript
 * const trial = yield* GCP.AIPlatform.StudiesTrial("Seed", {
 *   parent: study.name,
 *   parameters: [{ parameterId: "learning_rate", value: 0.01 }],
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const StudiesTrial = Resource<StudiesTrial>(
  "GCP.AIPlatform.StudiesTrial",
);

export class StudiesTrialNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.StudiesTrialNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  trial: aiplatform.GoogleCloudAiplatformV1Trial,
  project: string,
) => {
  const name = trial.name ?? "";
  return {
    name,
    trialId: trial.id ?? lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    clientId: trial.clientId,
    parameters: (trial.parameters ?? []).map((parameter) => ({
      parameterId: parameter.parameterId ?? "",
      value: parameter.value,
    })),
    state: trial.state,
    finalMeasurement: trial.finalMeasurement,
    startTime: trial.startTime,
    endTime: trial.endTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getProjectsLocationsStudiesTrials({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listStudies = (parent: string) =>
  aiplatform.listProjectsLocationsStudies.pages({ parent, pageSize: 100 }).pipe(
    Stream.flatMap((page) => Stream.fromIterable(page.studies ?? [])),
    Stream.filter((study) => hasStudyOwnership(study.displayName)),
    Stream.map((study) => study.name ?? ""),
    Stream.filter((name) => name.length > 0),
    Stream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
  );

const listAtParent = (parent: string, project: string, clientId?: string) =>
  aiplatform.listProjectsLocationsStudiesTrials
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.trials ?? [])),
      Stream.filter((trial) =>
        clientId !== undefined ? trial.clientId === clientId : true,
      ),
      Stream.map((trial) => toAttrs(trial, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByClientId = (parent: string, clientId: string, project: string) =>
  listAtParent(parent, project, clientId).pipe(
    Effect.map((trials) => trials[0]),
  );

export const StudiesTrialProvider = () =>
  Provider.succeed(StudiesTrial, {
    stables: ["name", "trialId", "parent", "location", "project", "startTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const existing = yield* getByName(output?.name ?? "");
      if (existing !== undefined) {
        return toAttrs(existing, env.project);
      }
      if (olds?.parent === undefined) return undefined;
      const ownership = yield* createInternalLabels(id);
      const clientId = olds.clientId ?? `alchemy-${ownership["alchemy-id"]}`;
      const match = yield* findByClientId(olds.parent, clientId, env.project);
      if (match === undefined) return undefined;
      const fetched = yield* getByName(match.name);
      if (fetched === undefined) return undefined;
      const attrs = toAttrs(fetched, env.project);
      return fetched.clientId === clientId ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const studies = (yield* Effect.forEach(
          listLocations(env.region),
          (location) => listStudies(locationParent(env.project, location)),
        )).flat();
        const pages = yield* Effect.forEach(
          studies,
          (parent) => listAtParent(parent, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const ownership = yield* createInternalLabels(id);
      const clientId = news.clientId ?? `alchemy-${ownership["alchemy-id"]}`;

      let current = yield* getByName(output?.name ?? "");
      if (current === undefined) {
        const match = yield* findByClientId(news.parent, clientId, env.project);
        if (match !== undefined) {
          current = yield* getByName(match.name);
        }
      }

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsStudiesTrials({
            parent: news.parent,
            body: {
              clientId,
              // Vizier rejects user trials without a status ("Can not add
              // trial with status: UNKNOWN").
              state: "ACTIVE",
              parameters: news.parameters?.map((parameter) => ({
                parameterId: parameter.parameterId,
                value: parameter.value,
              })),
            },
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByClientId(news.parent, clientId, env.project).pipe(
                Effect.flatMap((match) =>
                  match ? getByName(match.name) : Effect.succeed(undefined),
                ),
              ),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new StudiesTrialNotResolved({
          name: output?.name ?? `${news.parent}/trials/-`,
        });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* aiplatform
        .deleteProjectsLocationsStudiesTrials({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

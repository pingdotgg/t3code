import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  encodeOwnership,
  listAgents,
  listEnvironments,
  listExperiments,
  ownedByAlchemy,
  ownershipLabels,
  ownershipText,
  parseOwnership,
  parseResourceName,
  sameJson,
  sameText,
  updateMaskOf,
  retryQuota,
} from "./internal.ts";

export type ExperimentVariant = {
  /** Flow version resource name. */
  version: string;
  /** Traffic fraction in `[0, 1]`. */
  trafficAllocation?: number;
  /** Whether this variant is the control group. */
  isControlGroup?: boolean;
};

export type ExperimentDefinition = {
  /** Condition selecting sessions that enter the experiment. */
  condition?: string;
  /** Version variants and traffic split. */
  versionVariants?: {
    variants?: ExperimentVariant[];
  };
};

export type AgentsEnvironmentsExperimentProps = {
  /**
   * Parent environment resource name
   * `projects/{project}/locations/{location}/agents/{agent}/environments/{environment}`.
   * Immutable — changing it replaces the experiment.
   */
  environment: string;
  /**
   * Experiment id. Server-assigned on create. Immutable — changing it
   * replaces the experiment.
   */
  experimentId?: string;
  /** Human-readable name, unique within the environment. */
  displayName?: string;
  /**
   * Description. Experiments have no labels field, so Alchemy stamps
   * ownership into this field for `list` / nuke.
   */
  description?: string;
  /** Experiment definition (condition and version variants). */
  definition?: ExperimentDefinition;
  /** Experiment duration (e.g. `"86400s"`). */
  experimentLength?: string;
};

export type AgentsEnvironmentsExperiment = Resource<
  "GCP.Dialogflow.AgentsEnvironmentsExperiment",
  AgentsEnvironmentsExperimentProps,
  {
    /** Full resource name. */
    name: string;
    /** Experiment id (last path segment). */
    experimentId: string;
    /** Parent environment resource name. */
    environment: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** Experiment definition. */
    definition: ExperimentDefinition | undefined;
    /** Experiment duration. */
    experimentLength: string | undefined;
    /** Experiment state. */
    state: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX experiment under an environment.
 *
 * Experiments have no labels field, so Alchemy stamps ownership into
 * `description` for `list` / nuke. Parent environment and experiment id
 * are immutable. Display name, description, definition, and length
 * update in place.
 *
 * ### Creating an Experiment
 * **Example:** A/B test two flow versions
 * ```typescript
 * const experiment = yield* GCP.Dialogflow.AgentsEnvironmentsExperiment(
 *   "Ab",
 *   {
 *     environment: environment.name,
 *     displayName: "checkout-ab",
 *     definition: {
 *       versionVariants: {
 *         variants: [
 *           {
 *             version: control.name,
 *             trafficAllocation: 0.5,
 *             isControlGroup: true,
 *           },
 *           { version: treatment.name, trafficAllocation: 0.5 },
 *         ],
 *       },
 *     },
 *   },
 * );
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsEnvironmentsExperiment =
  Resource<AgentsEnvironmentsExperiment>(
    "GCP.Dialogflow.AgentsEnvironmentsExperiment",
  );

export class AgentsEnvironmentsExperimentNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsEnvironmentsExperimentNotResolved",
)<{
  name: string;
}> {}

const definitionOf = (
  definition:
    | dialogflow.GoogleCloudDialogflowCxV3ExperimentDefinition
    | undefined,
): ExperimentDefinition | undefined => {
  if (definition === undefined) return undefined;
  return {
    condition: definition.condition,
    versionVariants: definition.versionVariants
      ? {
          variants: (definition.versionVariants.variants ?? []).map(
            (variant) => ({
              version: variant.version ?? "",
              trafficAllocation: variant.trafficAllocation,
              isControlGroup: variant.isControlGroup,
            }),
          ),
        }
      : undefined,
  };
};

const toAttrs = (
  experiment: dialogflow.GoogleCloudDialogflowCxV3Experiment,
  project: string,
) => {
  const name = experiment.name ?? "";
  const parsed = parseResourceName(name, "experiments");
  return {
    name,
    experimentId: parsed.id,
    environment: parsed.environment || parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: experiment.displayName,
    description: parseOwnership(experiment.description).text,
    definition: definitionOf(experiment.definition),
    experimentLength: experiment.experimentLength,
    state: experiment.state,
    createTime: experiment.createTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsEnvironmentsExperiments({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (id: string, environment: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const experiments = yield* listExperiments(environment);
    for (const experiment of experiments) {
      if (yield* ownedByAlchemy(id, ownershipText(experiment))) {
        return experiment;
      }
    }
    return undefined as
      | dialogflow.GoogleCloudDialogflowCxV3Experiment
      | undefined;
  });

const listOwned = (project: string) =>
  Effect.gen(function* () {
    const agents = yield* listAgents(project);
    const environments = (yield* Effect.forEach(
      agents,
      (agent) =>
        agent.name ? listEnvironments(agent.name) : Effect.succeed([]),
      { concurrency: 4 },
    )).flat();
    const experiments = (yield* Effect.forEach(
      environments,
      (environment) =>
        environment.name
          ? listExperiments(environment.name)
          : Effect.succeed([]),
      { concurrency: 4 },
    )).flat();
    return experiments
      .filter(
        (experiment) =>
          parseOwnership(experiment.description).labels["alchemy-id"] !==
            undefined ||
          parseOwnership(experiment.displayName).labels["alchemy-id"] !==
            undefined,
      )
      .map((experiment) => toAttrs(experiment, project));
  });

export const AgentsEnvironmentsExperimentProvider = () =>
  Provider.succeed(AgentsEnvironmentsExperiment, {
    stables: [
      "name",
      "experimentId",
      "environment",
      "project",
      "location",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.environment ?? output?.environment;
      const previousId = olds?.experimentId ?? output?.experimentId;
      if (
        (previousParent !== undefined && news.environment !== previousParent) ||
        (previousId !== undefined &&
          news.experimentId !== undefined &&
          news.experimentId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousParent === news.environment &&
            previousId !== undefined &&
            news.experimentId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const environment = olds?.environment ?? output?.environment;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : environment !== undefined
            ? yield* findOwned(id, environment)
            : undefined;
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* ownedByAlchemy(id, ownershipText(existing)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        return yield* listOwned(env.project);
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const environment = news.environment;
      const ownership = yield* ownershipLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? "experiment";
      const body: dialogflow.GoogleCloudDialogflowCxV3Experiment = {
        displayName,
        description,
        definition: news.definition,
        experimentLength: news.experimentLength,
      };

      let current = yield* findOwned(id, environment, output?.name);

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsEnvironmentsExperiments({
            parent: environment,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(id, environment, output?.name),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsEnvironmentsExperimentNotResolved({
          name:
            output?.name ??
            `${environment}/experiments/${news.experimentId ?? "unknown"}`,
        });
      }

      const currentName = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const definitionChanged = !sameJson(
        definitionOf(current.definition),
        news.definition,
      );
      const lengthChanged = !sameText(
        current.experimentLength,
        news.experimentLength,
      );

      if (
        displayChanged ||
        descriptionChanged ||
        definitionChanged ||
        lengthChanged
      ) {
        current =
          yield* dialogflow.patchProjectsLocationsAgentsEnvironmentsExperiments(
            {
              name: currentName,
              updateMask: updateMaskOf(
                displayChanged ? "display_name" : undefined,
                descriptionChanged ? "description" : undefined,
                definitionChanged ? "definition" : undefined,
                lengthChanged ? "experiment_length" : undefined,
              ),
              body: { ...body, name: currentName },
            },
          );
      }

      return toAttrs(current, env.project);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsEnvironmentsExperiments({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });

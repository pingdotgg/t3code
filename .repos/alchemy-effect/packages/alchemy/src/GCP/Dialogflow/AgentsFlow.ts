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
  expandName,
  listAgents,
  listFlows,
  normalizeLocation,
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

export type NluSettings = {
  /** Model type. */
  modelType?:
    | "MODEL_TYPE_UNSPECIFIED"
    | "MODEL_TYPE_STANDARD"
    | "MODEL_TYPE_ADVANCED"
    | (string & {});
  /** Classification threshold in `[0, 1]`. */
  classificationThreshold?: number;
  /** Model training mode. */
  modelTrainingMode?:
    | "MODEL_TRAINING_MODE_UNSPECIFIED"
    | "MODEL_TRAINING_MODE_AUTOMATIC"
    | "MODEL_TRAINING_MODE_MANUAL"
    | (string & {});
};

export type AgentsFlowProps = {
  /**
   * Parent agent resource name
   * `projects/{project}/locations/{location}/agents/{agent}`. Immutable —
   * changing it replaces the flow.
   */
  agent: string;
  /**
   * Flow id (the `{flow}` segment). Server-assigned on create. Immutable
   * — changing it replaces the flow.
   */
  flowId?: string;
  /**
   * Location used when `agent` is a bare id.
   * @default "global"
   */
  location?: string;
  /** Human-readable name, unique within the agent. */
  displayName?: string;
  /**
   * Description. Flows have no labels field, so Alchemy stamps
   * ownership into this field for `list` / nuke.
   */
  description?: string;
  /** NLU settings. */
  nluSettings?: NluSettings;
  /**
   * Prevent concurrent updates.
   * @default false
   */
  locked?: boolean;
  /** Language code of the flow. */
  languageCode?: string;
};

export type AgentsFlow = Resource<
  "GCP.Dialogflow.AgentsFlow",
  AgentsFlowProps,
  {
    /** Full resource name. */
    name: string;
    /** Flow id (last path segment). */
    flowId: string;
    /** Parent agent resource name. */
    agent: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User description with the Alchemy ownership prefix stripped. */
    description: string | undefined;
    /** NLU settings. */
    nluSettings: NluSettings | undefined;
    /** Whether the flow is locked. */
    locked: boolean;
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX flow under an agent.
 *
 * Flows have no labels field, so Alchemy stamps ownership into
 * `description` for `list` / nuke. Parent agent and flow id are
 * immutable. Display name, description, NLU settings, and lock flag
 * update in place.
 *
 * ### Creating a Flow
 * **Example:** Named flow
 * ```typescript
 * const flow = yield* GCP.Dialogflow.AgentsFlow("Ordering", {
 *   agent: agent.name,
 *   displayName: "ordering",
 *   description: "order intake",
 * });
 * ```
 *
 * ### Updating a Flow
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Rename
 * ```typescript
 * const flow = yield* GCP.Dialogflow.AgentsFlow("Ordering", {
 *   agent: agent.name,
 *   displayName: "checkout",
 *   description: "checkout flow",
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsFlow = Resource<AgentsFlow>("GCP.Dialogflow.AgentsFlow");

export class AgentsFlowNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsFlowNotResolved",
)<{
  name: string;
}> {}

const nluOf = (
  settings: dialogflow.GoogleCloudDialogflowCxV3NluSettings | undefined,
): NluSettings | undefined => {
  if (settings === undefined) return undefined;
  return {
    modelType: settings.modelType,
    classificationThreshold: settings.classificationThreshold,
    modelTrainingMode: settings.modelTrainingMode,
  };
};

const toAttrs = (
  flow: dialogflow.GoogleCloudDialogflowCxV3Flow,
  project: string,
) => {
  const name = flow.name ?? "";
  const parsed = parseResourceName(name, "flows");
  return {
    name,
    flowId: parsed.id,
    agent: parsed.agent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: flow.displayName,
    description: parseOwnership(flow.description).text,
    nluSettings: nluOf(flow.nluSettings),
    locked: flow.locked === true,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsFlows({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (id: string, agent: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const flows = yield* listFlows(agent);
    for (const flow of flows) {
      if (yield* ownedByAlchemy(id, ownershipText(flow))) return flow;
    }
    return undefined as dialogflow.GoogleCloudDialogflowCxV3Flow | undefined;
  });

export const AgentsFlowProvider = () =>
  Provider.succeed(AgentsFlow, {
    stables: ["name", "flowId", "agent", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAgent = olds?.agent ?? output?.agent;
      const previousId = olds?.flowId ?? output?.flowId;
      if (
        (previousAgent !== undefined && news.agent !== previousAgent) ||
        (previousId !== undefined &&
          news.flowId !== undefined &&
          news.flowId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousAgent === news.agent &&
            previousId !== undefined &&
            news.flowId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const agent = olds?.agent ?? output?.agent;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : agent !== undefined
            ? yield* findOwned(id, agent)
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
        const agents = yield* listAgents(env.project);
        const pages = yield* Effect.forEach(
          agents,
          (agent) =>
            agent.name
              ? listFlows(agent.name).pipe(
                  Effect.map((flows) =>
                    flows
                      .filter(
                        (flow) =>
                          parseOwnership(flow.description).labels[
                            "alchemy-id"
                          ] !== undefined ||
                          parseOwnership(flow.displayName).labels[
                            "alchemy-id"
                          ] !== undefined,
                      )
                      .map((flow) => toAttrs(flow, env.project)),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(news.location ?? output?.location);
      const agent = expandName(news.agent, env.project, location, "agents");
      const ownership = yield* ownershipLabels(id);
      const description = encodeOwnership(ownership, news.description);
      const displayName = news.displayName ?? "flow";
      const locked = news.locked === true;
      const body: dialogflow.GoogleCloudDialogflowCxV3Flow = {
        displayName,
        description,
        nluSettings: news.nluSettings,
        locked,
      };

      let current = yield* findOwned(id, agent, output?.name);

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsFlows({
            parent: agent,
            languageCode: news.languageCode,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(id, agent, output?.name),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsFlowNotResolved({
          name: output?.name ?? `${agent}/flows/${news.flowId ?? "unknown"}`,
        });
      }

      const currentName = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const descriptionChanged = !sameText(current.description, description);
      const nluChanged = !sameJson(
        nluOf(current.nluSettings),
        news.nluSettings,
      );
      const lockedChanged = (current.locked === true) !== locked;

      if (displayChanged || descriptionChanged || nluChanged || lockedChanged) {
        current = yield* dialogflow.patchProjectsLocationsAgentsFlows({
          name: currentName,
          languageCode: news.languageCode,
          updateMask: updateMaskOf(
            displayChanged ? "display_name" : undefined,
            descriptionChanged ? "description" : undefined,
            nluChanged ? "nlu_settings" : undefined,
            lockedChanged ? "locked" : undefined,
          ),
          body: { ...body, name: currentName },
        });
      }

      return toAttrs(current, env.project);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsFlows({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });

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
  encodeOwnershipLine,
  listAgents,
  listFlows,
  listTransitionRouteGroups,
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

export type TransitionRoute = {
  /** Intent that triggers this route. */
  intent?: string;
  /** Condition expression. */
  condition?: string;
  /** Target flow resource name. */
  targetFlow?: string;
  /** Target page resource name. */
  targetPage?: string;
  /** Description of the route. */
  description?: string;
  /** Fulfillment run when the route matches. */
  triggerFulfillment?: {
    messages?: Array<{
      text?: { text?: string[]; allowPlaybackInterruption?: boolean };
    }>;
    tag?: string;
  };
};

export type AgentsFlowsTransitionRouteGroupProps = {
  /**
   * Parent flow resource name
   * `projects/{project}/locations/{location}/agents/{agent}/flows/{flow}`.
   * Immutable — changing it replaces the route group.
   */
  flow: string;
  /**
   * Transition route group id. Server-assigned on create. Immutable —
   * changing it replaces the route group.
   */
  transitionRouteGroupId?: string;
  /**
   * Human-readable name, unique within the flow. Route groups have no
   * labels or description field, so Alchemy stamps ownership into this
   * field for `list` / nuke.
   */
  displayName?: string;
  /** Transition routes in the group. */
  transitionRoutes?: TransitionRoute[];
  /** Language code of the route group. */
  languageCode?: string;
};

export type AgentsFlowsTransitionRouteGroup = Resource<
  "GCP.Dialogflow.AgentsFlowsTransitionRouteGroup",
  AgentsFlowsTransitionRouteGroupProps,
  {
    /** Full resource name. */
    name: string;
    /** Route group id (last path segment). */
    transitionRouteGroupId: string;
    /** Parent flow resource name. */
    flow: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User display name with the Alchemy ownership prefix stripped. */
    displayName: string | undefined;
    /** Transition routes. */
    transitionRoutes: TransitionRoute[];
  },
  never,
  Providers
>;

/**
 * A Dialogflow CX transition route group under a flow.
 *
 * Route groups have no labels field, so Alchemy stamps ownership into
 * `displayName` for `list` / nuke. Parent flow and id are immutable.
 * Display name and routes update in place.
 *
 * ### Creating a Route Group
 * **Example:** Fallback routes
 * ```typescript
 * const group = yield* GCP.Dialogflow.AgentsFlowsTransitionRouteGroup(
 *   "Fallback",
 *   {
 *     flow: flow.name,
 *     displayName: "fallback",
 *     transitionRoutes: [
 *       {
 *         condition: "true",
 *         triggerFulfillment: {
 *           messages: [{ text: { text: ["I did not get that."] } }],
 *         },
 *       },
 *     ],
 *   },
 * );
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsFlowsTransitionRouteGroup =
  Resource<AgentsFlowsTransitionRouteGroup>(
    "GCP.Dialogflow.AgentsFlowsTransitionRouteGroup",
  );

export class AgentsFlowsTransitionRouteGroupNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsFlowsTransitionRouteGroupNotResolved",
)<{
  name: string;
}> {}

const routesOf = (
  list:
    | readonly dialogflow.GoogleCloudDialogflowCxV3TransitionRoute[]
    | undefined,
): TransitionRoute[] =>
  (list ?? []).map((route) => ({
    intent: route.intent,
    condition: route.condition,
    targetFlow: route.targetFlow,
    targetPage: route.targetPage,
    description: route.description,
    triggerFulfillment: route.triggerFulfillment
      ? {
          messages: route.triggerFulfillment.messages?.map((message) => ({
            text: message.text
              ? {
                  text: [...(message.text.text ?? [])],
                  allowPlaybackInterruption:
                    message.text.allowPlaybackInterruption,
                }
              : undefined,
          })),
          tag: route.triggerFulfillment.tag,
        }
      : undefined,
  }));

const toAttrs = (
  group: dialogflow.GoogleCloudDialogflowCxV3TransitionRouteGroup,
  project: string,
) => {
  const name = group.name ?? "";
  const parsed = parseResourceName(name, "transitionRouteGroups");
  return {
    name,
    transitionRouteGroupId: parsed.id,
    flow: parsed.flow || parsed.parent,
    project: parsed.project || project,
    location: parsed.location,
    displayName: parseOwnership(group.displayName).text,
    transitionRoutes: routesOf(group.transitionRoutes),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsFlowsTransitionRouteGroups({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const findOwned = (id: string, flow: string, hinted?: string) =>
  Effect.gen(function* () {
    if (hinted !== undefined && hinted.length > 0) {
      const existing = yield* getByName(hinted);
      if (existing !== undefined) return existing;
    }
    const groups = yield* listTransitionRouteGroups(flow);
    for (const group of groups) {
      if (yield* ownedByAlchemy(id, ownershipText(group))) return group;
    }
    return undefined as
      | dialogflow.GoogleCloudDialogflowCxV3TransitionRouteGroup
      | undefined;
  });

const listOwned = (project: string) =>
  Effect.gen(function* () {
    const agents = yield* listAgents(project);
    const flows = (yield* Effect.forEach(
      agents,
      (agent) => (agent.name ? listFlows(agent.name) : Effect.succeed([])),
      { concurrency: 4 },
    )).flat();
    const groups = (yield* Effect.forEach(
      flows,
      (flow) =>
        flow.name ? listTransitionRouteGroups(flow.name) : Effect.succeed([]),
      { concurrency: 4 },
    )).flat();
    return groups
      .filter(
        (group) =>
          parseOwnership(group.displayName).labels["alchemy-id"] !== undefined,
      )
      .map((group) => toAttrs(group, project));
  });

export const AgentsFlowsTransitionRouteGroupProvider = () =>
  Provider.succeed(AgentsFlowsTransitionRouteGroup, {
    stables: ["name", "transitionRouteGroupId", "flow", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousFlow = olds?.flow ?? output?.flow;
      const previousId =
        olds?.transitionRouteGroupId ?? output?.transitionRouteGroupId;
      if (
        (previousFlow !== undefined && news.flow !== previousFlow) ||
        (previousId !== undefined &&
          news.transitionRouteGroupId !== undefined &&
          news.transitionRouteGroupId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousFlow === news.flow &&
            previousId !== undefined &&
            news.transitionRouteGroupId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const flow = olds?.flow ?? output?.flow;
      const existing =
        output?.name !== undefined
          ? yield* getByName(output.name)
          : flow !== undefined
            ? yield* findOwned(id, flow)
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
      const flow = news.flow;
      const ownership = yield* ownershipLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName ?? "routes",
      );
      const transitionRoutes = news.transitionRoutes;
      const body: dialogflow.GoogleCloudDialogflowCxV3TransitionRouteGroup = {
        displayName,
        transitionRoutes,
      };

      let current = yield* findOwned(id, flow, output?.name);

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsFlowsTransitionRouteGroups({
            parent: flow,
            languageCode: news.languageCode,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findOwned(id, flow, output?.name),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsFlowsTransitionRouteGroupNotResolved({
          name:
            output?.name ??
            `${flow}/transitionRouteGroups/${news.transitionRouteGroupId ?? "unknown"}`,
        });
      }

      const currentName = current.name ?? output?.name ?? "";
      const displayChanged = !sameText(current.displayName, displayName);
      const routesChanged = !sameJson(
        routesOf(current.transitionRoutes),
        routesOf(transitionRoutes),
      );

      if (displayChanged || routesChanged) {
        current =
          yield* dialogflow.patchProjectsLocationsAgentsFlowsTransitionRouteGroups(
            {
              name: currentName,
              languageCode: news.languageCode,
              updateMask: updateMaskOf(
                displayChanged ? "display_name" : undefined,
                routesChanged ? "transition_routes" : undefined,
              ),
              body: { ...body, name: currentName },
            },
          );
      }

      return toAttrs(current, env.project);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsFlowsTransitionRouteGroups({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });

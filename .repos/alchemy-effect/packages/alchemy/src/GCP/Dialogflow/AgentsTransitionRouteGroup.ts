import * as dialogflow from "@distilled.cloud/gcp/dialogflow_v3";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  collectionParent,
  DEFAULT_LOCATION,
  encodeOwnershipLine,
  expandAgent,
  fingerprint,
  hasOwnershipMarker,
  internalLabels,
  lastSegment,
  locationOf,
  MAX_ROUTE_GROUP_DISPLAY_NAME_LENGTH,
  namedAgents,
  normalizeLocation,
  ownedByAlchemy,
  parentOf,
  parseOwnership,
  projectOf,
  sameText,
  toResourceId,
  updateMaskOf,
  retryQuota,
} from "./internal.ts";

type TransitionRoute = {
  /** Intent that triggers this route. */
  intent?: string;
  /** Condition expression. At least one of `intent` or `condition` is required. */
  condition?: string;
  /** Target flow resource name. */
  targetFlow?: string;
  /** Target page resource name. */
  targetPage?: string;
  /** Description of the route (max 500 characters). */
  description?: string;
  /** Fulfillment run when the route matches. */
  triggerFulfillment?: {
    messages?: Array<{
      text?: { text?: string[]; allowPlaybackInterruption?: boolean };
    }>;
    tag?: string;
  };
};

export type AgentsTransitionRouteGroupProps = {
  /**
   * Parent agent resource name
   * `projects/{project}/locations/{location}/agents/{agent}` or a bare
   * agent id (combined with `location`). Immutable — changing it
   * replaces the route group.
   */
  agent: string;
  /**
   * Transition route group id (the `{transitionRouteGroup}` segment).
   * Server-assigned on create. Immutable — changing it replaces the
   * group.
   */
  transitionRouteGroupId?: string;
  /**
   * Location used when `agent` is a bare id.
   * @default "global"
   */
  location?: string;
  /**
   * Human-readable name, unique within the agent (max 30 characters
   * including Alchemy's ownership marker). Route groups have no labels
   * field, so ownership is stored in a compact `[alc …]` prefix and
   * stripped from attributes.
   */
  displayName?: string;
  /** Transition routes in the group. */
  transitionRoutes?: TransitionRoute[];
  /** Language code of the route group. */
  languageCode?: string;
};

export type AgentsTransitionRouteGroup = Resource<
  "GCP.Dialogflow.AgentsTransitionRouteGroup",
  AgentsTransitionRouteGroupProps,
  {
    /** Full resource name `.../agents/{agent}/transitionRouteGroups/{id}`. */
    name: string;
    /** Route group id (last path segment). */
    transitionRouteGroupId: string;
    /** Parent agent resource name. */
    agent: string;
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
 * A Dialogflow CX agent-level transition route group.
 *
 * Agent-level groups are shared across flows. Route groups have no labels
 * field, so Alchemy stamps ownership into `displayName` (30-character
 * limit; compact `[alc …]` marker) for `list` / nuke. Parent agent and id
 * are immutable. Display name and routes update in place.
 *
 * ### Creating a Route Group
 * **Example:** Fallback routes
 * ```typescript
 * const group = yield* GCP.Dialogflow.AgentsTransitionRouteGroup("Fallback", {
 *   agent: agent.name,
 *   displayName: "fb",
 *   transitionRoutes: [
 *     {
 *       condition: "true",
 *       triggerFulfillment: {
 *         messages: [{ text: { text: ["I did not get that."] } }],
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * ### Updating a Route Group
 * Change props on the same logical id; the engine keeps the physical id.
 *
 * **Example:** Rename
 * ```typescript
 * const group = yield* GCP.Dialogflow.AgentsTransitionRouteGroup("Fallback", {
 *   agent: agent.name,
 *   displayName: "g2",
 *   transitionRoutes: [
 *     {
 *       condition: "true",
 *       triggerFulfillment: {
 *         messages: [{ text: { text: ["Sorry."] } }],
 *       },
 *     },
 *   ],
 * });
 * ```
 *
 * @resource
 * @category Dialogflow
 */
export const AgentsTransitionRouteGroup = Resource<AgentsTransitionRouteGroup>(
  "GCP.Dialogflow.AgentsTransitionRouteGroup",
);

export class AgentsTransitionRouteGroupNotResolved extends Data.TaggedError(
  "GCP.Dialogflow.AgentsTransitionRouteGroupNotResolved",
)<{
  name: string;
}> {}

const resourceName = (agent: string, transitionRouteGroupId: string) =>
  `${agent}/transitionRouteGroups/${transitionRouteGroupId}`;

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
  agentHint?: string,
) => {
  const name = group.name ?? "";
  return {
    name,
    transitionRouteGroupId: lastSegment(name),
    agent: name.includes("/transitionRouteGroups/")
      ? collectionParent(name, "agents")
      : (agentHint ?? parentOf(name)),
    project: projectOf(name) || project,
    location: locationOf(name),
    displayName: parseOwnership(group.displayName).text,
    transitionRoutes: routesOf(group.transitionRoutes),
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : dialogflow
        .getProjectsLocationsAgentsTransitionRouteGroups({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAt = (parent: string, project: string) =>
  dialogflow.listProjectsLocationsAgentsTransitionRouteGroups
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.transitionRouteGroups ?? []),
      ),
      Stream.filter((group) => hasOwnershipMarker(group.displayName)),
      Stream.map((group) => toAttrs(group, project, parent)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

const findByDisplayName = (parent: string, displayName: string) =>
  dialogflow.listProjectsLocationsAgentsTransitionRouteGroups
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.transitionRouteGroups ?? []),
      ),
      Stream.filter((group) => group.displayName === displayName),
      Stream.runHead,
      Effect.map((option) =>
        option._tag === "Some" ? option.value : undefined,
      ),
      Effect.catchTag("NotFound", () => Effect.succeed(undefined)),
    );

export const AgentsTransitionRouteGroupProvider = () =>
  Provider.succeed(AgentsTransitionRouteGroup, {
    stables: ["name", "transitionRouteGroupId", "agent", "project", "location"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousAgent = olds?.agent ?? output?.agent;
      if (previousAgent !== undefined && news.agent !== previousAgent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId =
        olds?.transitionRouteGroupId ?? output?.transitionRouteGroupId;
      if (
        previousId !== undefined &&
        news.transitionRouteGroupId !== undefined &&
        news.transitionRouteGroupId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousLocation = olds?.location ?? output?.location;
      if (
        previousLocation !== undefined &&
        news.location !== undefined &&
        normalizeLocation(previousLocation) !== normalizeLocation(news.location)
      ) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(olds?.location ?? output?.location);
      const agent = olds?.agent
        ? expandAgent(olds.agent, env.project, location)
        : output?.agent;
      const transitionRouteGroupId = yield* toResourceId(
        id,
        olds?.transitionRouteGroupId,
        output?.transitionRouteGroupId,
      );
      const name =
        output?.name ??
        (agent !== undefined
          ? resourceName(agent, transitionRouteGroupId)
          : "");
      let existing = yield* getByName(name);
      if (existing === undefined && agent !== undefined) {
        const ownership = yield* internalLabels(id);
        existing = yield* findByDisplayName(
          agent,
          encodeOwnershipLine(
            ownership,
            olds?.displayName,
            MAX_ROUTE_GROUP_DISPLAY_NAME_LENGTH,
          ),
        );
      }
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, agent);
      return (yield* ownedByAlchemy(id, existing.displayName))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const agents = yield* namedAgents(env.project);
        const pages = yield* Effect.forEach(
          agents,
          (agent) => listAt(agent.name, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location ?? DEFAULT_LOCATION,
      );
      const agent = expandAgent(news.agent, env.project, location);
      const transitionRouteGroupId = yield* toResourceId(
        id,
        news.transitionRouteGroupId,
        output?.transitionRouteGroupId,
      );
      const name = output?.name ?? resourceName(agent, transitionRouteGroupId);
      const ownership = yield* internalLabels(id);
      const displayName = encodeOwnershipLine(
        ownership,
        news.displayName,
        MAX_ROUTE_GROUP_DISPLAY_NAME_LENGTH,
      );
      const body: dialogflow.GoogleCloudDialogflowCxV3TransitionRouteGroup = {
        displayName,
        transitionRoutes: news.transitionRoutes,
      };

      let current = yield* getByName(output?.name ?? name);
      if (current === undefined) {
        current = yield* findByDisplayName(agent, displayName);
      }

      if (current === undefined) {
        const created = yield* dialogflow
          .createProjectsLocationsAgentsTransitionRouteGroups({
            parent: agent,
            languageCode: news.languageCode,
            body,
          })
          .pipe(
            Effect.catchTag("Conflict", () =>
              findByDisplayName(agent, displayName),
            ),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new AgentsTransitionRouteGroupNotResolved({ name });
      }

      const currentName = current.name ?? name;
      const displayChanged = !sameText(current.displayName, displayName);
      const routesChanged =
        fingerprint(routesOf(current.transitionRoutes)) !==
        fingerprint(news.transitionRoutes);

      if (displayChanged || routesChanged) {
        current =
          yield* dialogflow.patchProjectsLocationsAgentsTransitionRouteGroups({
            name: currentName,
            languageCode: news.languageCode,
            updateMask: updateMaskOf(
              displayChanged ? "display_name" : undefined,
              routesChanged ? "transition_routes" : undefined,
            ),
            body: { ...body, name: currentName },
          });
      }

      return toAttrs(current, env.project, agent);
    }, retryQuota),

    delete: Effect.fn(function* ({ output }) {
      yield* dialogflow
        .deleteProjectsLocationsAgentsTransitionRouteGroups({
          name: output.name,
          force: true,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }, retryQuota),
  });

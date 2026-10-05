import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { parentBefore, parseResourceName, sameJson } from "./internal.ts";

export type CollectionsEnginesConversationProps = {
  /**
   * Parent Engine resource name
   * `projects/{project}/locations/{location}/collections/{collection}/engines/{engine}`.
   * Immutable — changing it replaces the conversation.
   */
  engine: string;
  /**
   * User tracking id.
   */
  userPseudoId?: string;
  /**
   * Conversation state.
   */
  state?: discoveryengine.GoogleCloudDiscoveryengineV1ConversationStateEnum;
  /**
   * Conversation messages.
   */
  messages?: discoveryengine.GoogleCloudDiscoveryengineV1ConversationMessageList;
};

export type CollectionsEnginesConversation = Resource<
  "GCP.DiscoveryEngine.CollectionsEnginesConversation",
  CollectionsEnginesConversationProps,
  {
    /** Full resource name. */
    name: string;
    /** Conversation id (last path segment). */
    conversationId: string;
    /** Parent engine resource name. */
    engine: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Collection id. */
    collectionId: string;
    /** Tracking id. */
    userPseudoId: string | undefined;
    /** Conversation state. */
    state: string | undefined;
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine Conversation on a collection Engine.
 *
 * Its id is assigned by the API, so only a recorded resource can be read
 * back. The API assigns the conversation id. Parent engine is immutable;
 * state and messages update in place.
 *
 * ### Creating a Conversation
 * **Example:** Empty conversation
 * ```typescript
 * const conversation =
 *   yield* GCP.DiscoveryEngine.CollectionsEnginesConversation("Chat", {
 *     engine: engine.name,
 *   });
 * ```
 *
 * ### Updating a Conversation
 * **Example:** Complete the conversation
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const conversation =
 *   yield* GCP.DiscoveryEngine.CollectionsEnginesConversation("Chat", {
 *     engine: engine.name,
 *     state: "COMPLETED",
 *   });
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsEnginesConversation =
  Resource<CollectionsEnginesConversation>(
    "GCP.DiscoveryEngine.CollectionsEnginesConversation",
  );

export class CollectionsEnginesConversationNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsEnginesConversationNotResolved",
)<{
  name: string;
}> {}

const getByName = (name: string) =>
  discoveryengine
    .getProjectsLocationsCollectionsEnginesConversations({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const toAttrs = (
  conversation: discoveryengine.GoogleCloudDiscoveryengineV1Conversation,
  project: string,
) => {
  const name = conversation.name ?? "";
  const parsed = parseResourceName(name, "conversations");
  return {
    name,
    conversationId: parsed.id,
    engine: parentBefore(name, "conversations"),
    project: parsed.project || project,
    location: parsed.location,
    collectionId: parsed.collectionId,
    userPseudoId: conversation.userPseudoId,
    state: conversation.state,
    startTime: conversation.startTime,
    endTime: conversation.endTime,
  };
};

export const CollectionsEnginesConversationProvider = () =>
  Provider.succeed(CollectionsEnginesConversation, {
    stables: [
      "name",
      "conversationId",
      "engine",
      "project",
      "location",
      "collectionId",
      "startTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousEngine = olds?.engine ?? output?.engine;
      if (previousEngine !== undefined && news.engine !== previousEngine) {
        return { action: "replace" as const, deleteFirst: false };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ output }) {
      const env = yield* GcpEnvironment.current;
      // Server-assigned id: only a recorded name can be observed.
      if (output?.name === undefined) return undefined;
      const existing = yield* getByName(output.name);
      if (existing === undefined) return undefined;
      return toAttrs(existing, env.project);
    }),

    reconcile: Effect.fn(function* ({ news, output }) {
      const env = yield* GcpEnvironment.current;
      const userPseudoId = news.userPseudoId;
      const fallbackName = output?.name ?? `${news.engine}/conversations/-`;

      let current =
        output?.name !== undefined ? yield* getByName(output.name) : undefined;

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsEnginesConversations({
            parent: news.engine,
            body: {
              userPseudoId,
              state: news.state,
              messages: news.messages,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CollectionsEnginesConversationNotResolved({
          name: fallbackName,
        });
      }

      const name = current.name ?? fallbackName;
      const userChanged =
        userPseudoId !== undefined && current.userPseudoId !== userPseudoId;
      const stateChanged = (current.state ?? "") !== (news.state ?? "");
      const messagesChanged = !sameJson(current.messages, news.messages);

      if (userChanged || stateChanged || messagesChanged) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsEnginesConversations(
            {
              name,
              updateMask: [
                userChanged ? "user_pseudo_id" : undefined,
                stateChanged ? "state" : undefined,
                messagesChanged ? "messages" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name,
                userPseudoId,
                state: news.state,
                messages: news.messages,
              },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsEnginesConversations({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

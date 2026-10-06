import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { parentOf, parseResourceName, sameJson } from "./internal.ts";

export type ConversationMessage = {
  userInput?: {
    input?: string;
    context?: {
      contextDocuments?: string[];
      activeDocument?: string;
    };
  };
};

export type CollectionsDataStoresConversationProps = {
  /**
   * Parent data store resource name. Immutable — changing it replaces
   * the conversation.
   */
  dataStore: string;
  /**
   * Conversation state.
   * @default "IN_PROGRESS"
   */
  state?: "STATE_UNSPECIFIED" | "IN_PROGRESS" | "COMPLETED" | (string & {});
  /**
   * End-user id.
   */
  userPseudoId?: string;
  /**
   * Conversation messages.
   */
  messages?: ConversationMessage[];
};

export type CollectionsDataStoresConversation = Resource<
  "GCP.DiscoveryEngine.CollectionsDataStoresConversation",
  CollectionsDataStoresConversationProps,
  {
    /** Full resource name. */
    name: string;
    /** Conversation id (last path segment). */
    conversationId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Conversation state. */
    state: string | undefined;
    /** User-supplied user pseudo id with the Alchemy token stripped. */
    userPseudoId: string | undefined;
    /** Conversation messages. */
    messages: ConversationMessage[];
    /** RFC3339 start time. */
    startTime: string | undefined;
    /** RFC3339 end time. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine conversation on a collection data store.
 *
 * Its id is assigned by the API, so only a recorded resource can be read
 * back. The parent data store is immutable. State and messages update in
 * place. The conversation id is assigned by the API.
 *
 * ### Creating a Conversation
 * **Example:** Open a conversation
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.CollectionsDataStore("Docs", {});
 * const chat = yield* GCP.DiscoveryEngine.CollectionsDataStoresConversation(
 *   "Visitor",
 *   {
 *     dataStore: store.name,
 *     userPseudoId: "user-1",
 *   },
 * );
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsDataStoresConversation =
  Resource<CollectionsDataStoresConversation>(
    "GCP.DiscoveryEngine.CollectionsDataStoresConversation",
  );

export class CollectionsDataStoresConversationNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsDataStoresConversationNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  conversation: discoveryengine.GoogleCloudDiscoveryengineV1Conversation,
  project: string,
) => {
  const name = conversation.name ?? "";
  const parsed = parseResourceName(name, "conversations");
  return {
    name,
    conversationId: parsed.id,
    dataStore: parentOf(name, "conversations"),
    project: parsed.project || project,
    location: parsed.location,
    state: conversation.state,
    userPseudoId: conversation.userPseudoId,
    messages: (conversation.messages ?? []).map((message) => ({
      userInput: message.userInput
        ? {
            input: message.userInput.input,
            context: message.userInput.context,
          }
        : undefined,
    })),
    startTime: conversation.startTime,
    endTime: conversation.endTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStoresConversations({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const CollectionsDataStoresConversationProvider = () =>
  Provider.succeed(CollectionsDataStoresConversation, {
    stables: [
      "name",
      "conversationId",
      "dataStore",
      "project",
      "location",
      "startTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      if (previousParent !== undefined && news.dataStore !== previousParent) {
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
      const state = news.state ?? "IN_PROGRESS";

      let current = yield* getByName(output?.name ?? "");

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStoresConversations({
            parent: news.dataStore,
            body: {
              state,
              userPseudoId,
              messages: news.messages,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoresConversationNotResolved({
          name: output?.name ?? `${news.dataStore}/conversations/-`,
        });
      }

      const resource = current.name ?? "";
      const stateChanged = (current.state ?? "") !== state;
      const userChanged =
        userPseudoId !== undefined && current.userPseudoId !== userPseudoId;
      const messagesChanged = !sameJson(current.messages, news.messages);

      if (stateChanged || userChanged || messagesChanged) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStoresConversations(
            {
              name: resource,
              updateMask: [
                stateChanged ? "state" : undefined,
                userChanged ? "user_pseudo_id" : undefined,
                messagesChanged ? "messages" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name: resource,
                state,
                userPseudoId,
                messages: news.messages,
              },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsDataStoresConversations({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

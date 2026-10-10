import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import { expandDataStore, parseResourceName } from "./internal.ts";

export type DataStoresConversationProps = {
  /**
   * Parent Data Store resource name
   * `projects/{project}/locations/{location}/dataStores/{dataStore}`.
   * Immutable — changing it replaces the conversation.
   */
  dataStore: string;
  /**
   * Unique identifier for tracking users.
   */
  userPseudoId?: string;
  /**
   * Conversation state (`IN_PROGRESS`, `COMPLETED`).
   */
  state?: string;
};

export type DataStoresConversation = Resource<
  "GCP.DiscoveryEngine.DataStoresConversation",
  DataStoresConversationProps,
  {
    /** Full resource name `.../dataStores/{dataStore}/conversations/{id}`. */
    name: string;
    /** Conversation id (last path segment). Server-assigned on create. */
    conversationId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Pseudo id. */
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
 * A Vertex AI Search Conversation attached to a Data Store.
 *
 * Its id is assigned by the API, so only a recorded resource can be read
 * back. The conversation id is server-assigned. Parent is immutable; user id
 * and state update in place.
 *
 * ### Creating a Conversation
 * **Example:** Start a conversation
 * ```typescript
 * const conversation = yield* GCP.DiscoveryEngine.DataStoresConversation(
 *   "Support",
 *   { dataStore: dataStore.name },
 * );
 * ```
 *
 * ### Updating a Conversation
 * **Example:** Mark completed
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const conversation = yield* GCP.DiscoveryEngine.DataStoresConversation(
 *   "Support",
 *   {
 *     dataStore: dataStore.name,
 *     state: "COMPLETED",
 *   },
 * );
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const DataStoresConversation = Resource<DataStoresConversation>(
  "GCP.DiscoveryEngine.DataStoresConversation",
);

export class DataStoresConversationNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.DataStoresConversationNotResolved",
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
    dataStore: parsed.dataStore,
    project: parsed.project || project,
    location: parsed.location,
    userPseudoId: conversation.userPseudoId,
    state: conversation.state,
    startTime: conversation.startTime,
    endTime: conversation.endTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsDataStoresConversations({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const DataStoresConversationProvider = () =>
  Provider.succeed(DataStoresConversation, {
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
      const parent = expandDataStore(
        news.dataStore,
        env.project,
        output?.location ?? "global",
      );
      const userPseudoId = news.userPseudoId;

      let current = yield* getByName(output?.name ?? "");

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsDataStoresConversations({
            parent,
            body: {
              userPseudoId,
              state: news.state,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DataStoresConversationNotResolved({
          name: output?.name ?? `${parent}/conversations`,
        });
      }

      const userChanged =
        userPseudoId !== undefined && current.userPseudoId !== userPseudoId;
      const stateChanged =
        news.state !== undefined && (current.state ?? "") !== news.state;

      if (userChanged || stateChanged) {
        current =
          yield* discoveryengine.patchProjectsLocationsDataStoresConversations({
            name: current.name ?? "",
            updateMask: [
              userChanged ? "user_pseudo_id" : undefined,
              stateChanged ? "state" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name,
              userPseudoId,
              state: news.state,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsDataStoresConversations({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

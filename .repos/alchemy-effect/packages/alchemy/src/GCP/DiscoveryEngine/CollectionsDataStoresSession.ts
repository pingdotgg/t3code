import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  parentOf,
  parseResourceName,
  sessionIdOf,
  toPhysical,
} from "./internal.ts";

export type CollectionsDataStoresSessionProps = {
  /**
   * Parent data store resource name. Immutable — changing it replaces
   * the session.
   */
  dataStore: string;
  /**
   * Session id (`[a-z0-9]`, 1-63 characters). If omitted, a unique id is
   * generated. Immutable — changing it replaces the session.
   */
  sessionId?: string;
  /**
   * Display name used in the UI (max 128 characters).
   */
  displayName?: string;
  /**
   * Session state.
   * @default "IN_PROGRESS"
   */
  state?: "STATE_UNSPECIFIED" | "IN_PROGRESS" | (string & {});
  /**
   * End-user id.
   */
  userPseudoId?: string;
  /**
   * Session labels.
   */
  labels?: string[];
  /**
   * Pin the session to the top of the session list.
   * @default false
   */
  isPinned?: boolean;
};

export type CollectionsDataStoresSession = Resource<
  "GCP.DiscoveryEngine.CollectionsDataStoresSession",
  CollectionsDataStoresSessionProps,
  {
    /** Full resource name. */
    name: string;
    /** Session id. */
    sessionId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** Session state. */
    state: string | undefined;
    /** End-user id. */
    userPseudoId: string | undefined;
    /** Labels. */
    labels: string[];
    /** Whether the session is pinned. */
    isPinned: boolean;
    /** RFC3339 start time. */
    startTime: string | undefined;
    /** RFC3339 end time. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Discovery Engine session on a collection data store.
 *
 * Without labels, ownership rests on the deterministic id: `read` reports a
 * resource it finds without prior state as unowned (adopt it with `--adopt`).
 * Parent and session id are immutable.
 *
 * ### Creating a Session
 * **Example:** Pinned session
 * ```typescript
 * const store = yield* GCP.DiscoveryEngine.CollectionsDataStore("Docs", {});
 * const session = yield* GCP.DiscoveryEngine.CollectionsDataStoresSession(
 *   "Chat",
 *   {
 *     dataStore: store.name,
 *     displayName: "support chat",
 *     isPinned: true,
 *   },
 * );
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const CollectionsDataStoresSession =
  Resource<CollectionsDataStoresSession>(
    "GCP.DiscoveryEngine.CollectionsDataStoresSession",
  );

export class CollectionsDataStoresSessionNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.CollectionsDataStoresSessionNotResolved",
)<{
  name: string;
}> {}

const toAttrs = (
  session: discoveryengine.GoogleCloudDiscoveryengineV1Session,
  project: string,
) => {
  const name = session.name ?? "";
  const parsed = parseResourceName(name, "sessions");
  return {
    name,
    sessionId: parsed.id,
    dataStore: parentOf(name, "sessions"),
    project: parsed.project || project,
    location: parsed.location,
    displayName: session.displayName,
    state: session.state,
    userPseudoId: session.userPseudoId,
    labels: [...(session.labels ?? [])],
    isPinned: session.isPinned === true,
    startTime: session.startTime,
    endTime: session.endTime,
  };
};

const resourceName = (dataStore: string, sessionId: string) =>
  `${dataStore}/sessions/${sessionId}`;

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsCollectionsDataStoresSessions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

export const CollectionsDataStoresSessionProvider = () =>
  Provider.succeed(CollectionsDataStoresSession, {
    stables: [
      "name",
      "sessionId",
      "dataStore",
      "project",
      "location",
      "startTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.dataStore ?? output?.dataStore;
      const previousId = olds?.sessionId ?? output?.sessionId;
      if (
        (previousParent !== undefined && news.dataStore !== previousParent) ||
        (previousId !== undefined &&
          news.sessionId !== undefined &&
          news.sessionId !== previousId)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousParent === news.dataStore &&
            previousId !== undefined &&
            news.sessionId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = olds?.dataStore ?? output?.dataStore;
      const childId = yield* toPhysical(
        id,
        olds?.sessionId,
        output?.sessionId,
        sessionIdOf,
      );
      const name =
        output?.name ??
        (parent !== undefined ? resourceName(parent, childId) : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      // No labels field: without prior state it may not be ours.
      return output !== undefined ? attrs : Unowned(attrs);
    }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const sessionId = yield* toPhysical(
        id,
        news.sessionId,
        output?.sessionId,
        sessionIdOf,
      );
      const name = resourceName(news.dataStore, sessionId);
      const displayName = news.displayName ?? sessionId;
      const labels = news.labels ?? [];
      const state = news.state ?? "IN_PROGRESS";
      const desiredPinned = news.isPinned === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsCollectionsDataStoresSessions({
            parent: news.dataStore,
            sessionId,
            body: {
              displayName,
              state,
              userPseudoId: news.userPseudoId,
              labels,
              isPinned: desiredPinned ? true : undefined,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new CollectionsDataStoresSessionNotResolved({ name });
      }

      const resource = current.name ?? name;
      const displayNameChanged = (current.displayName ?? "") !== displayName;
      const stateChanged = (current.state ?? "") !== state;
      const userChanged =
        (current.userPseudoId ?? "") !== (news.userPseudoId ?? "");
      const observedLabels = [...(current.labels ?? [])].sort().join("\0");
      const desiredLabels = [...labels].sort().join("\0");
      const labelsChanged = observedLabels !== desiredLabels;
      const pinnedChanged = (current.isPinned === true) !== desiredPinned;

      if (
        displayNameChanged ||
        stateChanged ||
        userChanged ||
        labelsChanged ||
        pinnedChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsCollectionsDataStoresSessions(
            {
              name: resource,
              updateMask: [
                displayNameChanged ? "display_name" : undefined,
                stateChanged ? "state" : undefined,
                userChanged ? "user_pseudo_id" : undefined,
                labelsChanged ? "labels" : undefined,
                pinnedChanged ? "is_pinned" : undefined,
              ]
                .filter((field): field is string => field !== undefined)
                .join(","),
              body: {
                name: resource,
                displayName,
                state,
                userPseudoId: news.userPseudoId,
                labels,
                isPinned: desiredPinned,
              },
            },
          );
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      yield* discoveryengine
        .deleteProjectsLocationsCollectionsDataStoresSessions({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

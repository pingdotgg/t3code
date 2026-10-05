import * as discoveryengine from "@distilled.cloud/gcp/discoveryengine_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { alchemyLabelKeys, hasAlchemyLabels } from "../Labels.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  expandDataStore,
  internalLabels,
  listProjectDataStores,
  parseResourceName,
  sameStringList,
  sessionIdOf,
  toPhysical,
} from "./internal.ts";

export type DataStoresSessionProps = {
  /**
   * Parent Data Store resource name
   * `projects/{project}/locations/{location}/dataStores/{dataStore}`.
   * Immutable — changing it replaces the session.
   */
  dataStore: string;
  /**
   * Session id (1-63 characters, lowercase alphanumeric). If omitted, a
   * unique id is generated. Immutable — changing it replaces the session.
   */
  sessionId?: string;
  /**
   * Display name shown in the UI.
   */
  displayName?: string;
  /**
   * Unique identifier for tracking users.
   */
  userPseudoId?: string;
  /**
   * Session state (`IN_PROGRESS`, `STATE_UNSPECIFIED`).
   */
  state?: string;
  /**
   * When true, the session is pinned to the top of the list.
   * @default false
   */
  isPinned?: boolean;
  /**
   * User labels (string values). Alchemy adds `alchemy-stack=…`,
   * `alchemy-stage=…`, and `alchemy-id=…` entries to mark ownership.
   */
  labels?: string[];
};

export type DataStoresSession = Resource<
  "GCP.DiscoveryEngine.DataStoresSession",
  DataStoresSessionProps,
  {
    /** Full resource name `.../dataStores/{dataStore}/sessions/{session}`. */
    name: string;
    /** Session id (last path segment). */
    sessionId: string;
    /** Parent data store resource name. */
    dataStore: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** Display name. */
    displayName: string | undefined;
    /** User pseudo id. */
    userPseudoId: string | undefined;
    /** Session state. */
    state: string | undefined;
    /** Whether the session is pinned. */
    isPinned: boolean;
    /** User labels (without Alchemy's `alchemy-*` entries). */
    labels: string[];
    /** RFC3339 start timestamp. */
    startTime: string | undefined;
    /** RFC3339 end timestamp. */
    endTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Search Session attached to a Data Store.
 *
 * Alchemy marks ownership with `alchemy-*` entries in the session's
 * string-list `labels`. Parent and session id are immutable; display name, pin, user id, and labels
 * update in place.
 *
 * ### Creating a Session
 * **Example:** Generated id
 * ```typescript
 * const session = yield* GCP.DiscoveryEngine.DataStoresSession("Chat", {
 *   dataStore: dataStore.name,
 *   displayName: "support",
 * });
 * ```
 *
 * ### Updating a Session
 * **Example:** Pin and rename
 * ```typescript
 * // Same logical id as before; only the changed props differ.
 * const session = yield* GCP.DiscoveryEngine.DataStoresSession("Chat", {
 *   dataStore: dataStore.name,
 *   displayName: "vip-support",
 *   isPinned: true,
 * });
 * ```
 *
 * @resource
 * @category DiscoveryEngine
 */
export const DataStoresSession = Resource<DataStoresSession>(
  "GCP.DiscoveryEngine.DataStoresSession",
);

export class DataStoresSessionNotResolved extends Data.TaggedError(
  "GCP.DiscoveryEngine.DataStoresSessionNotResolved",
)<{
  name: string;
}> {}

const resourceName = (dataStore: string, sessionId: string) =>
  `${dataStore}/sessions/${sessionId}`;

const ownershipLabels = (labels: Record<string, string>): string[] => [
  `${alchemyLabelKeys.stack}=${labels[alchemyLabelKeys.stack]}`,
  `${alchemyLabelKeys.stage}=${labels[alchemyLabelKeys.stage]}`,
  `${alchemyLabelKeys.id}=${labels[alchemyLabelKeys.id]}`,
];

const userStringLabels = (labels: readonly string[] | undefined): string[] =>
  [...(labels ?? [])].filter((label) => !label.startsWith("alchemy-"));

/** Parse `alchemy-*=value` session labels back into a label map. */
const alchemyLabelsOf = (labels: readonly string[] | undefined) =>
  Object.fromEntries(
    (labels ?? [])
      .filter((label) => label.startsWith("alchemy-") && label.includes("="))
      .map((label) => {
        const at = label.indexOf("=");
        return [label.slice(0, at), label.slice(at + 1)] as const;
      }),
  );

const toAttrs = (
  session: discoveryengine.GoogleCloudDiscoveryengineV1Session,
  project: string,
) => {
  const name = session.name ?? "";
  const parsed = parseResourceName(name, "sessions");
  return {
    name,
    sessionId: parsed.id,
    dataStore: parsed.dataStore,
    project: parsed.project || project,
    location: parsed.location,
    displayName: session.displayName,
    userPseudoId: session.userPseudoId,
    state: session.state,
    isPinned: session.isPinned === true,
    labels: userStringLabels(session.labels),
    startTime: session.startTime,
    endTime: session.endTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : discoveryengine
        .getProjectsLocationsDataStoresSessions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const listAtParent = (parent: string) =>
  discoveryengine.listProjectsLocationsDataStoresSessions
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sessions ?? [])),
      Stream.filter((session) =>
        (session.labels ?? []).some((label) => label.startsWith("alchemy-")),
      ),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const DataStoresSessionProvider = () =>
  Provider.succeed(DataStoresSession, {
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
      if (previousParent !== undefined && news.dataStore !== previousParent) {
        return { action: "replace" as const, deleteFirst: false };
      }
      const previousId = olds?.sessionId ?? output?.sessionId;
      if (
        previousId !== undefined &&
        news.sessionId !== undefined &&
        news.sessionId !== previousId
      ) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sessionId = yield* toPhysical(
        id,
        olds?.sessionId,
        output?.sessionId,
        sessionIdOf,
      );
      const parent = olds?.dataStore
        ? expandDataStore(
            olds.dataStore,
            env.project,
            output?.location ?? "global",
          )
        : undefined;
      const name =
        output?.name ?? (parent ? resourceName(parent, sessionId) : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, alchemyLabelsOf(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const stores = yield* listProjectDataStores(env.project);
        const pages = yield* Effect.forEach(
          stores,
          (store) =>
            store.name
              ? listAtParent(store.name).pipe(
                  Effect.map((sessions) =>
                    sessions.map((session) => toAttrs(session, env.project)),
                  ),
                )
              : Effect.succeed([]),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const parent = expandDataStore(
        news.dataStore,
        env.project,
        output?.location ?? "global",
      );
      const sessionId = yield* toPhysical(
        id,
        news.sessionId,
        output?.sessionId,
        sessionIdOf,
      );
      const name = resourceName(parent, sessionId);
      const displayName = news.displayName;
      const labels = yield* internalLabels(id);
      const desiredLabels = [
        ...ownershipLabels(labels),
        ...userStringLabels(news.labels),
      ];

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* discoveryengine
          .createProjectsLocationsDataStoresSessions({
            parent,
            sessionId,
            body: {
              displayName,
              userPseudoId: news.userPseudoId,
              state: news.state,
              isPinned: news.isPinned === true ? true : undefined,
              labels: desiredLabels,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => getByName(name)));
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new DataStoresSessionNotResolved({ name });
      }

      const displayChanged =
        (current.displayName ?? "") !== (displayName ?? "");
      const userChanged =
        (current.userPseudoId ?? "") !== (news.userPseudoId ?? "");
      const stateChanged =
        news.state !== undefined && (current.state ?? "") !== news.state;
      const pinChanged =
        (current.isPinned === true) !== (news.isPinned === true);
      const labelsChanged = !sameStringList(current.labels, desiredLabels);

      if (
        displayChanged ||
        userChanged ||
        stateChanged ||
        pinChanged ||
        labelsChanged
      ) {
        current =
          yield* discoveryengine.patchProjectsLocationsDataStoresSessions({
            name: current.name ?? name,
            updateMask: [
              displayChanged ? "display_name" : undefined,
              userChanged ? "user_pseudo_id" : undefined,
              stateChanged ? "state" : undefined,
              pinChanged ? "is_pinned" : undefined,
              labelsChanged ? "labels" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              displayName,
              userPseudoId: news.userPseudoId,
              state: news.state,
              isPinned: news.isPinned === true,
              labels: desiredLabels,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      yield* discoveryengine
        .deleteProjectsLocationsDataStoresSessions({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.void));
    }),
  });

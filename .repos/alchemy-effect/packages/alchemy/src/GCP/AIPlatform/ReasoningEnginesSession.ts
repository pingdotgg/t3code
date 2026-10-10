import * as aiplatform from "@distilled.cloud/gcp/aiplatform_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import {
  createInternalLabels,
  diffLabels,
  hasAlchemyLabels,
  stripInternalLabels,
  toLabels,
} from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import { listLocations } from "./names.ts";
import { resourceNameFromOperation, waitForOperation } from "./operations.ts";
import {
  lastSegment,
  locationOf,
  locationParent,
  parentOf,
  toResourceId,
} from "./ownership.ts";

export type ReasoningEnginesSessionProps = {
  /**
   * Parent ReasoningEngine resource name
   * (`projects/{project}/locations/{location}/reasoningEngines/{reasoning_engine}`).
   * Immutable — changing it replaces the session.
   */
  parent: string;
  /**
   * Session id (the `{session}` segment). If omitted, a unique id is
   * generated. Immutable.
   */
  sessionId?: string;
  /**
   * Immutable user id that owns the session.
   */
  userId: string;
  /**
   * User-facing display name.
   */
  displayName?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Session TTL (for example `"86400s"`). Minimum 24 hours.
   */
  ttl?: string;
  /**
   * RFC3339 expiration timestamp. Minimum 24 hours from create time.
   */
  expireTime?: string;
  /**
   * Session-specific memory storing key conversation points.
   */
  sessionState?: Record<string, unknown>;
};

export type ReasoningEnginesSession = Resource<
  "GCP.AIPlatform.ReasoningEnginesSession",
  ReasoningEnginesSessionProps,
  {
    /** Full resource name. */
    name: string;
    /** Session id (last path segment). */
    sessionId: string;
    /** Parent ReasoningEngine resource name. */
    parent: string;
    /** Region id. */
    location: string;
    /** Project id. */
    project: string;
    /** User id that owns the session. */
    userId: string | undefined;
    /** User-facing display name. */
    displayName: string | undefined;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Expiration timestamp. */
    expireTime: string | undefined;
    /** Session memory. */
    sessionState: Record<string, unknown> | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
    /** RFC3339 last-update timestamp. */
    updateTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Vertex AI Reasoning Engine session between a user and an agent.
 *
 * Parent engine, session id, and user id are immutable. Display name,
 * labels, expiration, and session state update in place.
 *
 * ### Creating a Session
 * **Example:** Session for a user
 * ```typescript
 * const session = yield* GCP.AIPlatform.ReasoningEnginesSession("Chat", {
 *   parent: engine.name,
 *   userId: "user-123",
 *   displayName: "support-chat",
 * });
 * ```
 *
 * @resource
 * @category AIPlatform
 */
export const ReasoningEnginesSession = Resource<ReasoningEnginesSession>(
  "GCP.AIPlatform.ReasoningEnginesSession",
);

export class ReasoningEnginesSessionNotResolved extends Data.TaggedError(
  "GCP.AIPlatform.ReasoningEnginesSessionNotResolved",
)<{
  name: string;
}> {}

const userLabels = (
  labels: Record<string, string | undefined> | null | undefined,
): Record<string, string> => stripInternalLabels(tagRecord(labels));

const resourceName = (parent: string, sessionId: string) =>
  `${parent}/sessions/${sessionId}`;

const toAttrs = (
  session: aiplatform.GoogleCloudAiplatformV1Session,
  project: string,
) => {
  const name = session.name ?? "";
  return {
    name,
    sessionId: lastSegment(name),
    parent: parentOf(name),
    location: locationOf(name),
    project,
    userId: session.userId,
    displayName: session.displayName,
    labels: userLabels(session.labels),
    expireTime: session.expireTime,
    sessionState: session.sessionState,
    createTime: session.createTime,
    updateTime: session.updateTime,
  };
};

const getByName = (name: string) =>
  name.length === 0
    ? Effect.succeed(undefined)
    : aiplatform
        .getProjectsLocationsReasoningEnginesSessions({ name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((session) =>
      session
        ? Effect.succeed(session)
        : Effect.fail(new ReasoningEnginesSessionNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.AIPlatform.ReasoningEnginesSessionNotResolved",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const listEngines = (project: string, location: string) =>
  aiplatform.listProjectsLocationsReasoningEngines
    .pages({
      parent: locationParent(project, location),
      pageSize: 100,
    })
    .pipe(
      Stream.flatMap((page) =>
        Stream.fromIterable(page.reasoningEngines ?? []),
      ),
      Stream.map((engine) => engine.name ?? ""),
      Stream.filter((name) => name.length > 0),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([] as string[])),
    );

const listAtParent = (parent: string, project: string) =>
  aiplatform.listProjectsLocationsReasoningEnginesSessions
    .pages({ parent, pageSize: 100 })
    .pipe(
      Stream.flatMap((page) => Stream.fromIterable(page.sessions ?? [])),
      Stream.filter((session) =>
        Object.keys(session.labels ?? {}).some((key) =>
          key.startsWith("alchemy-"),
        ),
      ),
      Stream.map((session) => toAttrs(session, project)),
      Stream.runCollect,
      Effect.map((chunk) => Array.from(chunk)),
      Effect.catchTag("NotFound", () => Effect.succeed([])),
    );

export const ReasoningEnginesSessionProvider = () =>
  Provider.succeed(ReasoningEnginesSession, {
    stables: [
      "name",
      "sessionId",
      "parent",
      "location",
      "project",
      "userId",
      "createTime",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousParent = olds?.parent ?? output?.parent;
      if (previousParent !== undefined && news.parent !== previousParent) {
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
      const previousUser = olds?.userId ?? output?.userId;
      if (previousUser !== undefined && news.userId !== previousUser) {
        return { action: "replace" as const, deleteFirst: true };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const sessionId = yield* toResourceId(
        id,
        olds?.sessionId,
        output?.sessionId,
      );
      const name =
        output?.name ??
        (olds?.parent !== undefined
          ? resourceName(olds.parent, sessionId)
          : "");
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const engines = (yield* Effect.forEach(
          listLocations(env.region),
          (location) => listEngines(env.project, location),
        )).flat();
        const pages = yield* Effect.forEach(
          engines,
          (parent) => listAtParent(parent, env.project),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const sessionId = yield* toResourceId(
        id,
        news.sessionId,
        output?.sessionId,
      );
      const name = resourceName(news.parent, sessionId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* aiplatform
          .createProjectsLocationsReasoningEnginesSessions({
            parent: news.parent,
            sessionId,
            body: {
              userId: news.userId,
              displayName: news.displayName,
              labels: desiredLabels,
              ttl: news.ttl,
              expireTime: news.expireTime,
              sessionState: news.sessionState,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          const done = yield* waitForOperation(created, {
            alreadyExistsOk: true,
          });
          const createdName = resourceNameFromOperation(done) ?? name;
          current = yield* waitUntilExists(createdName);
        } else {
          current = yield* getByName(name);
        }
      }

      if (current === undefined) {
        return yield* new ReasoningEnginesSessionNotResolved({ name });
      }

      const observedLabels = tagRecord(current.labels);
      const { upsert, removed } = diffLabels(observedLabels, desiredLabels);
      const labelsChanged = upsert.length > 0 || removed.length > 0;
      const displayChanged =
        (current.displayName ?? "") !== (news.displayName ?? "");
      const expireChanged =
        news.expireTime !== undefined &&
        (current.expireTime ?? "") !== news.expireTime;
      const stateChanged =
        news.sessionState !== undefined &&
        JSON.stringify(current.sessionState ?? {}) !==
          JSON.stringify(news.sessionState ?? {});

      if (labelsChanged || displayChanged || expireChanged || stateChanged) {
        current =
          yield* aiplatform.patchProjectsLocationsReasoningEnginesSessions({
            name: current.name ?? name,
            updateMask: [
              labelsChanged ? "labels" : undefined,
              displayChanged ? "displayName" : undefined,
              expireChanged ? "expireTime" : undefined,
              stateChanged ? "sessionState" : undefined,
            ]
              .filter((field): field is string => field !== undefined)
              .join(","),
            body: {
              name: current.name ?? name,
              displayName: news.displayName,
              labels: desiredLabels,
              expireTime: news.expireTime,
              sessionState: news.sessionState,
            },
          });
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const existing = yield* getByName(output.name);
      if (existing === undefined) return;
      const operation = yield* aiplatform
        .deleteProjectsLocationsReasoningEnginesSessions({
          name: output.name,
        })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
    }),
  });

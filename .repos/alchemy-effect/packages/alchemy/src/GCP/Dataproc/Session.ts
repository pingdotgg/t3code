import * as dataproc from "@distilled.cloud/gcp/dataproc_v1";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { tagRecord } from "../../Tags.ts";
import { GcpEnvironment } from "../Environment.ts";
import { createInternalLabels, hasAlchemyLabels, toLabels } from "../Labels.ts";
import type { Providers } from "../Providers.ts";
import {
  collectPages,
  LIST_LOCATIONS,
  MAX_POLLS,
  MAX_WORKLOAD_ID_LENGTH,
  emptyOnMissing,
  hasAlchemyLabelMap,
  locationParent,
  normalizeLocation,
  parseResourceName,
  toPhysicalId,
  userLabels,
  waitForOperation,
  waitUntilExists,
  waitUntilGone,
} from "./internal.ts";

const READY = new Set(["ACTIVE", "TERMINATING", "TERMINATED", "FAILED"]);

export type SessionProps = {
  /**
   * Session id (the `{session}` segment of
   * `projects/{project}/locations/{location}/sessions/{session}`). If
   * omitted, a unique RFC1035 name is generated. Immutable — changing it
   * replaces the session.
   */
  sessionId?: string;
  /**
   * Location (`us-central1`, …). Immutable — changing it replaces the
   * session. `US-CENTRAL1` is accepted and normalized to `us-central1`.
   * @default the stack's GCP region (`GCP.Region`, profile region, `us-central1`)
   */
  location?: string;
  /**
   * User labels. Alchemy ownership labels are merged in automatically.
   */
  labels?: Record<string, string>;
  /**
   * Existing session template resource name. If omitted, `jupyterSession`
   * (default PYTHON) is used.
   */
  sessionTemplate?: string;
  /**
   * Jupyter kernel config.
   */
  jupyterSession?: dataproc.JupyterConfig;
  /**
   * Spark Connect session config.
   */
  sparkConnectSession?: dataproc.SparkConnectConfig;
  /**
   * Runtime configuration (version, properties, container image).
   */
  runtimeConfig?: dataproc.RuntimeConfig;
  /**
   * Environment configuration (execution and peripherals).
   */
  environmentConfig?: dataproc.EnvironmentConfig;
  /**
   * Email of the user who owns the session.
   */
  user?: string;
};

export type Session = Resource<
  "GCP.Dataproc.Session",
  SessionProps,
  {
    /** Full resource name `projects/{project}/locations/{location}/sessions/{session}`. */
    name: string;
    /** Session id (last path segment). */
    sessionId: string;
    /** Project id. */
    project: string;
    /** Location id. */
    location: string;
    /** User labels (Alchemy ownership labels stripped). */
    labels: Record<string, string>;
    /** Server-reported state (`ACTIVE`, `CREATING`, …). */
    state: string | undefined;
    /** Extra status text, if any. */
    stateMessage: string | undefined;
    /** Session template used, if any. */
    sessionTemplate: string | undefined;
    /** Server-assigned uuid. */
    uuid: string | undefined;
    /** Creator email. */
    creator: string | undefined;
    /** RFC3339 creation timestamp. */
    createTime: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Dataproc serverless interactive session.
 *
 * Sessions are immutable after create. Changing identity or config
 * replaces the session. Provisioning typically takes several minutes.
 *
 * ### Creating a Session
 * **Example:** Jupyter session
 * ```typescript
 * const session = yield* GCP.Dataproc.Session("Notebook", {
 *   jupyterSession: { kernel: "PYTHON" },
 *   environmentConfig: { executionConfig: { idleTtl: "600s", ttl: "3600s" } },
 * });
 * ```
 *
 * **Example:** From a session template
 * ```typescript
 * const session = yield* GCP.Dataproc.Session("Notebook", {
 *   sessionTemplate: template.name,
 * });
 * ```
 *
 * @resource
 * @category Dataproc
 */
export const Session = Resource<Session>("GCP.Dataproc.Session");

export class SessionNotResolved extends Data.TaggedError(
  "GCP.Dataproc.SessionNotResolved",
)<{
  name: string;
}> {}

export class SessionFailed extends Data.TaggedError(
  "GCP.Dataproc.SessionFailed",
)<{
  name: string;
  state: string | undefined;
  detail: string | undefined;
}> {}

export class SessionNotReady extends Data.TaggedError(
  "GCP.Dataproc.SessionNotReady",
)<{
  name: string;
  state: string | undefined;
}> {}

const resourceName = (project: string, location: string, sessionId: string) =>
  `${locationParent(project, location)}/sessions/${sessionId}`;

const defaultJupyter = (
  news: SessionProps,
): dataproc.JupyterConfig | undefined => {
  if (news.sessionTemplate !== undefined) return news.jupyterSession;
  if (news.sparkConnectSession !== undefined) return undefined;
  return news.jupyterSession ?? { kernel: "PYTHON" };
};

const toAttrs = (
  session: dataproc.Session,
  project: string,
  location: string,
) => {
  const name = session.name ?? "";
  const parsed = parseResourceName(name, "sessions", location);
  return {
    name,
    sessionId: parsed.id,
    project: parsed.project || project,
    location: parsed.location || location,
    labels: userLabels(session.labels),
    state: session.state,
    stateMessage: session.stateMessage,
    sessionTemplate: session.sessionTemplate,
    uuid: session.uuid,
    creator: session.creator,
    createTime: session.createTime,
  };
};

// Dataproc rejects a session create whose body omits `name` with a bare
// `INVALID_ARGUMENT`.
const desiredBody = (
  news: SessionProps,
  name: string,
  desiredLabels: Record<string, string>,
): dataproc.Session => ({
  name,
  labels: desiredLabels,
  sessionTemplate: news.sessionTemplate,
  jupyterSession: defaultJupyter(news),
  sparkConnectSession: news.sparkConnectSession,
  runtimeConfig: news.runtimeConfig,
  environmentConfig: news.environmentConfig ?? {
    executionConfig: { idleTtl: "600s", ttl: "3600s" },
  },
  user: news.user,
});

const getByName = (name: string) =>
  dataproc
    .getProjectsLocationsSessions({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilReady = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((session) =>
      session
        ? Effect.succeed(session)
        : Effect.fail(new SessionNotResolved({ name })),
    ),
    Effect.filterOrFail(
      (session) => session.state !== "FAILED",
      (session) =>
        new SessionFailed({
          name,
          state: session.state,
          detail: session.stateMessage,
        }),
    ),
    Effect.filterOrFail(
      (session) => READY.has(session.state ?? ""),
      (session) =>
        new SessionNotReady({
          name,
          state: session.state,
        }),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Dataproc.SessionNotReady" ||
        error._tag === "GCP.Dataproc.SessionNotResolved",
      times: MAX_POLLS,
      schedule: Schedule.spaced("5 seconds"),
    }),
  );

const listLocation = (project: string, location: string) =>
  emptyOnMissing(
    collectPages(
      dataproc.listProjectsLocationsSessions.pages({
        parent: locationParent(project, location),
        pageSize: 1000,
      }),
      (page) => page.sessions,
    ).pipe(
      Effect.map((items) =>
        items
          .filter((session) => hasAlchemyLabelMap(session.labels))
          .map((session) => toAttrs(session, project, location)),
      ),
    ),
  );

export const SessionProvider = () =>
  Provider.succeed(Session, {
    stables: ["name", "sessionId", "project", "location", "uuid", "createTime"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const env = yield* GcpEnvironment.current;
      const previousId = olds?.sessionId ?? output?.sessionId;
      const nextId = news.sessionId ?? previousId;
      const previousLocation = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const nextLocation = normalizeLocation(
        news.location ?? olds?.location ?? output?.location,
        env.region,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (output !== undefined && previousLocation !== nextLocation)
      ) {
        return {
          action: "replace" as const,
          deleteFirst:
            previousLocation === nextLocation &&
            previousId !== undefined &&
            nextId === previousId,
        };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        olds?.location ?? output?.location,
        env.region,
      );
      const sessionId = yield* toPhysicalId(
        id,
        olds?.sessionId,
        output?.sessionId,
        MAX_WORKLOAD_ID_LENGTH,
        "session",
      );
      const name =
        output?.name ?? resourceName(env.project, location, sessionId);
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project, location);
      return (yield* hasAlchemyLabels(id, tagRecord(existing.labels)))
        ? attrs
        : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const pages = yield* Effect.forEach(
          [...new Set([env.region, ...LIST_LOCATIONS])],
          (location) => listLocation(env.project, location),
          { concurrency: 4 },
        );
        return pages.flat();
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const location = normalizeLocation(
        news.location ?? output?.location,
        env.region,
      );
      const sessionId = yield* toPhysicalId(
        id,
        news.sessionId,
        output?.sessionId,
        MAX_WORKLOAD_ID_LENGTH,
        "session",
      );
      const name = resourceName(env.project, location, sessionId);
      const desiredLabels = {
        ...toLabels(news.labels),
        ...(yield* createInternalLabels(id)),
      };
      const desired = desiredBody(news, name, desiredLabels);

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* dataproc
          .createProjectsLocationsSessions({
            parent: locationParent(env.project, location),
            sessionId,
            body: desired,
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created) {
          yield* waitForOperation(created);
        }
        current = yield* waitUntilExists(getByName(name), name);
        current = yield* waitUntilReady(name);
      }

      if (current === undefined) {
        return yield* new SessionNotResolved({ name });
      }

      return toAttrs(current, env.project, location);
    }),

    delete: Effect.fn(function* ({ output }) {
      if (!output.name) return;
      const operation = yield* dataproc
        .deleteProjectsLocationsSessions({ name: output.name })
        .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));
      if (operation !== undefined) {
        yield* waitForOperation(operation, { notFoundOk: true });
      }
      yield* waitUntilGone(getByName(output.name), output.name);
    }),
  });

import * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { GcpEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  instanceIdOf,
  instanceNameOf,
  listAlchemyInstances,
  materializedViewName,
  MAX_MATERIALIZED_VIEW_ID_LENGTH,
  parentOwned,
  parseResourceName,
  toPhysicalId,
  waitForOperation,
  collectPages,
} from "./operations.ts";

export type InstancesMaterializedViewProps = {
  /**
   * Parent instance. Full name `projects/{project}/instances/{instance}`
   * or the instance id. Immutable — changing it replaces the view.
   */
  instance: string;
  /**
   * Materialized view id (the `{materialized_view}` segment of
   * `.../instances/{instance}/materializedViews/{materialized_view}`).
   * If omitted, a unique name is generated from the stack, stage, and
   * logical id. Must be unique among table ids and view ids in the
   * instance. Immutable — changing it replaces the view.
   */
  materializedViewId?: string;
  /**
   * GoogleSQL SELECT that defines the continuous materialized view.
   * Must include `GROUP BY` or `ORDER BY` and cannot use `SELECT *`.
   * Immutable — changing it replaces the view.
   */
  query: string;
  /**
   * Protect the view from Admin API deletes. Disabled automatically on
   * destroy.
   * @default false
   */
  deletionProtection?: boolean;
};

export type InstancesMaterializedView = Resource<
  "GCP.Bigtable.InstancesMaterializedView",
  InstancesMaterializedViewProps,
  {
    /** Full resource name `.../instances/{instance}/materializedViews/{materialized_view}`. */
    name: string;
    /** Materialized view id (last path segment). */
    materializedViewId: string;
    /** Parent instance resource name. */
    instance: string;
    /** Parent instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Defining SELECT query. */
    query: string | undefined;
    /** Whether Admin API deletes are blocked. */
    deletionProtection: boolean;
    /** Per-cluster replication state. */
    clusterStates:
      | bigtable.GoogleBigtableAdminV2MaterializedViewClusterStateMap
      | undefined;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Bigtable continuous materialized view — a SQL SELECT whose
 * results are precomputed and kept current.
 *
 * The parent instance must already exist. The query must use `GROUP BY`
 * or `ORDER BY` and cannot use `SELECT *`. Changing `materializedViewId`,
 * `instance`, or `query` replaces the view. `deletionProtection` updates
 * in place.
 *
 * Materialized views have no labels field. Alchemy treats a view as
 * owned when its parent instance carries Alchemy labels, so `list` /
 * `pnpm nuke:gcp` can find it.
 *
 * ### Creating a Materialized View
 * **Example:** Count of rows grouped by a constant key
 * ```typescript
 * const events = yield* GCP.Bigtable.Table("Events", {
 *   instance: instance.name,
 *   columnFamilies: { cf: {} },
 * });
 * const view = yield* GCP.Bigtable.InstancesMaterializedView("Counts", {
 *   instance: instance.name,
 *   query: "SELECT '*' AS _key, COUNT(*) AS row_count FROM events GROUP BY _key",
 * });
 * ```
 *
 * @resource
 * @category Bigtable
 */
export const InstancesMaterializedView = Resource<InstancesMaterializedView>(
  "GCP.Bigtable.InstancesMaterializedView",
);

export class MaterializedViewNotResolved extends Data.TaggedError(
  "GCP.Bigtable.MaterializedViewNotResolved",
)<{
  name: string;
}> {}

export class MaterializedViewStillExists extends Data.TaggedError(
  "GCP.Bigtable.MaterializedViewStillExists",
)<{
  name: string;
}> {}

const toId = (
  id: string,
  materializedViewId: string | undefined,
  existing?: string,
) =>
  toPhysicalId(
    id,
    materializedViewId,
    existing,
    MAX_MATERIALIZED_VIEW_ID_LENGTH,
  );

const queryOf = (value: string | undefined) => (value ?? "").trim();

const toAttrs = (view: bigtable.MaterializedView, project: string) => {
  const name = view.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    materializedViewId: parsed.materializedViewId,
    instance: parsed.instance,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    query: view.query,
    deletionProtection: view.deletionProtection === true,
    clusterStates: view.clusterStates,
    etag: view.etag,
  };
};

const getByName = (name: string) =>
  bigtable
    .getProjectsInstancesMaterializedViews({ name, view: "FULL" })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((view) =>
      view
        ? Effect.succeed(view)
        : Effect.fail(new MaterializedViewNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Bigtable.MaterializedViewNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((view) =>
      view === undefined
        ? Effect.void
        : Effect.fail(new MaterializedViewStillExists({ name })),
    ),
    Effect.retry({
      while: (error) =>
        error._tag === "GCP.Bigtable.MaterializedViewStillExists",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const unprotect = (name: string, etag: string | undefined) =>
  Effect.gen(function* () {
    const patched = yield* bigtable.patchProjectsInstancesMaterializedViews({
      name,
      updateMask: "deletion_protection",
      body: { deletionProtection: false, etag },
    });
    yield* waitForOperation(patched);
  });

export const InstancesMaterializedViewProvider = () =>
  Provider.succeed(InstancesMaterializedView, {
    stables: [
      "name",
      "materializedViewId",
      "instance",
      "instanceId",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.materializedViewId ?? output?.materializedViewId;
      const nextId = news.materializedViewId ?? previousId;
      const previousInstance = instanceIdOf(
        olds?.instance ?? output?.instance ?? output?.instanceId ?? "",
      );
      const nextInstance = instanceIdOf(news.instance);
      const previousQuery = queryOf(olds?.query ?? output?.query);
      const nextQuery = queryOf(news.query);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (previousInstance.length > 0 && previousInstance !== nextInstance) ||
        (previousQuery.length > 0 && previousQuery !== nextQuery)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const materializedViewId = yield* toId(
        id,
        olds?.materializedViewId,
        output?.materializedViewId,
      );
      const instanceRef = olds?.instance ?? output?.instance;
      const name =
        output?.name ??
        (instanceRef
          ? materializedViewName(
              env.project,
              instanceIdOf(instanceRef),
              materializedViewId,
            )
          : undefined);
      if (name === undefined) return undefined;
      const existing = yield* getByName(name);
      if (existing === undefined) return undefined;
      const attrs = toAttrs(existing, env.project);
      return (yield* parentOwned(attrs.instance)) ? attrs : Unowned(attrs);
    }),

    list: () =>
      Effect.gen(function* () {
        const env = yield* GcpEnvironment.current;
        const instances = (yield* listAlchemyInstances(env.project)).filter(
          (instance): instance is bigtable.Instance & { name: string } =>
            typeof instance.name === "string" && instance.name.length > 0,
        );
        const pages = yield* Effect.forEach(
          instances,
          (instance) =>
            collectPages(
              bigtable.listProjectsInstancesMaterializedViews.pages({
                parent: instance.name,
                pageSize: 1000,
              }),
              (page) => page.materializedViews,
            ).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as bigtable.MaterializedView[]),
              ),
            ),
          { concurrency: 4 },
        );
        return pages.flat().map((view) => toAttrs(view, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const materializedViewId = yield* toId(
        id,
        news.materializedViewId,
        output?.materializedViewId,
      );
      const parent = instanceNameOf(env.project, news.instance);
      const name = `${parent}/materializedViews/${materializedViewId}`;
      const desiredProtection = news.deletionProtection === true;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* bigtable
          .createProjectsInstancesMaterializedViews({
            parent,
            materializedViewId,
            body: {
              query: news.query,
              deletionProtection: desiredProtection,
            },
          })
          .pipe(
            // A just-created source table rejects views for a short while.
            Effect.retry({
              while: (error) => error._tag === "SourceTableNotReady",
              times: 8,
              schedule: Schedule.spaced("5 seconds"),
            }),
            Effect.catchTag("Conflict", () => Effect.succeed(undefined)),
          );
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilExists(name);
      }

      if ((current.deletionProtection === true) !== desiredProtection) {
        const patched = yield* bigtable
          .patchProjectsInstancesMaterializedViews({
            name,
            updateMask: "deletion_protection",
            body: {
              deletionProtection: desiredProtection,
              etag: current.etag,
            },
          })
          .pipe(
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("1 second"),
            }),
          );
        yield* waitForOperation(patched);
        current = yield* getByName(name);
        if (current === undefined) {
          return yield* new MaterializedViewNotResolved({ name });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const current = yield* getByName(output.name);
      if (current === undefined) return;
      if (current.deletionProtection === true) {
        yield* unprotect(output.name, current.etag);
      }
      yield* bigtable
        .deleteProjectsInstancesMaterializedViews({
          name: output.name,
        })
        .pipe(
          Effect.catchTag("NotFound", () => Effect.void),
          Effect.retry({
            while: (error) => error._tag === "Conflict",
            times: 8,
            schedule: Schedule.spaced("2 seconds"),
          }),
        );
      yield* waitUntilGone(output.name);
    }),
  });

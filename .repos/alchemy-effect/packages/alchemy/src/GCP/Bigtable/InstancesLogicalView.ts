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
  logicalViewName,
  MAX_LOGICAL_VIEW_ID_LENGTH,
  parentOwned,
  parseResourceName,
  toPhysicalId,
  waitForOperation,
  collectPages,
} from "./operations.ts";

export type InstancesLogicalViewProps = {
  /**
   * Parent instance. Full name `projects/{project}/instances/{instance}`
   * or the instance id. Immutable — changing it replaces the view.
   */
  instance: string;
  /**
   * Logical view id (the `{logical_view}` segment of
   * `.../instances/{instance}/logicalViews/{logical_view}`). If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   * Must be unique among table ids and view ids in the instance.
   * Immutable — changing it replaces the view.
   */
  logicalViewId?: string;
  /**
   * GoogleSQL SELECT query that defines the view. `SELECT *` is not
   * allowed. Must reference a table in the same instance.
   */
  query: string;
  /**
   * Protect the view from Admin API deletes. Disabled automatically on
   * destroy.
   * @default false
   */
  deletionProtection?: boolean;
};

export type InstancesLogicalView = Resource<
  "GCP.Bigtable.InstancesLogicalView",
  InstancesLogicalViewProps,
  {
    /** Full resource name `.../instances/{instance}/logicalViews/{logical_view}`. */
    name: string;
    /** Logical view id (last path segment). */
    logicalViewId: string;
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
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Bigtable logical view — a SQL SELECT over a table that can
 * be queried as a virtual table.
 *
 * The parent instance must already exist and the query cannot use
 * `SELECT *`. Changing `logicalViewId` or `instance` replaces the view.
 * `query` and `deletionProtection` update in place.
 *
 * Logical views have no labels field. Alchemy treats a view as owned
 * when its parent instance carries Alchemy labels, so `list` /
 * `pnpm nuke:gcp` can find it.
 *
 * ### Creating a Logical View
 * **Example:** View over one table
 * ```typescript
 * const users = yield* GCP.Bigtable.Table("Users", {
 *   instance: instance.name,
 *   columnFamilies: { cf: {} },
 * });
 * const view = yield* GCP.Bigtable.InstancesLogicalView("Active", {
 *   instance: instance.name,
 *   query: "SELECT _key FROM users",
 * });
 * ```
 *
 * @resource
 * @category Bigtable
 */
export const InstancesLogicalView = Resource<InstancesLogicalView>(
  "GCP.Bigtable.InstancesLogicalView",
);

export class LogicalViewNotResolved extends Data.TaggedError(
  "GCP.Bigtable.LogicalViewNotResolved",
)<{
  name: string;
}> {}

export class LogicalViewStillExists extends Data.TaggedError(
  "GCP.Bigtable.LogicalViewStillExists",
)<{
  name: string;
}> {}

const toId = (
  id: string,
  logicalViewId: string | undefined,
  existing?: string,
) => toPhysicalId(id, logicalViewId, existing, MAX_LOGICAL_VIEW_ID_LENGTH);

const queryOf = (value: string | undefined) => (value ?? "").trim();

const toAttrs = (view: bigtable.LogicalView, project: string) => {
  const name = view.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    logicalViewId: parsed.logicalViewId,
    instance: parsed.instance,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    query: view.query,
    deletionProtection: view.deletionProtection === true,
    etag: view.etag,
  };
};

const getByName = (name: string) =>
  bigtable
    .getProjectsInstancesLogicalViews({ name })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((view) =>
      view
        ? Effect.succeed(view)
        : Effect.fail(new LogicalViewNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.LogicalViewNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((view) =>
      view === undefined
        ? Effect.void
        : Effect.fail(new LogicalViewStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.LogicalViewStillExists",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const unprotect = (name: string, etag: string | undefined) =>
  Effect.gen(function* () {
    const patched = yield* bigtable.patchProjectsInstancesLogicalViews({
      name,
      updateMask: "deletion_protection",
      body: { deletionProtection: false, etag },
    });
    yield* waitForOperation(patched);
  });

export const InstancesLogicalViewProvider = () =>
  Provider.succeed(InstancesLogicalView, {
    stables: ["name", "logicalViewId", "instance", "instanceId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.logicalViewId ?? output?.logicalViewId;
      const nextId = news.logicalViewId ?? previousId;
      const previousInstance = instanceIdOf(
        olds?.instance ?? output?.instance ?? output?.instanceId ?? "",
      );
      const nextInstance = instanceIdOf(news.instance);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (previousInstance.length > 0 && previousInstance !== nextInstance)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const logicalViewId = yield* toId(
        id,
        olds?.logicalViewId,
        output?.logicalViewId,
      );
      const instanceRef = olds?.instance ?? output?.instance;
      const name =
        output?.name ??
        (instanceRef
          ? logicalViewName(
              env.project,
              instanceIdOf(instanceRef),
              logicalViewId,
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
              bigtable.listProjectsInstancesLogicalViews.pages({
                parent: instance.name,
                pageSize: 1000,
              }),
              (page) => page.logicalViews,
            ).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as bigtable.LogicalView[]),
              ),
            ),
          { concurrency: 4 },
        );
        return pages.flat().map((view) => toAttrs(view, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const logicalViewId = yield* toId(
        id,
        news.logicalViewId,
        output?.logicalViewId,
      );
      const parent = instanceNameOf(env.project, news.instance);
      const name = `${parent}/logicalViews/${logicalViewId}`;
      const desiredProtection = news.deletionProtection === true;
      const query = news.query;

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* bigtable
          .createProjectsInstancesLogicalViews({
            parent,
            logicalViewId,
            body: {
              query,
              deletionProtection: desiredProtection,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilExists(name);
      }

      const queryChanged = queryOf(current.query) !== queryOf(query);
      const protectionChanged =
        (current.deletionProtection === true) !== desiredProtection;
      if (queryChanged || protectionChanged) {
        const mask = [
          queryChanged ? "query" : undefined,
          protectionChanged ? "deletion_protection" : undefined,
        ].filter((field): field is string => field !== undefined);
        const patched = yield* bigtable
          .patchProjectsInstancesLogicalViews({
            name,
            updateMask: mask.join(","),
            body: {
              query,
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
          return yield* new LogicalViewNotResolved({ name });
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
        .deleteProjectsInstancesLogicalViews({
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

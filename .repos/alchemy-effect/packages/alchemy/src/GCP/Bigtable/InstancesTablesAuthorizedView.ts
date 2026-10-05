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
  listAlchemyTables,
  MAX_AUTHORIZED_VIEW_ID_LENGTH,
  parentOwned,
  parseResourceName,
  tableIdOf,
  tableNameOf,
  toPhysicalId,
  waitForOperation,
  collectPages,
} from "./operations.ts";

export type FamilySubsets = {
  /** Exact column qualifiers included in the view (base64 bytes). */
  qualifiers?: string[];
  /**
   * Qualifier prefixes included in the view. The empty string includes
   * every qualifier in the family.
   */
  qualifierPrefixes?: string[];
};

export type SubsetView = {
  /**
   * Row-key prefixes included in the view (base64 bytes). The empty
   * string includes every row.
   */
  rowPrefixes?: string[];
  /** Column families included in the view, keyed by family id. */
  familySubsets?: Record<string, FamilySubsets>;
};

export type InstancesTablesAuthorizedViewProps = {
  /**
   * Parent instance. Full name `projects/{project}/instances/{instance}`
   * or the instance id. Immutable — changing it replaces the view.
   */
  instance: string;
  /**
   * Parent table. Full name
   * `projects/{project}/instances/{instance}/tables/{table}` or the table
   * id. Immutable — changing it replaces the view.
   */
  table: string;
  /**
   * Authorized view id (the `{authorized_view}` segment of
   * `.../tables/{table}/authorizedViews/{authorized_view}`). If omitted,
   * a unique name is generated from the stack, stage, and logical id.
   * Immutable — changing it replaces the view.
   */
  authorizedViewId?: string;
  /**
   * Subset of the table this view exposes.
   */
  subsetView?: SubsetView;
  /**
   * Protect the view (and its table/instance) from Admin API deletes.
   * Disabled automatically on destroy.
   * @default false
   */
  deletionProtection?: boolean;
  /**
   * Ignore safety checks on update.
   * @default true
   */
  ignoreWarnings?: boolean;
};

export type InstancesTablesAuthorizedView = Resource<
  "GCP.Bigtable.InstancesTablesAuthorizedView",
  InstancesTablesAuthorizedViewProps,
  {
    /** Full resource name `.../tables/{table}/authorizedViews/{authorized_view}`. */
    name: string;
    /** Authorized view id (last path segment). */
    authorizedViewId: string;
    /** Parent table resource name. */
    table: string;
    /** Parent table id. */
    tableId: string;
    /** Parent instance resource name. */
    instance: string;
    /** Parent instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Subset of the table currently exposed. */
    subsetView: SubsetView | undefined;
    /** Whether Admin API deletes are blocked. */
    deletionProtection: boolean;
    /** Server etag. */
    etag: string | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Bigtable authorized view — a named subset of a table used for
 * fine-grained IAM.
 *
 * The parent instance and table must already exist. Changing
 * `authorizedViewId`, `instance`, or `table` replaces the view.
 * `subsetView` and `deletionProtection` update in place.
 *
 * Authorized views have no labels field. Alchemy treats a view as owned
 * when its parent instance carries Alchemy labels, so `list` /
 * `pnpm nuke:gcp` can find it.
 *
 * ### Creating an Authorized View
 * **Example:** All rows of one column family
 * ```typescript
 * const view = yield* GCP.Bigtable.InstancesTablesAuthorizedView("Public", {
 *   instance: instance.name,
 *   table: table.name,
 *   subsetView: {
 *     rowPrefixes: [""],
 *     familySubsets: {
 *       cf: { qualifierPrefixes: [""] },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 * @category Bigtable
 */
export const InstancesTablesAuthorizedView =
  Resource<InstancesTablesAuthorizedView>(
    "GCP.Bigtable.InstancesTablesAuthorizedView",
  );

export class AuthorizedViewNotResolved extends Data.TaggedError(
  "GCP.Bigtable.AuthorizedViewNotResolved",
)<{
  name: string;
}> {}

export class AuthorizedViewStillExists extends Data.TaggedError(
  "GCP.Bigtable.AuthorizedViewStillExists",
)<{
  name: string;
}> {}

const toId = (
  id: string,
  authorizedViewId: string | undefined,
  existing?: string,
) =>
  toPhysicalId(id, authorizedViewId, existing, MAX_AUTHORIZED_VIEW_ID_LENGTH);

const familyOf = (
  family:
    | FamilySubsets
    | bigtable.GoogleBigtableAdminV2AuthorizedViewFamilySubsets,
): FamilySubsets => ({
  qualifiers: family.qualifiers,
  qualifierPrefixes: family.qualifierPrefixes,
});

const subsetOf = (
  view:
    | SubsetView
    | bigtable.GoogleBigtableAdminV2AuthorizedViewSubsetView
    | undefined,
): SubsetView | undefined => {
  if (view === undefined) return undefined;
  const familySubsets: Record<string, FamilySubsets> = {};
  for (const [id, family] of Object.entries(view.familySubsets ?? {})) {
    if (family === undefined) continue;
    familySubsets[id] = familyOf(family);
  }
  return {
    rowPrefixes: view.rowPrefixes,
    familySubsets:
      Object.keys(familySubsets).length > 0 ? familySubsets : undefined,
  };
};

const subsetKey = (view: SubsetView | undefined) => {
  const families = Object.entries(view?.familySubsets ?? {})
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([id, family]) => [
      id,
      {
        qualifierPrefixes: [...(family?.qualifierPrefixes ?? [])].sort(),
        qualifiers: [...(family?.qualifiers ?? [])].sort(),
      },
    ]);
  return JSON.stringify({
    rowPrefixes: [...(view?.rowPrefixes ?? [])].sort(),
    familySubsets: families,
  });
};

const toAttrs = (view: bigtable.AuthorizedView, project: string) => {
  const name = view.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    authorizedViewId: parsed.authorizedViewId,
    table: parsed.table,
    tableId: parsed.tableId,
    instance: parsed.instance,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    subsetView: subsetOf(view.subsetView),
    deletionProtection: view.deletionProtection === true,
    etag: view.etag,
  };
};

const getByName = (name: string) =>
  bigtable
    .getProjectsInstancesTablesAuthorizedViews({ name, view: "FULL" })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilExists = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((view) =>
      view
        ? Effect.succeed(view)
        : Effect.fail(new AuthorizedViewNotResolved({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.AuthorizedViewNotResolved",
      times: 8,
      schedule: Schedule.spaced("1 second"),
    }),
  );

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((view) =>
      view === undefined
        ? Effect.void
        : Effect.fail(new AuthorizedViewStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.AuthorizedViewStillExists",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const unprotect = (
  name: string,
  etag: string | undefined,
  ignoreWarnings: boolean,
) =>
  Effect.gen(function* () {
    const patched = yield* bigtable.patchProjectsInstancesTablesAuthorizedViews(
      {
        name,
        updateMask: "deletion_protection",
        ignoreWarnings,
        body: { deletionProtection: false, etag },
      },
    );
    yield* waitForOperation(patched);
  });

export const InstancesTablesAuthorizedViewProvider = () =>
  Provider.succeed(InstancesTablesAuthorizedView, {
    stables: [
      "name",
      "authorizedViewId",
      "table",
      "tableId",
      "instance",
      "instanceId",
      "project",
    ],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.authorizedViewId ?? output?.authorizedViewId;
      const nextId = news.authorizedViewId ?? previousId;
      const previousInstance = instanceIdOf(
        olds?.instance ?? output?.instance ?? output?.instanceId ?? "",
      );
      const nextInstance = instanceIdOf(news.instance);
      const previousTable = tableIdOf(
        olds?.table ?? output?.table ?? output?.tableId ?? "",
      );
      const nextTable = tableIdOf(news.table);
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (previousInstance.length > 0 && previousInstance !== nextInstance) ||
        (previousTable.length > 0 && previousTable !== nextTable)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const authorizedViewId = yield* toId(
        id,
        olds?.authorizedViewId,
        output?.authorizedViewId,
      );
      const instanceRef = olds?.instance ?? output?.instance;
      const tableRef = olds?.table ?? output?.table;
      const name =
        output?.name ??
        (instanceRef && tableRef
          ? `${tableNameOf(env.project, instanceRef, tableRef)}/authorizedViews/${authorizedViewId}`
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
        const tables = (yield* listAlchemyTables(env.project)).filter(
          (table): table is bigtable.Table & { name: string } =>
            typeof table.name === "string" && table.name.length > 0,
        );
        const pages = yield* Effect.forEach(
          tables,
          (table) =>
            collectPages(
              bigtable.listProjectsInstancesTablesAuthorizedViews.pages({
                parent: table.name,
                pageSize: 1000,
              }),
              (page) => page.authorizedViews,
            ).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as bigtable.AuthorizedView[]),
              ),
            ),
          { concurrency: 4 },
        );
        return pages.flat().map((view) => toAttrs(view, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const authorizedViewId = yield* toId(
        id,
        news.authorizedViewId,
        output?.authorizedViewId,
      );
      const parent = tableNameOf(env.project, news.instance, news.table);
      const name = `${parent}/authorizedViews/${authorizedViewId}`;
      const desiredProtection = news.deletionProtection === true;
      const ignoreWarnings = news.ignoreWarnings ?? true;
      const desiredSubset = subsetOf(news.subsetView);

      let current = yield* getByName(output?.name ?? name);

      if (current === undefined) {
        const created = yield* bigtable
          .createProjectsInstancesTablesAuthorizedViews({
            parent,
            authorizedViewId,
            body: {
              subsetView: desiredSubset,
              deletionProtection: desiredProtection,
            },
          })
          .pipe(Effect.catchTag("Conflict", () => Effect.succeed(undefined)));
        if (created !== undefined) {
          yield* waitForOperation(created, { alreadyExistsOk: true });
        }
        current = yield* waitUntilExists(name);
      }

      const observedSubset = subsetOf(current.subsetView);
      const subsetChanged =
        news.subsetView !== undefined &&
        subsetKey(observedSubset) !== subsetKey(desiredSubset);
      const protectionChanged =
        (current.deletionProtection === true) !== desiredProtection;

      if (subsetChanged || protectionChanged) {
        const mask = [
          subsetChanged ? "subset_view" : undefined,
          protectionChanged ? "deletion_protection" : undefined,
        ].filter((field): field is string => field !== undefined);
        const patched = yield* bigtable
          .patchProjectsInstancesTablesAuthorizedViews({
            name,
            updateMask: mask.join(","),
            ignoreWarnings,
            body: {
              subsetView: desiredSubset,
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
          return yield* new AuthorizedViewNotResolved({ name });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output, olds }) {
      const ignoreWarnings = olds?.ignoreWarnings ?? true;
      const current = yield* getByName(output.name);
      if (current === undefined) return;
      if (current.deletionProtection === true) {
        yield* unprotect(output.name, current.etag, ignoreWarnings);
      }
      yield* bigtable
        .deleteProjectsInstancesTablesAuthorizedViews({
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

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
  instanceNameOf,
  listAlchemyInstances,
  MAX_TABLE_ID_LENGTH,
  parentOwned,
  parseResourceName,
  toPhysicalId,
  waitForOperation,
  collectPages,
} from "./operations.ts";

export type GcRule = {
  /** Keep only the most recent N versions of each cell. */
  maxNumVersions?: number;
  /** Delete cells older than this duration (e.g. `"2592000s"`). */
  maxAge?: string;
};

export type ColumnFamily = {
  /** Garbage-collection rule for this family. */
  gcRule?: GcRule;
};

export type ChangeStreamConfig = {
  /**
   * How long change-stream data is retained (`1d`–`7d`, e.g. `"86400s"`).
   */
  retentionPeriod?: string;
};

export type AutomatedBackupPolicy = {
  /** How long automated backups are retained (`3d`–`90d`). */
  retentionPeriod?: string;
  /** Backup frequency. Only `"24h"` is supported. */
  frequency?: string;
};

export type TableProps = {
  /**
   * Parent instance. Full name `projects/{project}/instances/{instance}`
   * or the instance id. Immutable — changing it replaces the table.
   */
  instance: string;
  /**
   * Table id (the `{table}` segment of
   * `.../instances/{instance}/tables/{table}`). If omitted, a unique name
   * is generated from the stack, stage, and logical id. Must be 1-50
   * characters. Immutable — changing it replaces the table.
   */
  tableId?: string;
  /**
   * Column families keyed by family id. Omitted on update leaves families
   * unchanged; a provided map is reconciled (create / update / drop).
   */
  columnFamilies?: Record<string, ColumnFamily>;
  /**
   * Protect the table (and its instance) from Admin API deletes.
   * Disabled automatically on destroy.
   * @default false
   */
  deletionProtection?: boolean;
  /**
   * Timestamp granularity. Immutable.
   * @default "MILLIS"
   */
  granularity?: bigtable.TableGranularityEnum | (string & {});
  /**
   * Enable a change stream on this table.
   */
  changeStreamConfig?: ChangeStreamConfig;
  /**
   * Automated backup policy. Omit to disable.
   */
  automatedBackupPolicy?: AutomatedBackupPolicy;
};

export type Table = Resource<
  "GCP.Bigtable.Table",
  TableProps,
  {
    /** Full resource name `projects/{project}/instances/{instance}/tables/{table}`. */
    name: string;
    /** Table id (last path segment). */
    tableId: string;
    /** Parent instance resource name. */
    instance: string;
    /** Instance id. */
    instanceId: string;
    /** Project id. */
    project: string;
    /** Column families currently configured. */
    columnFamilies: Record<string, ColumnFamily>;
    /** Whether Admin API deletes are blocked. */
    deletionProtection: boolean;
    /** Timestamp granularity. */
    granularity: string | undefined;
    /** Change-stream config, if enabled. */
    changeStreamConfig: ChangeStreamConfig | undefined;
    /** Automated backup policy, if enabled. */
    automatedBackupPolicy: AutomatedBackupPolicy | undefined;
    /** Restore info, if this table was restored from a backup. */
    restoreInfo: bigtable.RestoreInfo | undefined;
  },
  never,
  Providers
>;

/**
 * A Cloud Bigtable table — rows keyed by row key, grouped into column
 * families.
 *
 * The parent instance must already exist. Changing `tableId`,
 * `instance`, or `granularity` replaces the table. Column families,
 * deletion protection, change streams, and automated backups update in
 * place. Row read/write is a data-plane API; use {@link GetTable} for
 * admin metadata.
 *
 * Tables have no labels field. Alchemy treats a table as owned when its
 * parent instance carries Alchemy labels, so `list` / `pnpm nuke:gcp`
 * can find it.
 *
 * ### Creating a Table
 * **Example:** Table with one column family
 * ```typescript
 * const instance = yield* GCP.Bigtable.Instance("Data", {});
 * const table = yield* GCP.Bigtable.Table("Users", {
 *   instance: instance.name,
 *   columnFamilies: {
 *     cf: { gcRule: { maxNumVersions: 3 } },
 *   },
 * });
 * ```
 *
 * ### Reading Table Metadata
 * **Example:** Get the bound table
 * ```typescript
 * const getTable = yield* GCP.Bigtable.GetTable(table);
 * const live = yield* getTable({ view: "SCHEMA_VIEW" });
 * ```
 *
 * @resource
 * @category Bigtable
 */
export const Table = Resource<Table>("GCP.Bigtable.Table");

export class TableNotResolved extends Data.TaggedError(
  "GCP.Bigtable.TableNotResolved",
)<{
  name: string;
}> {}

export class TableStillExists extends Data.TaggedError(
  "GCP.Bigtable.TableStillExists",
)<{
  name: string;
}> {}

const DEFAULT_GRANULARITY = "MILLIS";
const SCHEMA_VIEW = "SCHEMA_VIEW";

const normalizeGranularity = (value: string | undefined) => {
  const next = (value ?? DEFAULT_GRANULARITY).toUpperCase();
  return next === "TIMESTAMP_GRANULARITY_UNSPECIFIED"
    ? DEFAULT_GRANULARITY
    : next;
};

const gcKey = (rule: GcRule | bigtable.GcRule | undefined) =>
  JSON.stringify({
    maxNumVersions: rule?.maxNumVersions ?? 0,
    maxAge: rule?.maxAge ?? "",
  });

const familiesOf = (
  families:
    | Record<string, ColumnFamily | bigtable.ColumnFamily | undefined>
    | null
    | undefined,
): Record<string, ColumnFamily> => {
  const result: Record<string, ColumnFamily> = {};
  for (const [id, family] of Object.entries(families ?? {})) {
    if (family === undefined) continue;
    result[id] = { gcRule: family.gcRule };
  }
  return result;
};

const toId = (id: string, tableId: string | undefined, existing?: string) =>
  toPhysicalId(id, tableId, existing, MAX_TABLE_ID_LENGTH);

const toAttrs = (table: bigtable.Table, project: string) => {
  const name = table.name ?? "";
  const parsed = parseResourceName(name);
  return {
    name,
    tableId: parsed.tableId,
    instance: parsed.instance,
    instanceId: parsed.instanceId,
    project: parsed.project || project,
    columnFamilies: familiesOf(table.columnFamilies),
    deletionProtection: table.deletionProtection === true,
    granularity: table.granularity,
    changeStreamConfig: table.changeStreamConfig,
    automatedBackupPolicy: table.automatedBackupPolicy,
    restoreInfo: table.restoreInfo,
  };
};

const getByName = (name: string) =>
  bigtable
    .getProjectsInstancesTables({ name, view: SCHEMA_VIEW })
    .pipe(Effect.catchTag("NotFound", () => Effect.succeed(undefined)));

const waitUntilGone = (name: string) =>
  getByName(name).pipe(
    Effect.flatMap((table) =>
      table === undefined
        ? Effect.void
        : Effect.fail(new TableStillExists({ name })),
    ),
    Effect.retry({
      while: (error) => error._tag === "GCP.Bigtable.TableStillExists",
      times: 8,
      schedule: Schedule.spaced("2 seconds"),
    }),
  );

const toFamilyBody = (family: ColumnFamily): bigtable.ColumnFamily => ({
  gcRule: family.gcRule,
});

const changeStreamKey = (config: ChangeStreamConfig | undefined) =>
  JSON.stringify({ retention: config?.retentionPeriod ?? "" });

const backupKey = (policy: AutomatedBackupPolicy | undefined) =>
  JSON.stringify({
    retention: policy?.retentionPeriod ?? "",
    frequency: policy?.frequency ?? "",
  });

const familyMods = (
  observed: Record<string, ColumnFamily>,
  desired: Record<string, ColumnFamily>,
): bigtable.Modification[] => {
  const mods: bigtable.Modification[] = [];
  for (const [id, family] of Object.entries(desired)) {
    if (observed[id] === undefined) {
      mods.push({ id, create: toFamilyBody(family) });
    } else if (gcKey(observed[id]?.gcRule) !== gcKey(family.gcRule)) {
      mods.push({
        id,
        update: toFamilyBody(family),
        updateMask: "gc_rule",
      });
    }
  }
  for (const id of Object.keys(observed)) {
    if (desired[id] === undefined) {
      mods.push({ id, drop: true });
    }
  }
  return mods;
};

export const TableProvider = () =>
  Provider.succeed(Table, {
    stables: ["name", "tableId", "instance", "instanceId", "project"],

    diff: Effect.fn(function* ({ news, olds, output }) {
      if (!isResolved(news)) return undefined;
      const previousId = olds?.tableId ?? output?.tableId;
      const nextId = news.tableId ?? previousId;
      const previousInstance = olds?.instance ?? output?.instance;
      const previousInstanceId = previousInstance
        ? parseResourceName(
            previousInstance.includes("/instances/")
              ? previousInstance
              : `projects/_/instances/${previousInstance}`,
          ).instanceId
        : output?.instanceId;
      const nextInstanceId = parseResourceName(
        news.instance.includes("/instances/")
          ? news.instance
          : `projects/_/instances/${news.instance}`,
      ).instanceId;
      const previousGranularity = normalizeGranularity(
        olds?.granularity ?? output?.granularity,
      );
      const nextGranularity = normalizeGranularity(
        news.granularity ?? output?.granularity,
      );
      if (
        (previousId !== undefined &&
          nextId !== undefined &&
          previousId !== nextId) ||
        (previousInstanceId !== undefined &&
          previousInstanceId !== nextInstanceId) ||
        (news.granularity !== undefined &&
          previousGranularity !== nextGranularity)
      ) {
        return { action: "replace" as const };
      }
      return undefined;
    }),

    read: Effect.fn(function* ({ id, olds, output }) {
      const env = yield* GcpEnvironment.current;
      const tableId = yield* toId(id, olds?.tableId, output?.tableId);
      const instanceRef = olds?.instance ?? output?.instance;
      const name =
        output?.name ??
        (instanceRef
          ? `${instanceNameOf(env.project, instanceRef)}/tables/${tableId}`
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
            !!instance.name,
        );
        const pages = yield* Effect.forEach(
          instances,
          (instance) =>
            collectPages(
              bigtable.listProjectsInstancesTables.pages({
                parent: instance.name,
                pageSize: 1000,
              }),
              (page) => page.tables,
            ).pipe(
              Effect.catchTag("NotFound", () =>
                Effect.succeed([] as bigtable.Table[]),
              ),
            ),
          { concurrency: 4 },
        );
        return pages.flat().map((table) => toAttrs(table, env.project));
      }),

    reconcile: Effect.fn(function* ({ id, news, output }) {
      const env = yield* GcpEnvironment.current;
      const tableId = yield* toId(id, news.tableId, output?.tableId);
      const parent = instanceNameOf(env.project, news.instance);
      const name = `${parent}/tables/${tableId}`;
      const desiredProtection = news.deletionProtection === true;
      const families = news.columnFamilies;

      let current = yield* getByName(name);

      if (current === undefined) {
        const created = yield* bigtable
          .createProjectsInstancesTables({
            parent,
            body: {
              tableId,
              table: {
                granularity: news.granularity
                  ? normalizeGranularity(news.granularity)
                  : undefined,
                columnFamilies:
                  families === undefined
                    ? undefined
                    : Object.fromEntries(
                        Object.entries(families).map(([familyId, family]) => [
                          familyId,
                          toFamilyBody(family),
                        ]),
                      ),
                deletionProtection: desiredProtection,
                changeStreamConfig: news.changeStreamConfig,
                automatedBackupPolicy: news.automatedBackupPolicy,
              },
            },
          })
          .pipe(
            Effect.catchTag("Conflict", (error) =>
              getByName(name).pipe(
                Effect.flatMap((existing) =>
                  existing ? Effect.succeed(existing) : Effect.fail(error),
                ),
              ),
            ),
            Effect.retry({
              while: (error) => error._tag === "Conflict",
              times: 8,
              schedule: Schedule.spaced("2 seconds"),
            }),
          );
        current = created ?? undefined;
      }

      if (current === undefined) {
        return yield* new TableNotResolved({ name });
      }

      if (families !== undefined) {
        const mods = familyMods(familiesOf(current.columnFamilies), families);
        if (mods.length > 0) {
          if (current.deletionProtection === true) {
            const unlocked = yield* bigtable.patchProjectsInstancesTables({
              name,
              updateMask: "deletion_protection",
              body: { deletionProtection: false },
            });
            yield* waitForOperation(unlocked);
            current = (yield* getByName(name)) ?? current;
          }
          current = yield* bigtable.modifyColumnFamiliesProjectsInstancesTables(
            {
              name,
              body: { modifications: mods },
            },
          );
        }
      }

      const mask: string[] = [];
      const patchBody: bigtable.Table = {};
      if ((current.deletionProtection === true) !== desiredProtection) {
        patchBody.deletionProtection = desiredProtection;
        mask.push("deletion_protection");
      }
      if (
        news.changeStreamConfig !== undefined &&
        changeStreamKey(news.changeStreamConfig) !==
          changeStreamKey(current.changeStreamConfig)
      ) {
        patchBody.changeStreamConfig = news.changeStreamConfig;
        mask.push("change_stream_config");
      }
      if (
        news.automatedBackupPolicy !== undefined &&
        backupKey(news.automatedBackupPolicy) !==
          backupKey(current.automatedBackupPolicy)
      ) {
        patchBody.automatedBackupPolicy = news.automatedBackupPolicy;
        mask.push("automated_backup_policy");
      }

      if (mask.length > 0) {
        const patched = yield* bigtable.patchProjectsInstancesTables({
          name,
          updateMask: mask.join(","),
          body: patchBody,
        });
        yield* waitForOperation(patched);
        current = yield* getByName(name);
        if (current === undefined) {
          return yield* new TableNotResolved({ name });
        }
      }

      return toAttrs(current, env.project);
    }),

    delete: Effect.fn(function* ({ output }) {
      const current = yield* getByName(output.name);
      if (current === undefined) return;
      if (current.deletionProtection === true) {
        const patched = yield* bigtable.patchProjectsInstancesTables({
          name: output.name,
          updateMask: "deletion_protection",
          body: { deletionProtection: false },
        });
        yield* waitForOperation(patched);
      }
      yield* bigtable.deleteProjectsInstancesTables({ name: output.name }).pipe(
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

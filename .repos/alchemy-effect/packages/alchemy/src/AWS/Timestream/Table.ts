import * as TSW from "@distilled.cloud/aws/timestream-write";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import {
  createInternalTags,
  diffTags,
  hasAlchemyTags,
  type Tags,
} from "../../Tags.ts";
import { toWireDays, toWireHours } from "../../Util/Duration.ts";
import { AWSEnvironment, type AccountID } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import type { RegionID } from "../Region.ts";
import { withWriteEndpoint } from "./internal.ts";

export type TableArn =
  `arn:aws:timestream:${RegionID}:${AccountID}:database/${string}/table/${string}`;

export type TableStatus = "ACTIVE" | "DELETING" | "RESTORING";

export interface TableRetentionProperties {
  /**
   * How long data stays in the memory store before moving to the magnetic
   * store. Rounded to whole hours on the wire
   * (`MemoryStoreRetentionPeriodInHours`).
   */
  memoryStoreRetention: Duration.Input;
  /**
   * How long data stays in the magnetic store before deletion. Rounded to
   * whole days on the wire (`MagneticStoreRetentionPeriodInDays`).
   */
  magneticStoreRetention: Duration.Input;
}

export interface TableProps {
  /**
   * Name of the database that owns this table. Pass the `databaseName` of a
   * {@link Database} resource.
   */
  databaseName: string;
  /**
   * Name of the table. Must be unique within the database and between 3 and
   * 256 characters.
   * @default ${app}-${stage}-${id}
   */
  tableName?: string;
  /**
   * Retention configuration for the table's memory and magnetic stores.
   * @default { memoryStoreRetention: "6 hours", magneticStoreRetention: "73000 days" }
   */
  retentionProperties?: TableRetentionProperties;
  /**
   * Magnetic store write configuration, including whether late-arriving data
   * is written to the magnetic store and where rejected records are logged.
   */
  magneticStoreWriteProperties?: TSW.MagneticStoreWriteProperties;
  /**
   * Partitioning schema for the table.
   */
  schema?: TSW.Schema;
  /**
   * Tags to associate with the table.
   */
  tags?: Record<string, string>;
}

export interface Table extends Resource<
  "AWS.Timestream.Table",
  TableProps,
  {
    /**
     * The table's physical name.
     */
    tableName: string;
    /**
     * Name of the database that owns the table.
     */
    databaseName: string;
    /**
     * ARN of the table.
     */
    tableArn: TableArn;
    /**
     * Current lifecycle status of the table.
     */
    tableStatus: TableStatus;
    /**
     * Effective retention configuration for the table.
     */
    retentionProperties: TSW.RetentionProperties | undefined;
    /**
     * Effective magnetic store write configuration.
     */
    magneticStoreWriteProperties: TSW.MagneticStoreWriteProperties | undefined;
    /**
     * Current tags reported for the table.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An Amazon Timestream for LiveAnalytics table — a time-series store inside a
 * {@link Database}.
 *
 * `Table` owns the table's lifecycle and its mutable configuration: memory and
 * magnetic store retention, magnetic store write behavior, and tags. A table
 * name is auto-generated from the app, stage, and logical ID unless you provide
 * one.
 *
 * :::note
 * Timestream for LiveAnalytics is closed to new AWS customers. Accounts that
 * were not already onboarded receive `TimestreamNotOnboarded` on every
 * operation.
 * :::
 * @resource
 * @section Creating Tables
 * @example Basic Table
 * ```typescript
 * import * as Timestream from "alchemy/AWS/Timestream";
 *
 * const database = yield* Timestream.Database("Metrics");
 * const table = yield* Timestream.Table("Cpu", {
 *   databaseName: database.databaseName,
 * });
 * ```
 *
 * @example Table with Retention Tuning
 * ```typescript
 * const table = yield* Timestream.Table("Cpu", {
 *   databaseName: database.databaseName,
 *   retentionProperties: {
 *     memoryStoreRetention: "24 hours",
 *     magneticStoreRetention: "365 days",
 *   },
 * });
 * ```
 *
 * @section Writing Points
 * @example Write records from a handler
 * ```typescript
 * // init
 * const writeRecords = yield* Timestream.WriteRecords(table);
 *
 * return {
 *   fetch: Effect.gen(function* () {
 *     // runtime
 *     yield* writeRecords({
 *       Records: [
 *         {
 *           Dimensions: [{ Name: "host", Value: "web-1" }],
 *           MeasureName: "cpu",
 *           MeasureValue: "42.0",
 *           MeasureValueType: "DOUBLE",
 *           Time: `${Date.now()}`,
 *           TimeUnit: "MILLISECONDS",
 *         },
 *       ],
 *     });
 *     return HttpServerResponse.text("ok");
 *   }),
 * };
 * ```
 */
export const Table = Resource<Table>("AWS.Timestream.Table");

const createTableName = (
  id: string,
  props: { tableName?: string | undefined },
) =>
  Effect.gen(function* () {
    if (props.tableName) {
      return props.tableName;
    }
    return yield* createPhysicalName({ id, maxLength: 256 });
  });

const toTagRecord = (
  tags: Array<{ Key: string; Value: string }> | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((tag) => [tag.Key, tag.Value]));

/**
 * Convert the alchemy-shaped {@link TableRetentionProperties} (Duration
 * inputs) to Timestream's wire shape (whole hours / whole days).
 */
const toWireRetention = (
  retention: TableRetentionProperties | undefined,
): TSW.RetentionProperties | undefined =>
  retention === undefined
    ? undefined
    : {
        MemoryStoreRetentionPeriodInHours: toWireHours(
          retention.memoryStoreRetention,
        )!,
        MagneticStoreRetentionPeriodInDays: toWireDays(
          retention.magneticStoreRetention,
        )!,
      };

const readTable = Effect.fn(function* (
  databaseName: string,
  tableName: string,
) {
  const response = yield* withWriteEndpoint(
    TSW.describeTable({ DatabaseName: databaseName, TableName: tableName }),
  ).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
  if (!response?.Table) {
    return undefined;
  }
  const table = response.Table;
  const tagsResponse = yield* withWriteEndpoint(
    TSW.listTagsForResource({ ResourceARN: table.Arn! }),
  ).pipe(
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed(undefined),
    ),
  );
  if (!tagsResponse) {
    return undefined;
  }
  return {
    tableName: table.TableName!,
    databaseName: table.DatabaseName!,
    tableArn: table.Arn as TableArn,
    tableStatus: (table.TableStatus ?? "ACTIVE") as TableStatus,
    retentionProperties: table.RetentionProperties,
    magneticStoreWriteProperties: table.MagneticStoreWriteProperties,
    tags: toTagRecord(tagsResponse.Tags),
  } satisfies Table["Attributes"];
});

export const TableProvider = () =>
  Provider.effect(
    Table,
    Effect.gen(function* () {
      return {
        stables: ["tableName", "databaseName", "tableArn"],
        // Enumerate every Timestream table in the ambient account/region.
        // `listTables` with no `DatabaseName` lists across all databases; it is
        // paginated, so collect every page and hydrate each into the `read`
        // Attributes shape.
        list: () =>
          Effect.gen(function* () {
            const refs = yield* withWriteEndpoint(
              TSW.listTables.pages({}).pipe(EffectStream.runCollect),
            ).pipe(
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.Tables ?? []).flatMap((table) =>
                    table.DatabaseName && table.TableName
                      ? [
                          {
                            databaseName: table.DatabaseName,
                            tableName: table.TableName,
                          },
                        ]
                      : [],
                  ),
                ),
              ),
            );
            const hydrated = yield* Effect.forEach(
              refs,
              (ref) => readTable(ref.databaseName, ref.tableName),
              { concurrency: 10 },
            );
            return hydrated.filter(
              (attrs): attrs is Table["Attributes"] => attrs !== undefined,
            );
          }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const databaseName = output?.databaseName ?? olds?.databaseName;
          if (!databaseName) return undefined;
          const tableName =
            output?.tableName ?? (yield* createTableName(id, olds ?? {}));
          const state = yield* readTable(databaseName, tableName);
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.tags as Tags))
            ? state
            : Unowned(state);
        }),
        diff: Effect.fn(function* ({ id, news, olds = {} }) {
          if (!isResolved(news)) return;
          const oldName = yield* createTableName(id, olds);
          const newName = yield* createTableName(id, news);
          // Table name or its owning database is immutable — either requires a
          // replacement.
          if (oldName !== newName || olds.databaseName !== news.databaseName) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (!news?.databaseName) {
            return yield* Effect.fail(
              new Error("Timestream Table requires a databaseName"),
            );
          }
          const { accountId, region } = yield* AWSEnvironment.current;
          const databaseName = news.databaseName;
          const tableName =
            output?.tableName ?? (yield* createTableName(id, news));
          const tableArn =
            `arn:aws:timestream:${region}:${accountId}:database/${databaseName}/table/${tableName}` as TableArn;
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredRetention = toWireRetention(news.retentionProperties);

          // Observe.
          let state = yield* readTable(databaseName, tableName);

          // Ensure — create if missing; tolerate a ConflictException race.
          if (state === undefined) {
            yield* withWriteEndpoint(
              TSW.createTable({
                DatabaseName: databaseName,
                TableName: tableName,
                RetentionProperties: desiredRetention,
                MagneticStoreWriteProperties: news.magneticStoreWriteProperties,
                Schema: news.schema,
                Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                  Key,
                  Value,
                })),
              }),
            ).pipe(Effect.catchTag("ConflictException", () => Effect.void));
            yield* session.note(`Creating table ${tableName}...`);
            state = yield* readTable(databaseName, tableName);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created table ${tableName}`),
              );
            }
          }

          // Sync retention / magnetic-store-write config — diff the desired
          // wire values against observed cloud state and skip the API call
          // entirely on a no-op.
          const retentionDrifted =
            desiredRetention !== undefined &&
            (state.retentionProperties?.MemoryStoreRetentionPeriodInHours !==
              desiredRetention.MemoryStoreRetentionPeriodInHours ||
              state.retentionProperties?.MagneticStoreRetentionPeriodInDays !==
                desiredRetention.MagneticStoreRetentionPeriodInDays);
          if (
            retentionDrifted ||
            news.magneticStoreWriteProperties !== undefined
          ) {
            yield* withWriteEndpoint(
              TSW.updateTable({
                DatabaseName: databaseName,
                TableName: tableName,
                RetentionProperties: desiredRetention,
                MagneticStoreWriteProperties: news.magneticStoreWriteProperties,
                Schema: news.schema,
              }),
            );
            yield* session.note(`Updated table ${tableName} configuration`);
          }

          // Sync tags — diff against observed cloud tags.
          const { removed, upsert } = diffTags(state.tags, desiredTags);
          if (removed.length > 0) {
            yield* withWriteEndpoint(
              TSW.untagResource({ ResourceARN: tableArn, TagKeys: removed }),
            );
          }
          if (upsert.length > 0) {
            yield* withWriteEndpoint(
              TSW.tagResource({
                ResourceARN: tableArn,
                Tags: upsert.map(({ Key, Value }) => ({ Key, Value })),
              }),
            );
          }

          yield* session.note(tableArn);

          const final = yield* readTable(databaseName, tableName);
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled table ${tableName}`),
            );
          }
          return final;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* withWriteEndpoint(
            TSW.deleteTable({
              DatabaseName: output.databaseName,
              TableName: output.tableName,
            }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
          );
        }),
      };
    }),
  );

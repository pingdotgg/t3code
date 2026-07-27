import * as keyspaces from "@distilled.cloud/aws/keyspaces";
import * as keyspacesstreams from "@distilled.cloud/aws/keyspacesstreams";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, diffTags, hasAlchemyTags } from "../../Tags.ts";
import { toWireSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";

/**
 * A Cassandra column definition. `type` is a CQL data type such as `text`,
 * `int`, `uuid`, `timestamp`, `blob`, or a collection like `list<text>`.
 */
export interface KeyspacesColumn {
  /** Column name. */
  name: string;
  /** CQL data type, e.g. `text`, `int`, `uuid`. */
  type: string;
}

/**
 * A clustering key column and its sort order.
 */
export interface KeyspacesClusteringKey {
  /** Name of a column also present in `columns`. */
  name: string;
  /**
   * Sort order for the clustering key.
   * @default "ASC"
   */
  orderBy?: "ASC" | "DESC";
}

/**
 * Read/write throughput mode for a table.
 */
export interface KeyspacesCapacity {
  /**
   * Billing mode.
   * @default "PAY_PER_REQUEST"
   */
  throughputMode: "PAY_PER_REQUEST" | "PROVISIONED";
  /** Provisioned read capacity units (only for `PROVISIONED`). */
  readCapacityUnits?: number;
  /** Provisioned write capacity units (only for `PROVISIONED`). */
  writeCapacityUnits?: number;
}

/**
 * Change data capture (CDC) stream configuration for a table.
 */
export interface KeyspacesCdcSpecification {
  /**
   * Whether CDC is enabled on the table.
   */
  status: "ENABLED" | "DISABLED";
  /**
   * What data is written to the table's stream for each changed row.
   * @default "NEW_AND_OLD_IMAGES"
   */
  viewType?: "NEW_IMAGE" | "OLD_IMAGE" | "KEYS_ONLY" | "NEW_AND_OLD_IMAGES";
}

export interface TableProps {
  /**
   * Name of the parent keyspace. Changing it replaces the table.
   */
  keyspaceName: string;
  /**
   * Name of the table. Must be 1-48 characters of `[a-zA-Z0-9_]`. If omitted a
   * deterministic physical name is generated. Changing the name replaces the
   * table.
   */
  tableName?: string;
  /**
   * All columns in the table, including those used as partition and clustering
   * keys. Adding new columns is applied in place; removing or retyping columns
   * replaces the table.
   */
  columns: KeyspacesColumn[];
  /**
   * Names of the columns forming the partition key (at least one). Changing
   * the partition key replaces the table.
   */
  partitionKeys: string[];
  /**
   * Columns forming the clustering (sort) key. Changing them replaces the
   * table.
   */
  clusteringKeys?: KeyspacesClusteringKey[];
  /**
   * Names of static columns (shared across all rows of a partition).
   */
  staticColumns?: string[];
  /**
   * Read/write throughput mode.
   * @default { throughputMode: "PAY_PER_REQUEST" }
   */
  capacity?: KeyspacesCapacity;
  /**
   * Enables point-in-time recovery (continuous backups).
   * @default false
   */
  pointInTimeRecovery?: boolean;
  /**
   * Enables row-level TTL on the table. Required before per-row TTLs can be
   * set. Enabling TTL cannot be undone without replacing the table.
   * @default false
   */
  ttlEnabled?: boolean;
  /**
   * Default TTL applied to all rows, e.g. `"1 day"` or `Duration.hours(12)`.
   * The API stores whole seconds. Requires `ttlEnabled`.
   */
  defaultTimeToLive?: Duration.Input;
  /**
   * Change data capture (CDC) stream configuration. Enabling CDC creates a
   * stream that captures row-level changes for 24 hours; consume it with the
   * `TableStreams` binding or the `keyspacesstreams` data-plane API.
   */
  cdcSpecification?: KeyspacesCdcSpecification;
  /**
   * User-defined tags for the table.
   */
  tags?: Record<string, string>;
}

export interface Table extends Resource<
  "AWS.Keyspaces.Table",
  TableProps,
  {
    /**
     * Name of the keyspace containing the table.
     */
    keyspaceName: string;
    /**
     * The table's physical name.
     */
    tableName: string;
    /**
     * ARN of the table.
     */
    tableArn: string;
    /**
     * Lifecycle status of the table (e.g. `CREATING`, `ACTIVE`).
     */
    status: string;
    /**
     * ARN of the most recent CDC stream, when `cdcSpecification` is enabled.
     */
    latestStreamArn: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Keyspaces (for Apache Cassandra) table.
 *
 * Tables are serverless and provisioned asynchronously (`CREATING` ->
 * `ACTIVE`), usually within a minute; the provider waits for `ACTIVE`
 * (bounded) before returning. Schema mutations (adding columns, changing
 * capacity/TTL/PITR) are applied in place; changing keys replaces the table.
 * @resource
 * @section Creating a Table
 * @example Simple Key-Value Table
 * ```typescript
 * const table = yield* Table("Sessions", {
 *   keyspaceName: keyspace.keyspaceName,
 *   columns: [
 *     { name: "id", type: "uuid" },
 *     { name: "data", type: "text" },
 *   ],
 *   partitionKeys: ["id"],
 * });
 * ```
 *
 * @example Table with a Clustering Key and TTL
 * ```typescript
 * const table = yield* Table("Events", {
 *   keyspaceName: keyspace.keyspaceName,
 *   columns: [
 *     { name: "device", type: "text" },
 *     { name: "ts", type: "timestamp" },
 *     { name: "payload", type: "blob" },
 *   ],
 *   partitionKeys: ["device"],
 *   clusteringKeys: [{ name: "ts", orderBy: "DESC" }],
 *   ttlEnabled: true,
 *   defaultTimeToLive: "1 day",
 * });
 * ```
 *
 * @section Change Data Capture
 * @example CDC-Enabled Table
 * ```typescript
 * const table = yield* Table("Orders", {
 *   keyspaceName: keyspace.keyspaceName,
 *   columns: [
 *     { name: "id", type: "uuid" },
 *     { name: "total", type: "int" },
 *   ],
 *   partitionKeys: ["id"],
 *   cdcSpecification: {
 *     status: "ENABLED",
 *     viewType: "NEW_AND_OLD_IMAGES",
 *   },
 * });
 * // table.latestStreamArn → consume via the TableStreams binding
 * ```
 */
export const Table = Resource<Table>("AWS.Keyspaces.Table");

const toTagRecord = (
  tags: keyspaces.Tag[] | undefined,
): Record<string, string> =>
  Object.fromEntries((tags ?? []).map((t) => [t.key, t.value]));

const buildSchema = (props: TableProps): keyspaces.SchemaDefinition => ({
  allColumns: props.columns.map((c) => ({ name: c.name, type: c.type })),
  partitionKeys: props.partitionKeys.map((name) => ({ name })),
  clusteringKeys: props.clusteringKeys?.map((c) => ({
    name: c.name,
    orderBy: c.orderBy ?? "ASC",
  })),
  staticColumns: props.staticColumns?.map((name) => ({ name })),
});

const activeStatuses = new Set(["ACTIVE"]);

export const TableProvider = () =>
  Provider.effect(
    Table,
    Effect.gen(function* () {
      const toName = (id: string, props: Partial<TableProps>) =>
        props.tableName
          ? Effect.succeed(props.tableName)
          : createPhysicalName({ id, maxLength: 48 }).pipe(
              Effect.map((n) => n.replaceAll("-", "_")),
            );

      const readTable = Effect.fn(function* (
        keyspaceName: string,
        tableName: string,
      ) {
        return yield* keyspaces
          .getTable({ keyspaceName, tableName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const readTags = Effect.fn(function* (arn: string) {
        const tags = yield* keyspaces.listTagsForResource
          .items({ resourceArn: arn })
          .pipe(
            Stream.runCollect,
            Effect.map((c) => Array.from(c)),
            Effect.catch(() => Effect.succeed<keyspaces.Tag[]>([])),
          );
        return toTagRecord(tags);
      });

      // Resolve the most recent CDC stream's ARN (streams are labeled with
      // their creation timestamp; the lexicographically greatest label is the
      // latest). Only meaningful while CDC is (or was recently) enabled.
      const readLatestStreamArn = Effect.fn(function* (
        keyspaceName: string,
        tableName: string,
      ) {
        const response = yield* keyspacesstreams
          .listStreams({ keyspaceName, tableName })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        const sorted = [...(response?.streams ?? [])].sort((a, b) =>
          b.streamLabel.localeCompare(a.streamLabel),
        );
        return sorted[0]?.streamArn;
      });

      const isCdcEnabled = (table: keyspaces.GetTableResponse) => {
        const status = table.cdcSpecification?.status;
        return status === "ENABLED" || status === "ENABLING";
      };

      // A freshly-enabled stream can lag ListStreams visibility briefly;
      // poll (bounded ~60s) and fall back to undefined rather than failing
      // the reconcile.
      const waitForStreamArn = Effect.fn(function* (
        keyspaceName: string,
        tableName: string,
      ) {
        return yield* readLatestStreamArn(keyspaceName, tableName).pipe(
          Effect.flatMap((arn) =>
            arn !== undefined
              ? Effect.succeed<string | undefined>(arn)
              : Effect.fail(
                  new Error(
                    `CDC stream for '${keyspaceName}.${tableName}' not yet visible`,
                  ),
                ),
          ),
          Effect.retry({
            schedule: Schedule.max([
              Schedule.fixed("5 seconds"),
              Schedule.recurs(12),
            ]),
          }),
          Effect.catch(() => Effect.succeed(undefined)),
        );
      });

      // Bounded readiness wait; Keyspaces tables typically reach ACTIVE within
      // a minute. Budget ~5 min (60 * 5s). When `requiredColumns` is provided
      // the wait also blocks until those columns are visible in the schema —
      // AddColumn updates return before the table transitions out of ACTIVE and
      // the new columns propagate to GetTable with a short lag.
      const waitForActive = Effect.fn(function* (
        keyspaceName: string,
        tableName: string,
        requiredColumns?: readonly string[],
      ) {
        const policy = Schedule.max([
          Schedule.fixed("5 seconds"),
          Schedule.recurs(60),
        ]);
        return yield* readTable(keyspaceName, tableName).pipe(
          Effect.flatMap((table) => {
            if (table === undefined) {
              return Effect.fail(
                new Error(`Keyspaces table '${tableName}' not found`),
              );
            }
            if (!activeStatuses.has(table.status ?? "")) {
              return Effect.fail(
                new Error(
                  `Keyspaces table '${tableName}' not active (status: ${table.status})`,
                ),
              );
            }
            if (requiredColumns !== undefined) {
              const present = new Set(
                (table.schemaDefinition?.allColumns ?? []).map((c) => c.name),
              );
              const missing = requiredColumns.filter((c) => !present.has(c));
              if (missing.length > 0) {
                return Effect.fail(
                  new Error(
                    `Keyspaces table '${tableName}' missing columns: ${missing.join(", ")}`,
                  ),
                );
              }
            }
            return Effect.succeed(table);
          }),
          Effect.retry({ schedule: policy }),
        );
      });

      const toCapacity = (
        capacity: KeyspacesCapacity | undefined,
      ): keyspaces.CapacitySpecification | undefined =>
        capacity === undefined
          ? undefined
          : {
              throughputMode: capacity.throughputMode,
              readCapacityUnits: capacity.readCapacityUnits,
              writeCapacityUnits: capacity.writeCapacityUnits,
            };

      return {
        stables: ["keyspaceName", "tableName", "tableArn"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const oldProps = olds as TableProps | undefined;
          if (oldProps === undefined) return undefined;
          if (news.keyspaceName !== oldProps.keyspaceName) {
            return { action: "replace" } as const;
          }
          if ((yield* toName(id, oldProps)) !== (yield* toName(id, news))) {
            return { action: "replace" } as const;
          }
          // Keys and column removals/retypes require a replacement; pure
          // column additions are handled in reconcile via UpdateTable.
          const newCols = new Map(news.columns.map((c) => [c.name, c.type]));
          const removedOrRetyped = oldProps.columns.some(
            (c) => newCols.get(c.name) !== c.type,
          );
          const keysChanged =
            JSON.stringify([...news.partitionKeys].sort()) !==
              JSON.stringify([...oldProps.partitionKeys].sort()) ||
            JSON.stringify(
              (news.clusteringKeys ?? [])
                .map((c) => `${c.name}:${c.orderBy ?? "ASC"}`)
                .sort(),
            ) !==
              JSON.stringify(
                (oldProps.clusteringKeys ?? [])
                  .map((c) => `${c.name}:${c.orderBy ?? "ASC"}`)
                  .sort(),
              ) ||
            JSON.stringify([...(news.staticColumns ?? [])].sort()) !==
              JSON.stringify([...(oldProps.staticColumns ?? [])].sort());
          if (removedOrRetyped || keysChanged) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const props = (olds ?? {}) as Partial<TableProps>;
          const keyspaceName = output?.keyspaceName ?? props.keyspaceName;
          if (keyspaceName === undefined) return undefined;
          const tableName = output?.tableName ?? (yield* toName(id, props));
          const found = yield* readTable(keyspaceName, tableName);
          if (found === undefined || found.status === "DELETING") {
            return undefined;
          }
          const attrs = {
            keyspaceName: found.keyspaceName,
            tableName: found.tableName,
            tableArn: found.resourceArn,
            status: found.status ?? "ACTIVE",
            latestStreamArn: isCdcEnabled(found)
              ? yield* readLatestStreamArn(found.keyspaceName, found.tableName)
              : undefined,
          };
          const tags = yield* readTags(found.resourceArn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const props = news as TableProps;
          const keyspaceName = props.keyspaceName;
          const tableName = output?.tableName ?? (yield* toName(id, props));
          // The Keyspaces API expects the default TTL in whole seconds.
          const desiredTtlSeconds = toWireSeconds(props.defaultTimeToLive);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...props.tags };

          // 1. Observe — cloud state is authoritative.
          let observed = yield* readTable(keyspaceName, tableName);

          // 2. Ensure — create if missing; tolerate the AlreadyExists race.
          if (observed === undefined) {
            yield* keyspaces
              .createTable({
                keyspaceName,
                tableName,
                schemaDefinition: buildSchema(props),
                capacitySpecification: toCapacity(props.capacity),
                pointInTimeRecovery: props.pointInTimeRecovery
                  ? { status: "ENABLED" }
                  : undefined,
                ttl: props.ttlEnabled ? { status: "ENABLED" } : undefined,
                defaultTimeToLive: desiredTtlSeconds,
                cdcSpecification:
                  props.cdcSpecification?.status === "ENABLED"
                    ? {
                        status: "ENABLED",
                        viewType:
                          props.cdcSpecification.viewType ??
                          "NEW_AND_OLD_IMAGES",
                      }
                    : undefined,
                tags: Object.entries(desiredTags).map(([key, value]) => ({
                  key,
                  value,
                })),
              })
              .pipe(Effect.catchTag("ConflictException", () => Effect.void));
          }

          observed = yield* waitForActive(keyspaceName, tableName);

          // 3. Sync mutable aspects against observed state.
          const update: keyspaces.UpdateTableRequest = {
            keyspaceName,
            tableName,
          };
          let needsUpdate = false;

          const observedCols = new Set(
            (observed.schemaDefinition?.allColumns ?? []).map((c) => c.name),
          );
          const addColumns = props.columns.filter(
            (c) => !observedCols.has(c.name),
          );
          if (addColumns.length > 0) {
            update.addColumns = addColumns.map((c) => ({
              name: c.name,
              type: c.type,
            }));
            needsUpdate = true;
          }

          const desiredCapacity = toCapacity(props.capacity);
          if (
            desiredCapacity !== undefined &&
            (desiredCapacity.throughputMode !==
              observed.capacitySpecification?.throughputMode ||
              (desiredCapacity.throughputMode === "PROVISIONED" &&
                (desiredCapacity.readCapacityUnits !==
                  observed.capacitySpecification?.readCapacityUnits ||
                  desiredCapacity.writeCapacityUnits !==
                    observed.capacitySpecification?.writeCapacityUnits)))
          ) {
            update.capacitySpecification = desiredCapacity;
            needsUpdate = true;
          }

          const desiredPitr = props.pointInTimeRecovery
            ? "ENABLED"
            : "DISABLED";
          if (
            desiredPitr !== (observed.pointInTimeRecovery?.status ?? "DISABLED")
          ) {
            update.pointInTimeRecovery = { status: desiredPitr };
            needsUpdate = true;
          }

          if (props.ttlEnabled && observed.ttl?.status !== "ENABLED") {
            update.ttl = { status: "ENABLED" };
            needsUpdate = true;
          }
          if (
            desiredTtlSeconds !== undefined &&
            desiredTtlSeconds !== observed.defaultTimeToLive
          ) {
            update.defaultTimeToLive = desiredTtlSeconds;
            needsUpdate = true;
          }

          const desiredCdcEnabled =
            props.cdcSpecification?.status === "ENABLED";
          if (desiredCdcEnabled !== isCdcEnabled(observed)) {
            update.cdcSpecification = desiredCdcEnabled
              ? {
                  status: "ENABLED",
                  viewType:
                    props.cdcSpecification?.viewType ?? "NEW_AND_OLD_IMAGES",
                }
              : { status: "DISABLED" };
            needsUpdate = true;
          }

          if (needsUpdate) {
            yield* keyspaces.updateTable(update);
            observed = yield* waitForActive(
              keyspaceName,
              tableName,
              props.columns.map((c) => c.name),
            );
          }

          // 3b. Sync tags — diff against OBSERVED cloud tags.
          const observedTags = yield* readTags(observed.resourceArn);
          const { upsert, removed } = diffTags(observedTags, desiredTags);
          if (upsert.length > 0) {
            yield* keyspaces.tagResource({
              resourceArn: observed.resourceArn,
              tags: upsert.map((t) => ({ key: t.Key, value: t.Value })),
            });
          }
          if (removed.length > 0) {
            yield* keyspaces.untagResource({
              resourceArn: observed.resourceArn,
              tags: removed.map((key) => ({ key, value: "" })),
            });
          }

          yield* session.note(`${keyspaceName}.${tableName}`);
          return {
            keyspaceName: observed.keyspaceName,
            tableName: observed.tableName,
            tableArn: observed.resourceArn,
            status: observed.status ?? "ACTIVE",
            latestStreamArn: isCdcEnabled(observed)
              ? yield* waitForStreamArn(
                  observed.keyspaceName,
                  observed.tableName,
                )
              : undefined,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          const { keyspaceName, tableName } = output;
          yield* keyspaces.deleteTable({ keyspaceName, tableName }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            // A table still CREATING/UPDATING rejects delete with
            // ConflictException; retry until it settles.
            Effect.retry({
              while: (e) => e._tag === "ConflictException",
              schedule: Schedule.max([
                Schedule.fixed("5 seconds"),
                Schedule.recurs(24),
              ]),
            }),
          );
          // Wait (bounded) until the table is gone so the parent keyspace can
          // be deleted without a ConflictException.
          yield* readTable(keyspaceName, tableName).pipe(
            Effect.flatMap((t) =>
              t === undefined
                ? Effect.void
                : Effect.fail(new Error(`Table '${tableName}' still deleting`)),
            ),
            Effect.retry({
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(20),
              ]),
            }),
            Effect.catch(() => Effect.void),
          );
        }),

        // Table is keyed by a parent keyspace and cannot be enumerated
        // account-wide without iterating every keyspace; treated as a
        // sub-resource per the factory list() convention.
        list: () => Effect.succeed([]),
      };
    }),
  );

import * as quicksight from "@distilled.cloud/aws/quicksight";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";
import {
  readQuickSightTags,
  syncQuickSightTags,
  toWireTags,
} from "./internal.ts";

/**
 * Properties for an Amazon QuickSight dataset — a prepared, queryable model
 * built on top of one or more data sources.
 */
export interface DataSetProps {
  /**
   * Unique id of the dataset within the account. Stable — changing it
   * replaces the dataset. If omitted, a unique id is generated.
   */
  dataSetId?: string;

  /**
   * Display name of the dataset.
   */
  name: string;

  /**
   * Declares the physical tables in the dataset, keyed by a physical table
   * id. Each maps to a relational table, custom SQL, or an S3 source.
   */
  physicalTableMap: { [key: string]: quicksight.PhysicalTable | undefined };

  /**
   * Whether the data is imported into SPICE or queried directly.
   */
  importMode: quicksight.DataSetImportMode;

  /**
   * Declares logical tables (joins, transforms) keyed by logical table id.
   */
  logicalTableMap?: { [key: string]: quicksight.LogicalTable | undefined };

  /**
   * Column groupings (e.g. geospatial hierarchies).
   */
  columnGroups?: quicksight.ColumnGroup[];

  /**
   * Field folders that organize the dataset's fields.
   */
  fieldFolders?: { [key: string]: quicksight.FieldFolder | undefined };

  /**
   * Resource-level permissions on the dataset.
   */
  permissions?: quicksight.ResourcePermission[];

  /**
   * Row-level permission configuration backed by a permissions dataset.
   */
  rowLevelPermissionDataSet?: quicksight.RowLevelPermissionDataSet;

  /**
   * Usage configuration controlling how the dataset can be used
   * (e.g. as a source for other datasets).
   */
  dataSetUsageConfiguration?: quicksight.DataSetUsageConfiguration;

  /**
   * Parameters exposed by the dataset.
   */
  datasetParameters?: quicksight.DatasetParameter[];

  /**
   * Tags to apply to the dataset.
   */
  tags?: Record<string, string>;
}

export interface DataSet extends Resource<
  "AWS.QuickSight.DataSet",
  DataSetProps,
  {
    /** Unique id of the dataset within the account. */
    dataSetId: string;
    /** ARN of the dataset. */
    arn: string;
    /** Display name of the dataset. */
    name: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon QuickSight dataset — a prepared, queryable model built on top of
 * one or more data sources.
 *
 * QuickSight requires an active account subscription in the region. Without
 * one, create operations fail with the typed `QuickSightSubscriptionRequired`
 * error.
 *
 * @section Creating a Dataset
 * @example SPICE Dataset from a Relational Table
 * ```typescript
 * const dataset = yield* DataSet("sales", {
 *   name: "Sales",
 *   importMode: "SPICE",
 *   physicalTableMap: {
 *     sales: {
 *       RelationalTable: {
 *         DataSourceArn: source.arn,
 *         Name: "sales",
 *         InputColumns: [{ Name: "amount", Type: "DECIMAL" }],
 *       },
 *     },
 *   },
 * });
 * ```
 *
 * @resource
 */
export const DataSet = Resource<DataSet>("AWS.QuickSight.DataSet");

export const DataSetProvider = () =>
  Provider.effect(
    DataSet,
    Effect.gen(function* () {
      const toId = (id: string, props: Partial<DataSetProps>) =>
        props.dataSetId
          ? Effect.succeed(props.dataSetId)
          : createPhysicalName({ id, maxLength: 64 });

      const readSet = Effect.fn(function* (
        accountId: string,
        dataSetId: string,
      ) {
        const response = yield* quicksight
          .describeDataSet({ AwsAccountId: accountId, DataSetId: dataSetId })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.DataSet;
      });

      const toAttrs = (set: quicksight.DataSet) => ({
        dataSetId: set.DataSetId!,
        arn: set.Arn!,
        name: set.Name ?? "",
      });

      return DataSet.Provider.of({
        stables: ["dataSetId", "arn"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toId(id, olds)) !== (yield* toId(id, news))) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, olds = {}, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const dataSetId = output?.dataSetId ?? (yield* toId(id, olds));
          const set = yield* readSet(accountId, dataSetId);
          if (set === undefined) return undefined;
          const attrs = toAttrs(set);
          const tags = yield* readQuickSightTags(attrs.arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const dataSetId = output?.dataSetId ?? (yield* toId(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe.
          let observed = yield* readSet(accountId, dataSetId);

          // 2. Ensure — create if missing (tolerate AlreadyExists race).
          if (observed === undefined) {
            yield* quicksight
              .createDataSet({
                AwsAccountId: accountId,
                DataSetId: dataSetId,
                Name: news.name,
                PhysicalTableMap: news.physicalTableMap,
                ImportMode: news.importMode,
                LogicalTableMap: news.logicalTableMap,
                ColumnGroups: news.columnGroups,
                FieldFolders: news.fieldFolders,
                Permissions: news.permissions,
                RowLevelPermissionDataSet: news.rowLevelPermissionDataSet,
                DataSetUsageConfiguration: news.dataSetUsageConfiguration,
                DatasetParameters: news.datasetParameters,
                Tags: toWireTags(desiredTags),
              })
              .pipe(
                Effect.catchTag("ResourceExistsException", () => Effect.void),
              );
          } else {
            // 3. Sync — idempotent update of the dataset definition.
            yield* quicksight.updateDataSet({
              AwsAccountId: accountId,
              DataSetId: dataSetId,
              Name: news.name,
              PhysicalTableMap: news.physicalTableMap,
              ImportMode: news.importMode,
              LogicalTableMap: news.logicalTableMap,
              ColumnGroups: news.columnGroups,
              FieldFolders: news.fieldFolders,
              RowLevelPermissionDataSet: news.rowLevelPermissionDataSet,
              DataSetUsageConfiguration: news.dataSetUsageConfiguration,
              DatasetParameters: news.datasetParameters,
            });
          }

          observed = yield* readSet(accountId, dataSetId);
          if (observed === undefined) {
            return yield* Effect.fail(
              new Error(
                `QuickSight dataset '${dataSetId}' not found after reconcile`,
              ),
            );
          }

          // 3b. Sync tags.
          yield* syncQuickSightTags(observed.Arn!, desiredTags);

          yield* session.note(dataSetId);
          return toAttrs(observed);
        }),

        delete: Effect.fn(function* ({ output }) {
          const { accountId } = yield* AWSEnvironment.current;
          yield* quicksight
            .deleteDataSet({
              AwsAccountId: accountId,
              DataSetId: output.dataSetId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),

        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            return yield* quicksight.listDataSets
              .pages({ AwsAccountId: accountId })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk)
                    .flatMap((page) => page.DataSetSummaries ?? [])
                    .flatMap((s) =>
                      s.DataSetId !== undefined && s.Arn !== undefined
                        ? [
                            {
                              dataSetId: s.DataSetId,
                              arn: s.Arn,
                              name: s.Name ?? "",
                            },
                          ]
                        : [],
                    ),
                ),
              );
          }),
      });
    }),
  );

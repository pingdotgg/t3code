import * as lf from "@distilled.cloud/aws/lakeformation";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Providers } from "../Providers.ts";

/**
 * Row-level filter condition for a {@link DataCellsFilter}.
 */
export interface RowFilterSpec {
  /**
   * PartiQL predicate selecting the visible rows (e.g.
   * `country = 'US'`). Mutually exclusive with `allRows`.
   */
  filterExpression?: string;
  /**
   * When true, all rows are visible (column-level filtering only).
   * @default true when `filterExpression` is omitted
   */
  allRows?: boolean;
}

export interface DataCellsFilterProps {
  /**
   * Name of the filter (unique per table). If omitted, a unique name is
   * generated from the app, stage, and logical id. Changing it replaces the
   * filter.
   */
  name?: string;
  /**
   * Name of the Glue database that contains the table. Changing it replaces
   * the filter.
   */
  databaseName: string;
  /**
   * Name of the Glue table the filter applies to. Changing it replaces the
   * filter.
   */
  tableName: string;
  /**
   * The catalog id (AWS account id) the table lives in. Changing it
   * replaces the filter.
   * @default the caller's account
   */
  tableCatalogId?: string;
  /**
   * Row-level filter. Defaults to all rows.
   */
  rowFilter?: RowFilterSpec;
  /**
   * Include-list of visible column names. Mutually exclusive with
   * `excludedColumnNames`.
   */
  columnNames?: string[];
  /**
   * Exclude-list of column names (a column wildcard excluding these
   * columns). Mutually exclusive with `columnNames`.
   */
  excludedColumnNames?: string[];
}

export interface DataCellsFilter extends Resource<
  "AWS.LakeFormation.DataCellsFilter",
  DataCellsFilterProps,
  {
    name: string;
    databaseName: string;
    tableName: string;
    tableCatalogId: string;
    versionId: string | undefined;
  },
  {},
  Providers
> {}

/**
 * A Lake Formation data cells filter — row- and column-level security on a
 * Glue table. Grant `SELECT` on the filter (via
 * `Resource.DataCellsFilter`) to give principals access to only the
 * filtered cells.
 *
 * Creating filters requires `SELECT` with the grant option on the table (or
 * data lake administrator) — see
 * {@link DataLakeSettings | AWS.LakeFormation.DataLakeSettings}.
 *
 * @resource
 * @section Creating Data Cells Filters
 * @example Column Filter Hiding PII
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const filter = yield* AWS.LakeFormation.DataCellsFilter("NoPii", {
 *   databaseName: database.databaseName,
 *   tableName: table.tableName,
 *   excludedColumnNames: ["email", "ssn"],
 * });
 * ```
 *
 * @example Row Filter by Country
 * ```typescript
 * const filter = yield* AWS.LakeFormation.DataCellsFilter("UsOnly", {
 *   databaseName: database.databaseName,
 *   tableName: table.tableName,
 *   rowFilter: { filterExpression: "country = 'US'" },
 * });
 * ```
 */
export const DataCellsFilter = Resource<DataCellsFilter>(
  "AWS.LakeFormation.DataCellsFilter",
);

export const DataCellsFilterProvider = () =>
  Provider.effect(
    DataCellsFilter,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { name?: string | undefined },
      ) {
        return (
          props.name ??
          (yield* createPhysicalName({ id, maxLength: 255, lowercase: true }))
        );
      });

      const observe = Effect.fn(function* (key: {
        tableCatalogId: string;
        databaseName: string;
        tableName: string;
        name: string;
      }) {
        return yield* lf
          .getDataCellsFilter({
            TableCatalogId: key.tableCatalogId,
            DatabaseName: key.databaseName,
            TableName: key.tableName,
            Name: key.name,
          })
          .pipe(
            Effect.map((r) => r.DataCellsFilter),
            Effect.catchTag("EntityNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const toTableData = (
        news: DataCellsFilterProps,
        key: { tableCatalogId: string; name: string },
      ): lf.DataCellsFilter => ({
        TableCatalogId: key.tableCatalogId,
        DatabaseName: news.databaseName,
        TableName: news.tableName,
        Name: key.name,
        RowFilter:
          news.rowFilter?.filterExpression !== undefined
            ? { FilterExpression: news.rowFilter.filterExpression }
            : { AllRowsWildcard: {} },
        ColumnNames: news.columnNames,
        ColumnWildcard:
          news.excludedColumnNames !== undefined
            ? { ExcludedColumnNames: news.excludedColumnNames }
            : news.columnNames === undefined
              ? {}
              : undefined,
      });

      return DataCellsFilter.Provider.of({
        stables: ["name", "databaseName", "tableName", "tableCatalogId"],

        list: () =>
          Effect.gen(function* () {
            const { accountId } = yield* AWSEnvironment.current;
            const pages = yield* lf.listDataCellsFilter
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.DataCellsFilters ?? [])
              .map((filter) => ({
                name: filter.Name,
                databaseName: filter.DatabaseName,
                tableName: filter.TableName,
                tableCatalogId: filter.TableCatalogId ?? accountId,
                versionId: filter.VersionId,
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId } = yield* AWSEnvironment.current;
          const databaseName = output?.databaseName ?? olds?.databaseName;
          const tableName = output?.tableName ?? olds?.tableName;
          if (databaseName === undefined || tableName === undefined) {
            return undefined;
          }
          const name = output?.name ?? (yield* createName(id, olds ?? {}));
          const tableCatalogId =
            output?.tableCatalogId ?? olds?.tableCatalogId ?? accountId;
          const found = yield* observe({
            tableCatalogId,
            databaseName,
            tableName,
            name,
          });
          if (found === undefined) return undefined;
          // Data cells filters are not taggable — ownership cannot be
          // verified.
          return {
            name,
            databaseName,
            tableName,
            tableCatalogId,
            versionId: found.VersionId,
          };
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          if (
            news.databaseName !== olds.databaseName ||
            news.tableName !== olds.tableName ||
            (news.tableCatalogId ?? undefined) !==
              (olds.tableCatalogId ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
          // rowFilter / columnNames / excludedColumnNames → update
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId } = yield* AWSEnvironment.current;
          const name = output?.name ?? (yield* createName(id, news));
          const tableCatalogId = news.tableCatalogId ?? accountId;
          const key = {
            tableCatalogId,
            databaseName: news.databaseName,
            tableName: news.tableName,
            name,
          };
          const desired = toTableData(news, { tableCatalogId, name });

          // 1. OBSERVE
          let found = yield* observe(key);

          // 2. ENSURE
          if (found === undefined) {
            yield* lf
              .createDataCellsFilter({ TableData: desired })
              .pipe(
                Effect.catchTag("AlreadyExistsException", () => Effect.void),
              );
            found = yield* observe(key);
          } else {
            // 3. SYNC — diff observed filter body against desired.
            const observed = {
              RowFilter: found.RowFilter,
              ColumnNames: found.ColumnNames,
              ColumnWildcard: found.ColumnWildcard,
            };
            const want = {
              RowFilter: desired.RowFilter,
              ColumnNames: desired.ColumnNames,
              ColumnWildcard: desired.ColumnWildcard,
            };
            if (JSON.stringify(observed) !== JSON.stringify(want)) {
              yield* lf.updateDataCellsFilter({
                TableData: { ...desired, VersionId: found.VersionId },
              });
              found = yield* observe(key);
            }
          }

          yield* session.note(`${news.databaseName}.${news.tableName}/${name}`);
          return {
            name,
            databaseName: news.databaseName,
            tableName: news.tableName,
            tableCatalogId,
            versionId: found?.VersionId,
          };
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* lf
            .deleteDataCellsFilter({
              TableCatalogId: output.tableCatalogId,
              DatabaseName: output.databaseName,
              TableName: output.tableName,
              Name: output.name,
            })
            .pipe(
              Effect.catchTag("EntityNotFoundException", () => Effect.void),
            );
        }),
      });
    }),
  );

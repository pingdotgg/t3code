import * as databrew from "@distilled.cloud/aws/databrew";
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
  databrewArn,
  fetchObservedTags,
  retryWhileConflict,
  syncTags,
} from "./internal.ts";

/** An Amazon S3 location (bucket + optional key prefix). */
export interface S3Location {
  /** The S3 bucket name. */
  bucket: string;
  /** The object key (or key prefix) within the bucket. */
  key?: string;
  /** The account ID of the bucket owner (for cross-account buckets). */
  bucketOwner?: string;
}

/** Where DataBrew reads the dataset's data from. Exactly one definition. */
export interface DatasetInput {
  /** Read directly from Amazon S3. */
  s3InputDefinition?: S3Location;
  /** Read from an AWS Glue Data Catalog table. */
  dataCatalogInputDefinition?: {
    /** The Data Catalog ID (defaults to the caller's account). */
    catalogId?: string;
    /** The Glue database name. */
    databaseName: string;
    /** The Glue table name. */
    tableName: string;
    /** S3 temp directory for intermediate results. */
    tempDirectory?: S3Location;
  };
  /** Read from a JDBC database through a Glue connection. */
  databaseInputDefinition?: {
    /** The Glue connection name. */
    glueConnectionName: string;
    /** The database table to read. Mutually exclusive with `queryString`. */
    databaseTableName?: string;
    /** S3 temp directory for intermediate results. */
    tempDirectory?: S3Location;
    /** A custom SQL query to select the data. */
    queryString?: string;
  };
}

/** Format-specific parsing options. */
export interface DatasetFormatOptions {
  /** JSON parsing options. */
  json?: {
    /** Whether the file contains multi-line JSON records. */
    multiLine?: boolean;
  };
  /** Excel parsing options. */
  excel?: {
    /** Sheet names to include (max 1). */
    sheetNames?: string[];
    /** Zero-based sheet indexes to include (max 1). */
    sheetIndexes?: number[];
    /** Whether the first row is a header. @default true */
    headerRow?: boolean;
  };
  /** CSV parsing options. */
  csv?: {
    /** The single-character field delimiter. @default "," */
    delimiter?: string;
    /** Whether the first row is a header. @default true */
    headerRow?: boolean;
  };
}

/** A filter expression with substitution variables, e.g. `relative_before :dateParam`. */
export interface FilterExpression {
  /** The expression, e.g. `ends_with :suffix`. */
  expression: string;
  /** Variable substitutions keyed by `:name`. */
  valuesMap: Record<string, string>;
}

/** Options that shape how S3 path parameters select matching files. */
export interface DatasetPathOptions {
  /** Only include files last modified within this condition. */
  lastModifiedDateCondition?: FilterExpression;
  /** Cap the number of matched files. */
  filesLimit?: {
    /** Maximum number of files to include. */
    maxFiles: number;
    /** Ordering attribute. @default "LAST_MODIFIED_DATE" */
    orderedBy?: "LAST_MODIFIED_DATE" | (string & {});
    /** Sort direction. @default "DESCENDING" */
    order?: "DESCENDING" | "ASCENDING" | (string & {});
  };
  /** Path parameter definitions keyed by parameter name. */
  parameters?: Record<
    string,
    {
      /** The parameter name (must match the key). */
      name: string;
      /** The parameter type. */
      type: "Datetime" | "Number" | "String" | (string & {});
      /** Datetime parsing options (required for `Datetime`). */
      datetimeOptions?: {
        /** The datetime format, e.g. `yyyy-MM-dd`. */
        format: string;
        /** Timezone offset, e.g. `Z` or `+02:00`. */
        timezoneOffset?: string;
        /** Locale code for month/day names. */
        localeCode?: string;
      };
      /** Whether to add a column holding the parameter value. */
      createColumn?: boolean;
      /** Filter which parameter values match. */
      filter?: FilterExpression;
    }
  >;
}

export interface DatasetProps {
  /**
   * Name of the dataset. If omitted, a unique name is generated. Changing
   * the name replaces the dataset.
   * @default a generated physical name
   */
  datasetName?: string;
  /**
   * The file format of the source data: `CSV`, `JSON`, `PARQUET`, `EXCEL`,
   * or `ORC`.
   */
  format?: "CSV" | "JSON" | "PARQUET" | "EXCEL" | "ORC" | (string & {});
  /**
   * Format-specific parsing options (CSV delimiter, JSON multi-line, Excel
   * sheets).
   */
  formatOptions?: DatasetFormatOptions;
  /**
   * Where the data lives — S3, a Glue Data Catalog table, or a JDBC
   * database.
   */
  input: DatasetInput;
  /**
   * Path options for dynamic S3 datasets (parameterized paths, file limits).
   */
  pathOptions?: DatasetPathOptions;
  /**
   * Tags to apply to the dataset. Merged with internal Alchemy tags.
   */
  tags?: Record<string, string>;
}

export interface Dataset extends Resource<
  "AWS.DataBrew.Dataset",
  DatasetProps,
  {
    /** Name of the dataset. */
    datasetName: string;
    /** ARN of the dataset. */
    datasetArn: string;
  },
  {},
  Providers
> {}

/**
 * An AWS Glue DataBrew dataset — a pointer to source data (S3 file/prefix,
 * Glue Data Catalog table, or JDBC query) plus parsing options. The dataset
 * definition itself stores no data and is free; it is consumed by DataBrew
 * projects and jobs.
 * @resource
 * @section Creating Datasets
 * @example CSV Dataset from S3
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const dataset = yield* AWS.DataBrew.Dataset("Sales", {
 *   format: "CSV",
 *   formatOptions: { csv: { delimiter: ",", headerRow: true } },
 *   input: {
 *     s3InputDefinition: {
 *       bucket: bucket.bucketName,
 *       key: "raw/sales.csv",
 *     },
 *   },
 * });
 * ```
 *
 * @example JSON Dataset
 * ```typescript
 * const dataset = yield* AWS.DataBrew.Dataset("Events", {
 *   format: "JSON",
 *   formatOptions: { json: { multiLine: false } },
 *   input: {
 *     s3InputDefinition: { bucket: bucket.bucketName, key: "events/" },
 *   },
 * });
 * ```
 *
 * @section Glue Data Catalog
 * @example Dataset from a Catalog Table
 * ```typescript
 * const dataset = yield* AWS.DataBrew.Dataset("Curated", {
 *   input: {
 *     dataCatalogInputDefinition: {
 *       databaseName: glueDatabase.databaseName,
 *       tableName: "curated_sales",
 *     },
 *   },
 * });
 * ```
 */
export const Dataset = Resource<Dataset>("AWS.DataBrew.Dataset");

export const buildS3Location = (location: S3Location) => ({
  Bucket: location.bucket,
  Key: location.key,
  BucketOwner: location.bucketOwner,
});

const buildFilterExpression = (filter: FilterExpression) => ({
  Expression: filter.expression,
  ValuesMap: filter.valuesMap,
});

const buildInput = (input: DatasetInput) => ({
  S3InputDefinition: input.s3InputDefinition
    ? buildS3Location(input.s3InputDefinition)
    : undefined,
  DataCatalogInputDefinition: input.dataCatalogInputDefinition
    ? {
        CatalogId: input.dataCatalogInputDefinition.catalogId,
        DatabaseName: input.dataCatalogInputDefinition.databaseName,
        TableName: input.dataCatalogInputDefinition.tableName,
        TempDirectory: input.dataCatalogInputDefinition.tempDirectory
          ? buildS3Location(input.dataCatalogInputDefinition.tempDirectory)
          : undefined,
      }
    : undefined,
  DatabaseInputDefinition: input.databaseInputDefinition
    ? {
        GlueConnectionName: input.databaseInputDefinition.glueConnectionName,
        DatabaseTableName: input.databaseInputDefinition.databaseTableName,
        TempDirectory: input.databaseInputDefinition.tempDirectory
          ? buildS3Location(input.databaseInputDefinition.tempDirectory)
          : undefined,
        QueryString: input.databaseInputDefinition.queryString,
      }
    : undefined,
});

const buildFormatOptions = (options: DatasetFormatOptions | undefined) =>
  options
    ? {
        Json: options.json ? { MultiLine: options.json.multiLine } : undefined,
        Excel: options.excel
          ? {
              SheetNames: options.excel.sheetNames,
              SheetIndexes: options.excel.sheetIndexes,
              HeaderRow: options.excel.headerRow,
            }
          : undefined,
        Csv: options.csv
          ? {
              Delimiter: options.csv.delimiter,
              HeaderRow: options.csv.headerRow,
            }
          : undefined,
      }
    : undefined;

const buildPathOptions = (options: DatasetPathOptions | undefined) =>
  options
    ? {
        LastModifiedDateCondition: options.lastModifiedDateCondition
          ? buildFilterExpression(options.lastModifiedDateCondition)
          : undefined,
        FilesLimit: options.filesLimit
          ? {
              MaxFiles: options.filesLimit.maxFiles,
              OrderedBy: options.filesLimit.orderedBy,
              Order: options.filesLimit.order,
            }
          : undefined,
        Parameters: options.parameters
          ? Object.fromEntries(
              Object.entries(options.parameters).map(([key, param]) => [
                key,
                {
                  Name: param.name,
                  Type: param.type,
                  DatetimeOptions: param.datetimeOptions
                    ? {
                        Format: param.datetimeOptions.format,
                        TimezoneOffset: param.datetimeOptions.timezoneOffset,
                        LocaleCode: param.datetimeOptions.localeCode,
                      }
                    : undefined,
                  CreateColumn: param.createColumn,
                  Filter: param.filter
                    ? buildFilterExpression(param.filter)
                    : undefined,
                },
              ]),
            )
          : undefined,
      }
    : undefined;

export const DatasetProvider = () =>
  Provider.effect(
    Dataset,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: { datasetName?: string | undefined },
      ) {
        return (
          props.datasetName ??
          (yield* createPhysicalName({ id, maxLength: 255 }))
        );
      });

      const observe = Effect.fn(function* (name: string) {
        return yield* databrew
          .describeDataset({ Name: name })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const buildDefinition = (props: DatasetProps) => ({
        Format: props.format,
        FormatOptions: buildFormatOptions(props.formatOptions),
        Input: buildInput(props.input),
        PathOptions: buildPathOptions(props.pathOptions),
      });

      return Dataset.Provider.of({
        stables: ["datasetName", "datasetArn"],

        list: () =>
          Effect.gen(function* () {
            const { accountId, region } = yield* AWSEnvironment.current;
            const pages = yield* databrew.listDatasets
              .pages({})
              .pipe(Stream.runCollect);
            return Array.from(pages)
              .flatMap((page) => page.Datasets ?? [])
              .map((d) => ({
                datasetName: d.Name,
                datasetArn:
                  d.ResourceArn ??
                  databrewArn(region, accountId, "dataset", d.Name),
              }));
          }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name =
            output?.datasetName ?? (yield* createName(id, olds ?? {}));
          const dataset = yield* observe(name);
          if (dataset === undefined) return undefined;
          const arn =
            dataset.ResourceArn ??
            databrewArn(region, accountId, "dataset", name);
          const attrs = { datasetName: name, datasetArn: arn };
          const tags = yield* fetchObservedTags(arn);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (oldName !== newName) return { action: "replace" } as const;
          // everything else is UpdateDataset-able
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const { accountId, region } = yield* AWSEnvironment.current;
          const name = output?.datasetName ?? (yield* createName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...news.tags, ...internalTags };

          // 1. OBSERVE
          const dataset = yield* observe(name);

          // 2. ENSURE / 3. SYNC — UpdateDataset is a full PUT of the definition
          if (dataset === undefined) {
            yield* databrew
              .createDataset({
                Name: name,
                ...buildDefinition(news),
                Tags: desiredTags,
              })
              .pipe(
                // creation race — another reconcile won; fall through to sync
                Effect.catchTag("ConflictException", () => Effect.void),
              );
          } else {
            yield* databrew.updateDataset({
              Name: name,
              ...buildDefinition(news),
            });
          }

          const arn =
            dataset?.ResourceArn ??
            databrewArn(region, accountId, "dataset", name);

          // 3b. SYNC TAGS against observed cloud tags
          const observedTags = yield* fetchObservedTags(arn);
          yield* syncTags(arn, observedTags, desiredTags);

          yield* session.note(name);
          return { datasetName: name, datasetArn: arn };
        }),

        delete: Effect.fn(function* ({ output }) {
          // A ConflictException surfaces briefly after an associated project
          // or job is deleted (eventual consistency) — retry bounded.
          yield* retryWhileConflict(
            databrew.deleteDataset({ Name: output.datasetName }),
          ).pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        }),
      });
    }),
  );

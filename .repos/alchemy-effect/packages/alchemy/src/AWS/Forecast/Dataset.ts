import * as forecast from "@distilled.cloud/aws/forecast";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  readForecastTags,
  syncForecastTags,
  toForecastName,
} from "./internal.ts";

export interface SchemaAttribute {
  /** Name of the field in the dataset (e.g. `item_id`, `timestamp`). */
  attributeName: string;
  /** Type of the field: `string`, `integer`, `float`, `timestamp`, or `geolocation`. */
  attributeType: string;
}

export interface DatasetSchema {
  /** The ordered list of fields that make up the dataset. */
  attributes: SchemaAttribute[];
}

export interface DatasetEncryptionConfig {
  /** ARN of the IAM role Forecast assumes to access the KMS key. */
  roleArn: string;
  /** ARN of the customer-managed KMS key. */
  kmsKeyArn: string;
}

export interface DatasetProps {
  /**
   * Name of the dataset. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing the name replaces the dataset.
   */
  datasetName?: string;
  /**
   * The forecasting domain: `RETAIL`, `CUSTOM`, `INVENTORY_PLANNING`,
   * `EC2_CAPACITY`, `WORK_FORCE`, `WEB_TRAFFIC`, or `METRICS`. Immutable —
   * changing it replaces the dataset.
   */
  domain: string;
  /**
   * The dataset type: `TARGET_TIME_SERIES`, `RELATED_TIME_SERIES`, or
   * `ITEM_METADATA`. Immutable — changing it replaces the dataset.
   */
  datasetType: string;
  /**
   * The frequency of data collection (e.g. `D` for daily, `H` for hourly).
   * Required for time-series datasets. Immutable — changing it replaces the
   * dataset.
   */
  dataFrequency?: string;
  /**
   * The schema describing the dataset's fields. Immutable — changing it
   * replaces the dataset.
   */
  schema: DatasetSchema;
  /**
   * Customer-managed KMS encryption configuration. Immutable — changing it
   * replaces the dataset.
   */
  encryptionConfig?: DatasetEncryptionConfig;
  /**
   * User-defined tags for the dataset.
   */
  tags?: Record<string, string>;
}

export interface Dataset extends Resource<
  "AWS.Forecast.Dataset",
  DatasetProps,
  {
    /** The ARN of the dataset. */
    datasetArn: string;
    /** The name of the dataset. */
    datasetName: string;
    /** The forecasting domain of the dataset, e.g. `RETAIL` or `CUSTOM`. */
    domain: string;
    /** The dataset type, e.g. `TARGET_TIME_SERIES`. */
    datasetType: string;
    /** The dataset status, e.g. `ACTIVE`. */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Forecast dataset — a typed, domain-scoped collection of
 * time-series (or metadata) records described by a schema. Creating the
 * dataset is a cheap metadata operation; bulk imports and training happen
 * through separate import jobs and predictors.
 *
 * @resource
 * @section Creating a Dataset
 * @example Target Time-Series Dataset
 * ```typescript
 * const dataset = yield* Forecast.Dataset("Demand", {
 *   domain: "CUSTOM",
 *   datasetType: "TARGET_TIME_SERIES",
 *   dataFrequency: "D",
 *   schema: {
 *     attributes: [
 *       { attributeName: "item_id", attributeType: "string" },
 *       { attributeName: "timestamp", attributeType: "timestamp" },
 *       { attributeName: "target_value", attributeType: "float" },
 *     ],
 *   },
 * });
 * ```
 */
export const Dataset = Resource<Dataset>("AWS.Forecast.Dataset");

export const DatasetProvider = () =>
  Provider.effect(
    Dataset,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: DatasetProps) {
        return (
          props.datasetName ??
          toForecastName(yield* createPhysicalName({ id, maxLength: 63 }))
        );
      });

      const describe = Effect.fn(function* (datasetArn: string) {
        return yield* forecast
          .describeDataset({ DatasetArn: datasetArn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const toAttrs = (dataset: forecast.DescribeDatasetResponse) => ({
        datasetArn: dataset.DatasetArn!,
        datasetName: dataset.DatasetName!,
        domain: dataset.Domain!,
        datasetType: dataset.DatasetType!,
        status: dataset.Status!,
      });

      return {
        stables: ["datasetArn", "datasetName"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            (olds.domain ?? undefined) !== (news.domain ?? undefined) ||
            (olds.datasetType ?? undefined) !==
              (news.datasetType ?? undefined) ||
            (olds.dataFrequency ?? undefined) !==
              (news.dataFrequency ?? undefined) ||
            JSON.stringify(olds.schema ?? null) !==
              JSON.stringify(news.schema ?? null)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          if (!output?.datasetArn) return undefined;
          const dataset = yield* describe(output.datasetArn);
          if (dataset === undefined) return undefined;
          const attrs = toAttrs(dataset);
          const tags = yield* readForecastTags(dataset.DatasetArn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          let dataset =
            output?.datasetArn !== undefined
              ? yield* describe(output.datasetArn)
              : undefined;

          if (dataset === undefined) {
            const created = yield* forecast.createDataset({
              DatasetName: name,
              Domain: news.domain,
              DatasetType: news.datasetType,
              DataFrequency: news.dataFrequency,
              Schema: {
                Attributes: news.schema.attributes.map((a) => ({
                  AttributeName: a.attributeName,
                  AttributeType: a.attributeType,
                })),
              },
              EncryptionConfig: news.encryptionConfig
                ? {
                    RoleArn: news.encryptionConfig.roleArn,
                    KMSKeyArn: news.encryptionConfig.kmsKeyArn,
                  }
                : undefined,
              Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            });
            dataset = yield* describe(created.DatasetArn!);
          } else {
            yield* syncForecastTags(dataset.DatasetArn!, desiredTags);
          }

          yield* session.note(dataset!.DatasetArn!);
          return toAttrs(dataset!);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* forecast.deleteDataset({ DatasetArn: output.datasetArn }).pipe(
            Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            Effect.retry({
              while: (e) => e._tag === "ResourceInUseException",
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(20),
              ]),
            }),
          );
        }),

        list: () =>
          forecast.listDatasets.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.Datasets ?? []),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  describe(summary.DatasetArn!).pipe(
                    Effect.map((d) => (d ? toAttrs(d) : undefined)),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((items) => items.filter((item) => item !== undefined)),
          ),
      };
    }),
  );

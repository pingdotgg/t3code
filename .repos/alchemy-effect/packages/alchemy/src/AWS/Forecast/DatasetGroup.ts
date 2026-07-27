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

export interface DatasetGroupProps {
  /**
   * Name of the dataset group. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing the name replaces the group.
   */
  datasetGroupName?: string;
  /**
   * The forecasting domain: `RETAIL`, `CUSTOM`, `INVENTORY_PLANNING`,
   * `EC2_CAPACITY`, `WORK_FORCE`, `WEB_TRAFFIC`, or `METRICS`. Immutable —
   * changing it replaces the group.
   */
  domain: string;
  /**
   * ARNs of the datasets to attach to the group. This is an in-place update —
   * changing the set re-associates the datasets without replacing the group.
   */
  datasetArns?: string[];
  /**
   * User-defined tags for the dataset group.
   */
  tags?: Record<string, string>;
}

export interface DatasetGroup extends Resource<
  "AWS.Forecast.DatasetGroup",
  DatasetGroupProps,
  {
    /** The ARN of the dataset group. */
    datasetGroupArn: string;
    /** The name of the dataset group. */
    datasetGroupName: string;
    /** The forecasting domain of the group, e.g. `RETAIL` or `CUSTOM`. */
    domain: string;
    /** The dataset group status, e.g. `ACTIVE`. */
    status: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Forecast dataset group — a domain-scoped container that groups the
 * datasets used to train predictors. Creating the group is cheap; the
 * expensive training work lives in predictors and forecasts provisioned
 * separately.
 *
 * @resource
 * @section Creating a Dataset Group
 * @example Custom Dataset Group
 * ```typescript
 * const group = yield* Forecast.DatasetGroup("Sales", {
 *   domain: "CUSTOM",
 * });
 * ```
 *
 * @example Dataset Group with Attached Datasets
 * ```typescript
 * const group = yield* Forecast.DatasetGroup("Sales", {
 *   domain: "RETAIL",
 *   datasetArns: [dataset.datasetArn],
 *   tags: { team: "planning" },
 * });
 * ```
 */
export const DatasetGroup = Resource<DatasetGroup>("AWS.Forecast.DatasetGroup");

const sameArns = (a: string[], b: string[]) => {
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.length === sb.length && sa.every((v, i) => v === sb[i]);
};

export const DatasetGroupProvider = () =>
  Provider.effect(
    DatasetGroup,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: DatasetGroupProps,
      ) {
        return (
          props.datasetGroupName ??
          toForecastName(yield* createPhysicalName({ id, maxLength: 63 }))
        );
      });

      const describe = Effect.fn(function* (datasetGroupArn: string) {
        return yield* forecast
          .describeDatasetGroup({ DatasetGroupArn: datasetGroupArn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
      });

      const toAttrs = (group: forecast.DescribeDatasetGroupResponse) => ({
        datasetGroupArn: group.DatasetGroupArn!,
        datasetGroupName: group.DatasetGroupName!,
        domain: group.Domain!,
        status: group.Status!,
      });

      return {
        stables: ["datasetGroupArn", "datasetGroupName"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            (olds.domain ?? undefined) !== (news.domain ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          if (!output?.datasetGroupArn) return undefined;
          const group = yield* describe(output.datasetGroupArn);
          if (group === undefined) return undefined;
          const attrs = toAttrs(group);
          const tags = yield* readForecastTags(group.DatasetGroupArn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredArns = news.datasetArns ?? [];

          // 1. Observe — cloud state is authoritative; output is an ARN cache.
          let group =
            output?.datasetGroupArn !== undefined
              ? yield* describe(output.datasetGroupArn)
              : undefined;

          // 2. Ensure — create if missing.
          if (group === undefined) {
            const created = yield* forecast.createDatasetGroup({
              DatasetGroupName: name,
              Domain: news.domain,
              DatasetArns: desiredArns,
              Tags: Object.entries(desiredTags).map(([Key, Value]) => ({
                Key,
                Value,
              })),
            });
            group = yield* describe(created.DatasetGroupArn!);
          } else {
            // 3. Sync attached datasets — in-place update on drift.
            if (!sameArns(group.DatasetArns ?? [], desiredArns)) {
              yield* forecast.updateDatasetGroup({
                DatasetGroupArn: group.DatasetGroupArn!,
                DatasetArns: desiredArns,
              });
            }
            // 3b. Sync tags — diff against OBSERVED cloud tags.
            yield* syncForecastTags(group.DatasetGroupArn!, desiredTags);
          }

          const arn = group!.DatasetGroupArn!;
          yield* session.note(arn);
          const fresh = (yield* describe(arn)) ?? group!;
          return toAttrs(fresh);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* forecast
            .deleteDatasetGroup({ DatasetGroupArn: output.datasetGroupArn })
            .pipe(
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
          forecast.listDatasetGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.DatasetGroups ?? []),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  describe(summary.DatasetGroupArn!).pipe(
                    Effect.map((g) => (g ? toAttrs(g) : undefined)),
                  ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((items) => items.filter((item) => item !== undefined)),
          ),
      };
    }),
  );

import * as personalize from "@distilled.cloud/aws/personalize";
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
import { readPersonalizeTags, syncPersonalizeTags } from "./internal.ts";

export interface DatasetProps {
  /**
   * Name of the dataset. If omitted, a unique name is generated from the app,
   * stage, and logical ID. Changing the name replaces the dataset.
   */
  name?: string;
  /**
   * ARN of the schema that describes this dataset's fields. Immutable —
   * changing it replaces the dataset.
   */
  schemaArn: string;
  /**
   * ARN of the dataset group this dataset belongs to. Immutable — changing it
   * replaces the dataset.
   */
  datasetGroupArn: string;
  /**
   * The type of dataset: `Interactions`, `Items`, `Users`, `Actions`, or
   * `Action_Interactions`. Immutable — changing it replaces the dataset.
   */
  datasetType: string;
  /**
   * User-defined tags for the dataset.
   */
  tags?: Record<string, string>;
}

export interface Dataset extends Resource<
  "AWS.Personalize.Dataset",
  DatasetProps,
  {
    /**
     * ARN of the dataset.
     */
    datasetArn: string;
    /**
     * Name of the dataset.
     */
    name: string;
    /**
     * Dataset type (`Interactions`, `Items`, `Users`, or `Actions`).
     */
    datasetType: string;
    /**
     * Dataset status (e.g. `ACTIVE`, `CREATE PENDING`).
     */
    status: string;
    /**
     * ARN of the schema the dataset conforms to.
     */
    schemaArn: string;
    /**
     * ARN of the dataset group the dataset belongs to.
     */
    datasetGroupArn: string;
  },
  never,
  Providers
> {}

/**
 * An Amazon Personalize dataset — a typed collection (Interactions, Items,
 * Users, …) inside a dataset group, backed by a schema. Creating the dataset
 * is a cheap metadata operation; bulk imports and training happen through
 * separate import jobs and solutions.
 *
 * @resource
 * @section Creating a Dataset
 * @example Interactions Dataset
 * ```typescript
 * const dataset = yield* Personalize.Dataset("Interactions", {
 *   schemaArn: schema.schemaArn,
 *   datasetGroupArn: group.datasetGroupArn,
 *   datasetType: "Interactions",
 * });
 * ```
 */
export const Dataset = Resource<Dataset>("AWS.Personalize.Dataset");

export const DatasetProvider = () =>
  Provider.effect(
    Dataset,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (id: string, props: DatasetProps) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 63 }));
      });

      const describe = Effect.fn(function* (datasetArn: string) {
        const response = yield* personalize
          .describeDataset({ datasetArn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.dataset;
      });

      const waitActive = Effect.fn(function* (datasetArn: string) {
        const dataset = yield* describe(datasetArn).pipe(
          Effect.repeat({
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(40),
            ]),
            until: (d) =>
              d?.status === "ACTIVE" || (d?.status ?? "").includes("FAILED"),
          }),
        );
        if (dataset?.status !== "ACTIVE") {
          return yield* Effect.fail(
            new Error(
              `Personalize dataset ${datasetArn} did not become ACTIVE (status: ${dataset?.status})`,
            ),
          );
        }
        return dataset;
      });

      /** Find an existing dataset's ARN by name within its dataset group. */
      const findArnByName = Effect.fn(function* (
        name: string,
        datasetGroupArn: string,
      ) {
        const pages = yield* personalize.listDatasets
          .pages({ datasetGroupArn })
          .pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.datasets ?? [])
          .find((summary) => summary.name === name)?.datasetArn;
      });

      const toAttrs = (dataset: personalize.Dataset) => ({
        datasetArn: dataset.datasetArn!,
        name: dataset.name!,
        datasetType: dataset.datasetType!,
        status: dataset.status!,
        schemaArn: dataset.schemaArn!,
        datasetGroupArn: dataset.datasetGroupArn!,
      });

      return {
        stables: ["datasetArn", "name"],

        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            (olds.schemaArn ?? undefined) !== (news.schemaArn ?? undefined) ||
            (olds.datasetGroupArn ?? undefined) !==
              (news.datasetGroupArn ?? undefined) ||
            (olds.datasetType ?? undefined) !== (news.datasetType ?? undefined)
          ) {
            return { action: "replace" } as const;
          }
        }),

        read: Effect.fn(function* ({ id, output }) {
          if (!output?.datasetArn) return undefined;
          const dataset = yield* describe(output.datasetArn);
          if (dataset === undefined) return undefined;
          const attrs = toAttrs(dataset);
          const tags = yield* readPersonalizeTags(dataset.datasetArn!);
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

          // Ensure — create if missing. A crashed prior run may have left a
          // same-named dataset behind with no persisted state — adopt it by
          // name and converge.
          if (dataset === undefined) {
            const arn = yield* personalize
              .createDataset({
                name,
                schemaArn: news.schemaArn,
                datasetGroupArn: news.datasetGroupArn,
                datasetType: news.datasetType,
                tags: Object.entries(desiredTags).map(([tagKey, tagValue]) => ({
                  tagKey,
                  tagValue,
                })),
              })
              .pipe(
                Effect.map((created) => created.datasetArn!),
                Effect.catchTag("ResourceAlreadyExistsException", (error) =>
                  findArnByName(name, news.datasetGroupArn).pipe(
                    Effect.flatMap((existing) =>
                      existing === undefined
                        ? Effect.fail(error)
                        : Effect.succeed(existing),
                    ),
                  ),
                ),
              );
            dataset = yield* waitActive(arn);
          }

          // Sync tags — diff against OBSERVED cloud tags (no-op after a fresh
          // create; converges an adopted leftover).
          yield* syncPersonalizeTags(dataset.datasetArn!, desiredTags);

          yield* session.note(dataset.datasetArn!);
          return toAttrs(dataset);
        }),

        delete: Effect.fn(function* ({ output }) {
          yield* personalize
            .deleteDataset({ datasetArn: output.datasetArn })
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
          // Deletion is asynchronous (DELETE PENDING) — wait until the dataset
          // is actually gone so the schema and dataset group it references can
          // delete without exhausting their ResourceInUse retries.
          const remaining = yield* describe(output.datasetArn).pipe(
            Effect.repeat({
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(40),
              ]),
              until: (dataset): boolean => dataset === undefined,
            }),
          );
          if (remaining !== undefined) {
            return yield* Effect.fail(
              new Error(
                `Personalize dataset ${output.datasetArn} was not deleted (status: ${remaining.status})`,
              ),
            );
          }
        }),

        // Datasets are keyed by their parent dataset group (ListDatasets
        // requires a datasetGroupArn), so account-wide enumeration walks the
        // dataset groups first and lists each group's datasets. Without this,
        // orphaned datasets are invisible to nuke and permanently block both
        // their schema and their dataset group from deleting.
        list: () =>
          personalize.listDatasetGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.datasetGroups ?? []),
            ),
            Effect.flatMap(
              Effect.forEach(
                (group) =>
                  personalize.listDatasets
                    .pages({ datasetGroupArn: group.datasetGroupArn })
                    .pipe(
                      Stream.runCollect,
                      Effect.map((chunk) =>
                        Array.from(chunk).flatMap(
                          (page) => page.datasets ?? [],
                        ),
                      ),
                    ),
                { concurrency: 4 },
              ),
            ),
            Effect.map((groups) => groups.flat()),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  describe(summary.datasetArn!).pipe(
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

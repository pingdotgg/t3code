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

export interface DatasetGroupProps {
  /**
   * Name of the dataset group. If omitted, a unique name is generated from the
   * app, stage, and logical ID. Changing the name replaces the group.
   */
  name?: string;
  /**
   * ARN of an IAM role Personalize assumes to access a customer-managed KMS
   * key. Immutable — changing it replaces the group.
   */
  roleArn?: string;
  /**
   * ARN of a customer-managed KMS key used to encrypt the datasets. Immutable
   * — changing it replaces the group.
   */
  kmsKeyArn?: string;
  /**
   * The domain of a domain dataset group (`ECOMMERCE` or `VIDEO_ON_DEMAND`).
   * Omit for a custom dataset group. Immutable — changing it replaces the
   * group.
   */
  domain?: string;
  /**
   * User-defined tags for the dataset group.
   */
  tags?: Record<string, string>;
}

export interface DatasetGroup extends Resource<
  "AWS.Personalize.DatasetGroup",
  DatasetGroupProps,
  {
    /**
     * ARN of the dataset group.
     */
    datasetGroupArn: string;
    /**
     * Name of the dataset group.
     */
    name: string;
    /**
     * Dataset group status (e.g. `ACTIVE`, `CREATE PENDING`).
     */
    status: string;
    /**
     * Domain of the dataset group (`ECOMMERCE` or `VIDEO_ON_DEMAND`) when
     * it is a domain dataset group.
     */
    domain: string | undefined;
  },
  never,
  Providers
> {}

/**
 * An Amazon Personalize dataset group — the top-level container that holds the
 * datasets, solutions, and campaigns for a single use case. Creating a dataset
 * group is cheap and fast; the expensive training work lives in solutions and
 * campaigns provisioned separately.
 *
 * @resource
 * @section Creating a Dataset Group
 * @example Custom Dataset Group
 * ```typescript
 * const group = yield* Personalize.DatasetGroup("Recommendations", {});
 * ```
 *
 * @example Domain Dataset Group with Encryption
 * ```typescript
 * const group = yield* Personalize.DatasetGroup("Storefront", {
 *   domain: "ECOMMERCE",
 *   roleArn: role.roleArn,
 *   kmsKeyArn: key.keyArn,
 *   tags: { team: "growth" },
 * });
 * ```
 */
export const DatasetGroup = Resource<DatasetGroup>(
  "AWS.Personalize.DatasetGroup",
);

export const DatasetGroupProvider = () =>
  Provider.effect(
    DatasetGroup,
    Effect.gen(function* () {
      const createName = Effect.fn(function* (
        id: string,
        props: DatasetGroupProps,
      ) {
        return props.name ?? (yield* createPhysicalName({ id, maxLength: 63 }));
      });

      const describe = Effect.fn(function* (datasetGroupArn: string) {
        const response = yield* personalize
          .describeDatasetGroup({ datasetGroupArn })
          .pipe(
            Effect.catchTag("ResourceNotFoundException", () =>
              Effect.succeed(undefined),
            ),
          );
        return response?.datasetGroup;
      });

      /** Poll until the group reaches ACTIVE; fail fast on CREATE FAILED. */
      const waitActive = Effect.fn(function* (datasetGroupArn: string) {
        const group = yield* describe(datasetGroupArn).pipe(
          Effect.repeat({
            schedule: Schedule.max([
              Schedule.fixed("2 seconds"),
              Schedule.recurs(40),
            ]),
            until: (g) =>
              g?.status === "ACTIVE" || (g?.status ?? "").includes("FAILED"),
          }),
        );
        if (group?.status !== "ACTIVE") {
          return yield* Effect.fail(
            new Error(
              `Personalize dataset group ${datasetGroupArn} did not become ACTIVE (status: ${group?.status}, reason: ${group?.failureReason})`,
            ),
          );
        }
        return group;
      });

      /** Find an existing dataset group's ARN by its (deterministic) name. */
      const findArnByName = Effect.fn(function* (name: string) {
        const pages = yield* personalize.listDatasetGroups
          .pages({})
          .pipe(Stream.runCollect);
        return Array.from(pages)
          .flatMap((page) => page.datasetGroups ?? [])
          .find((summary) => summary.name === name)?.datasetGroupArn;
      });

      const toAttrs = (group: personalize.DatasetGroup) => ({
        datasetGroupArn: group.datasetGroupArn!,
        name: group.name!,
        status: group.status!,
        domain: group.domain,
      });

      /** Bounded retry schedule for ResourceInUse while async deletes drain. */
      const inUseRetry = {
        while: (e: { _tag: string }) => e._tag === "ResourceInUseException",
        schedule: Schedule.max([
          Schedule.fixed("3 seconds"),
          Schedule.recurs(20),
        ]),
      };

      const listChildren = Effect.fn(function* (datasetGroupArn: string) {
        const [trackers, filters, solutions, datasets] = yield* Effect.all(
          [
            personalize.listEventTrackers.pages({ datasetGroupArn }).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.eventTrackers ?? []),
              ),
            ),
            personalize.listFilters.pages({ datasetGroupArn }).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.Filters ?? []),
              ),
            ),
            personalize.listSolutions.pages({ datasetGroupArn }).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.solutions ?? []),
              ),
            ),
            personalize.listDatasets.pages({ datasetGroupArn }).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) => page.datasets ?? []),
              ),
            ),
          ],
          { concurrency: 4 },
        );
        return { trackers, filters, solutions, datasets };
      });

      /**
       * DeleteDatasetGroup requires all children (event trackers, filters,
       * campaigns, solutions, datasets) to be deleted first. Children created
       * out-of-band (e.g. via CreateSolution/CreateCampaign runtime bindings)
       * are not tracked in state, so the group drains any that remain. Each
       * child delete is idempotent (NotFound tolerated) and asynchronous, so
       * after issuing the deletes we poll (bounded) until the group is empty.
       */
      const drainChildren = Effect.fn(function* (datasetGroupArn: string) {
        const { trackers, filters, solutions, datasets } =
          yield* listChildren(datasetGroupArn);

        yield* Effect.forEach(
          trackers,
          (t) =>
            personalize
              .deleteEventTracker({ eventTrackerArn: t.eventTrackerArn! })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
                Effect.retry(inUseRetry),
              ),
          { concurrency: 4 },
        );

        yield* Effect.forEach(
          filters,
          (f) =>
            personalize.deleteFilter({ filterArn: f.filterArn! }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry(inUseRetry),
            ),
          { concurrency: 4 },
        );

        // Campaigns block their solution's deletion, so drain them per
        // solution before deleting the solution.
        yield* Effect.forEach(
          solutions,
          Effect.fn(function* (s) {
            const campaigns = yield* personalize.listCampaigns
              .pages({ solutionArn: s.solutionArn })
              .pipe(
                Stream.runCollect,
                Effect.map((chunk) =>
                  Array.from(chunk).flatMap((page) => page.campaigns ?? []),
                ),
              );
            yield* Effect.forEach(
              campaigns,
              (c) =>
                personalize
                  .deleteCampaign({ campaignArn: c.campaignArn! })
                  .pipe(
                    Effect.catchTag(
                      "ResourceNotFoundException",
                      () => Effect.void,
                    ),
                    Effect.retry(inUseRetry),
                  ),
              { concurrency: 4 },
            );
            yield* personalize
              .deleteSolution({ solutionArn: s.solutionArn! })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () => Effect.void),
                // Campaign deletion is async — retry while it drains.
                Effect.retry(inUseRetry),
              );
          }),
          { concurrency: 2 },
        );

        yield* Effect.forEach(
          datasets,
          (d) =>
            personalize.deleteDataset({ datasetArn: d.datasetArn! }).pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              Effect.retry(inUseRetry),
            ),
          { concurrency: 4 },
        );

        // All child deletes are asynchronous — wait (bounded) until the group
        // reports no remaining children so DeleteDatasetGroup succeeds.
        const remaining = yield* listChildren(datasetGroupArn).pipe(
          Effect.repeat({
            schedule: Schedule.max([
              Schedule.fixed("3 seconds"),
              Schedule.recurs(40),
            ]),
            until: (children): boolean =>
              children.trackers.length === 0 &&
              children.filters.length === 0 &&
              children.solutions.length === 0 &&
              children.datasets.length === 0,
          }),
        );
        if (
          remaining.trackers.length +
            remaining.filters.length +
            remaining.solutions.length +
            remaining.datasets.length >
          0
        ) {
          return yield* Effect.fail(
            new Error(
              `Personalize dataset group ${datasetGroupArn} still has children after drain (trackers: ${remaining.trackers.length}, filters: ${remaining.filters.length}, solutions: ${remaining.solutions.length}, datasets: ${remaining.datasets.length})`,
            ),
          );
        }
      });

      return {
        stables: ["datasetGroupArn", "name"],

        diff: Effect.fn(function* ({ id, olds = {}, news }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* createName(id, olds);
          const newName = yield* createName(id, news);
          if (
            oldName !== newName ||
            (olds.roleArn ?? undefined) !== (news.roleArn ?? undefined) ||
            (olds.kmsKeyArn ?? undefined) !== (news.kmsKeyArn ?? undefined) ||
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
          const tags = yield* readPersonalizeTags(group.datasetGroupArn!);
          return (yield* hasAlchemyTags(id, tags)) ? attrs : Unowned(attrs);
        }),

        reconcile: Effect.fn(function* ({ id, news = {}, output, session }) {
          const name = yield* createName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // 1. Observe — cloud state is authoritative; output is an ARN cache.
          let group =
            output?.datasetGroupArn !== undefined
              ? yield* describe(output.datasetGroupArn)
              : undefined;

          // 2. Ensure — create if missing, then wait for ACTIVE. A crashed
          //    prior run may have left a same-named group behind with no
          //    persisted state — adopt it by name and converge.
          if (group === undefined) {
            const arn = yield* personalize
              .createDatasetGroup({
                name,
                roleArn: news.roleArn,
                kmsKeyArn: news.kmsKeyArn,
                domain: news.domain,
                tags: Object.entries(desiredTags).map(([tagKey, tagValue]) => ({
                  tagKey,
                  tagValue,
                })),
              })
              .pipe(
                Effect.map((created) => created.datasetGroupArn!),
                Effect.catchTag("ResourceAlreadyExistsException", (error) =>
                  findArnByName(name).pipe(
                    Effect.flatMap((existing) =>
                      existing === undefined
                        ? Effect.fail(error)
                        : Effect.succeed(existing),
                    ),
                  ),
                ),
              );
            group = yield* waitActive(arn);
          }

          // 3. Sync tags — diff against OBSERVED cloud tags (no-op after a
          //    fresh create; converges an adopted leftover).
          yield* syncPersonalizeTags(group.datasetGroupArn!, desiredTags);

          yield* session.note(group.datasetGroupArn!);
          return toAttrs(group);
        }),

        delete: Effect.fn(function* ({ output }) {
          // DeleteDatasetGroup requires every child — event trackers, filters,
          // campaigns, solutions, and datasets — to be deleted first, and each
          // child delete is itself asynchronous. Deletion ordering can't
          // guarantee children-before-parent (bindings/tests create children
          // out-of-band that are not tracked in state), so drain the group's
          // remaining children before deleting the group itself. Every step is
          // idempotent and NotFound-tolerant.
          const group = yield* describe(output.datasetGroupArn);
          if (group !== undefined) {
            yield* drainChildren(output.datasetGroupArn);
          }
          yield* personalize
            .deleteDatasetGroup({ datasetGroupArn: output.datasetGroupArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
              // Tolerate the eventual-consistency window while the drained
              // children finish their own asynchronous deletions.
              Effect.retry({
                while: (e) => e._tag === "ResourceInUseException",
                schedule: Schedule.max([
                  Schedule.fixed("3 seconds"),
                  Schedule.recurs(20),
                ]),
              }),
            );
          // Deletion is asynchronous (DELETE IN_PROGRESS) — wait until the
          // group is actually gone so the run leaves no lingering resources
          // (the group's auto-created event schema is removed with it).
          const remaining = yield* describe(output.datasetGroupArn).pipe(
            Effect.repeat({
              schedule: Schedule.max([
                Schedule.fixed("3 seconds"),
                Schedule.recurs(40),
              ]),
              until: (group): boolean => group === undefined,
            }),
          );
          if (remaining !== undefined) {
            return yield* Effect.fail(
              new Error(
                `Personalize dataset group ${output.datasetGroupArn} was not deleted (status: ${remaining.status})`,
              ),
            );
          }
        }),

        list: () =>
          personalize.listDatasetGroups.pages({}).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) => page.datasetGroups ?? []),
            ),
            Effect.flatMap(
              Effect.forEach(
                (summary) =>
                  describe(summary.datasetGroupArn!).pipe(
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

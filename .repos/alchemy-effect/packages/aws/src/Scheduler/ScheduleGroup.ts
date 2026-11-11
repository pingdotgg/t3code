import * as scheduler from "@distilled.cloud/aws/scheduler";
import { isResolved } from "alchemy/Diff";
import { createPhysicalName } from "alchemy/PhysicalName";
import * as Provider from "alchemy/Provider";
import { Resource } from "alchemy/Resource";
import { createInternalTags, createTagsList, diffTags, hasTags, tagRecord } from "alchemy/Tags";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { Providers } from "../Providers.ts";

export class ScheduleGroupConflict extends Data.TaggedError("ScheduleGroupConflict")<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export class ScheduleGroupUnexpectedResponse extends Data.TaggedError(
  "ScheduleGroupUnexpectedResponse",
)<{
  readonly message: string;
  readonly cause?: unknown;
}> {}

export interface ScheduleGroupProps {
  /**
   * Schedule group name. If omitted, Alchemy generates a deterministic name.
   */
  name?: string;
  /**
   * User-defined tags for the schedule group.
   */
  tags?: Record<string, string>;
}

/**
 * An EventBridge Scheduler schedule group.
 *
 * Schedule groups provide a namespace for schedules so higher-level helpers can
 * organize recurring jobs separately from one-shot or operational schedules.
 * ### Creating Schedule Groups
 * **Example:** Basic Group
 * ```typescript
 * const group = yield* ScheduleGroup("Operations", {
 *   tags: {
 *     domain: "ops",
 *   },
 * });
 * ```
 *
 * @resource
 */
export interface ScheduleGroup extends Resource<
  "AWS.Scheduler.ScheduleGroup",
  ScheduleGroupProps,
  {
    /**
     * ARN of the schedule group.
     */
    scheduleGroupArn: string;
    /**
     * Name of the schedule group.
     */
    scheduleGroupName: string;
    /**
     * Current state of the schedule group (`ACTIVE` or `DELETING`).
     */
    state: string | undefined;
    /**
     * Tags on the schedule group, as observed. Lets `alchemy drift` detect
     * out-of-band changes.
     */
    tags?: Record<string, string>;
  },
  never,
  Providers
> {}

export const ScheduleGroup = Resource<ScheduleGroup>("AWS.Scheduler.ScheduleGroup");

export const ScheduleGroupProvider = () =>
  Provider.effect(
    ScheduleGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: ScheduleGroupProps) =>
        props.name ? Effect.succeed(props.name) : createPhysicalName({ id, maxLength: 64 });

      return {
        stables: ["scheduleGroupArn", "scheduleGroupName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if ((yield* toName(id, olds)) !== (yield* toName(id, news as ScheduleGroupProps))) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const scheduleGroupName = output?.scheduleGroupName ?? (yield* toName(id, olds));
          const described = yield* scheduler
            .getScheduleGroup({
              Name: scheduleGroupName,
            })
            .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));

          if (!described?.Arn || !described.Name) {
            return undefined;
          }

          const { Tags } = yield* scheduler
            .listTagsForResource({ ResourceArn: described.Arn })
            .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.succeed({ Tags: [] })));
          return {
            scheduleGroupArn: described.Arn,
            scheduleGroupName: described.Name,
            state: described.State,
            tags: tagRecord(Tags),
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const scheduleGroupName = output?.scheduleGroupName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live group; gracefully handle missing.
          let observed = yield* scheduler
            .getScheduleGroup({ Name: scheduleGroupName })
            .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));

          // Ensure — create if missing. Tolerate `ConflictException` as a
          // race or adoption case: verify ownership via tags before
          // continuing.
          if (!observed?.Arn) {
            yield* scheduler
              .createScheduleGroup({
                Name: scheduleGroupName,
                Tags: createTagsList(desiredTags),
              })
              .pipe(
                Effect.catchTag("ConflictException", () =>
                  scheduler.getScheduleGroup({ Name: scheduleGroupName }).pipe(
                    Effect.flatMap((existing) =>
                      existing.Arn
                        ? scheduler.listTagsForResource({ ResourceArn: existing.Arn }).pipe(
                            Effect.filterOrFail(
                              ({ Tags }) => hasTags(internalTags, Tags),
                              () =>
                                new ScheduleGroupConflict({
                                  message: `ScheduleGroup '${scheduleGroupName}' already exists and is not managed by alchemy`,
                                }),
                            ),
                            Effect.asVoid,
                          )
                        : Effect.fail(
                            new ScheduleGroupConflict({
                              message: `ScheduleGroup '${scheduleGroupName}' already exists but could not be described`,
                            }),
                          ),
                    ),
                  ),
                ),
              );
            observed = yield* scheduler
              .getScheduleGroup({ Name: scheduleGroupName })
              .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.undefined));
          }

          if (!observed?.Arn) {
            return yield* new ScheduleGroupUnexpectedResponse({
              message: `Failed to read created ScheduleGroup '${scheduleGroupName}'`,
            });
          }

          const groupArn = observed.Arn;

          // Sync tags — diff observed cloud tags against desired so
          // adoption rewrites ownership tags.
          const observedTagsResp = yield* scheduler
            .listTagsForResource({ ResourceArn: groupArn })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed({ Tags: [] as scheduler.Tag[] }),
              ),
            );
          const observedTags = Object.fromEntries(
            (observedTagsResp.Tags ?? []).map((t) => [t.Key, t.Value]),
          );
          const { removed, upsert } = diffTags(observedTags, desiredTags);

          if (removed.length > 0) {
            yield* scheduler.untagResource({
              ResourceArn: groupArn,
              TagKeys: removed,
            });
          }
          if (upsert.length > 0) {
            yield* scheduler.tagResource({
              ResourceArn: groupArn,
              Tags: upsert,
            });
          }

          yield* session.note(groupArn);

          return {
            scheduleGroupArn: groupArn,
            scheduleGroupName,
            state: observed?.State,
            tags: desiredTags,
          };
        }),
        list: () =>
          Effect.gen(function* () {
            // Enumerate every schedule group in the account/region,
            // paginated.
            const summaries = yield* scheduler.listScheduleGroups.pages({}).pipe(
              Stream.runCollect,
              Effect.map((chunk) =>
                Array.from(chunk).flatMap((page) =>
                  (page.ScheduleGroups ?? []).filter(
                    (
                      g,
                    ): g is scheduler.ScheduleGroupSummary & {
                      Name: string;
                    } => g.Name != null,
                  ),
                ),
              ),
            );

            // Hydrate each summary via GetScheduleGroup into the exact
            // `read` shape. Skip groups deleted between list and get.
            const rows = yield* Effect.forEach(
              summaries,
              (summary) =>
                scheduler.getScheduleGroup({ Name: summary.Name }).pipe(
                  Effect.map((described) =>
                    described.Arn && described.Name
                      ? {
                          scheduleGroupArn: described.Arn,
                          scheduleGroupName: described.Name,
                          state: described.State,
                        }
                      : undefined,
                  ),
                  Effect.catchTag("ResourceNotFoundException", () => Effect.undefined),
                ),
              { concurrency: 10 },
            );

            return rows.filter((row): row is ScheduleGroup["Attributes"] => row !== undefined);
          }),
        delete: Effect.fn(function* ({ output }) {
          yield* scheduler
            .deleteScheduleGroup({
              Name: output.scheduleGroupName,
            })
            .pipe(Effect.catchTag("ResourceNotFoundException", () => Effect.void));
        }),
      };
    }),
  );

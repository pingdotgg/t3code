import * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import {
  createInternalTags,
  createTagsList,
  diffTags,
  hasTags,
} from "../../Tags.ts";

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
 *
 * @section Creating Schedule Groups
 * @example Basic Group
 * ```typescript
 * const group = yield* ScheduleGroup("Operations", {
 *   tags: {
 *     domain: "ops",
 *   },
 * });
 * ```
 */
export interface ScheduleGroup extends Resource<
  "AWS.Scheduler.ScheduleGroup",
  ScheduleGroupProps,
  {
    scheduleGroupArn: string;
    scheduleGroupName: string;
    state: string | undefined;
  },
  never,
  Providers
> {}

export const ScheduleGroup = Resource<ScheduleGroup>(
  "AWS.Scheduler.ScheduleGroup",
);

export const ScheduleGroupProvider = () =>
  Provider.effect(
    ScheduleGroup,
    Effect.gen(function* () {
      const toName = (id: string, props: ScheduleGroupProps) =>
        props.name
          ? Effect.succeed(props.name)
          : createPhysicalName({ id, maxLength: 64 });

      return {
        stables: ["scheduleGroupArn", "scheduleGroupName"],
        diff: Effect.fn(function* ({ id, olds, news }) {
          if (!isResolved(news)) return undefined;
          if (
            (yield* toName(id, olds)) !==
            (yield* toName(id, news as ScheduleGroupProps))
          ) {
            return { action: "replace" } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const scheduleGroupName =
            output?.scheduleGroupName ?? (yield* toName(id, olds));
          const described = yield* scheduler
            .getScheduleGroup({
              Name: scheduleGroupName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

          if (!described?.Arn || !described.Name) {
            return undefined;
          }

          return {
            scheduleGroupArn: described.Arn,
            scheduleGroupName: described.Name,
            state: described.State,
          };
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const scheduleGroupName =
            output?.scheduleGroupName ?? (yield* toName(id, news));
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };

          // Observe — fetch live group; gracefully handle missing.
          let observed = yield* scheduler
            .getScheduleGroup({ Name: scheduleGroupName })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () =>
                Effect.succeed(undefined),
              ),
            );

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
                        ? scheduler
                            .listTagsForResource({ ResourceArn: existing.Arn })
                            .pipe(
                              Effect.filterOrFail(
                                ({ Tags }) => hasTags(internalTags, Tags),
                                () =>
                                  new Error(
                                    `ScheduleGroup '${scheduleGroupName}' already exists and is not managed by alchemy`,
                                  ),
                              ),
                              Effect.asVoid,
                            )
                        : Effect.fail(
                            new Error(
                              `ScheduleGroup '${scheduleGroupName}' already exists but could not be described`,
                            ),
                          ),
                    ),
                  ),
                ),
              );
            observed = yield* scheduler
              .getScheduleGroup({ Name: scheduleGroupName })
              .pipe(
                Effect.catchTag("ResourceNotFoundException", () =>
                  Effect.succeed(undefined),
                ),
              );
          }

          if (!observed?.Arn) {
            return yield* Effect.fail(
              new Error(
                `Failed to read created ScheduleGroup '${scheduleGroupName}'`,
              ),
            );
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
          };
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* scheduler
            .deleteScheduleGroup({
              Name: output.scheduleGroupName,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

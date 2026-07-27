import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import type { AutoScalingGroup as AutoScalingGroupResource } from "./AutoScalingGroup.ts";

export type ScheduledActionName = string;

export interface ScheduledActionProps {
  /**
   * Scheduled action name. If omitted, a deterministic name is generated.
   */
  scheduledActionName?: string;
  /**
   * Auto Scaling Group whose capacity the action changes.
   */
  autoScalingGroup: Input<string> | AutoScalingGroupResource;
  /**
   * Cron expression describing a recurring schedule (e.g. `"0 9 * * MON-FRI"`).
   * Omit for a one-time action scheduled via `startTime`.
   */
  recurrence?: string;
  /**
   * ISO-8601 timestamp the action first runs (recurring) or the single time it
   * runs (one-time). Must be in the future.
   */
  startTime?: string;
  /**
   * ISO-8601 timestamp after which the recurring action stops running.
   */
  endTime?: string;
  /**
   * IANA time zone the `recurrence` is evaluated in (e.g. `"America/New_York"`).
   */
  timeZone?: string;
  /**
   * Minimum group size to set when the action runs.
   */
  minSize?: number;
  /**
   * Maximum group size to set when the action runs.
   */
  maxSize?: number;
  /**
   * Desired capacity to set when the action runs.
   */
  desiredCapacity?: number;
}

export interface ScheduledAction extends Resource<
  "AWS.AutoScaling.ScheduledAction",
  ScheduledActionProps,
  {
    /**
     * Name of the scheduled action.
     */
    scheduledActionName: ScheduledActionName;
    /**
     * ARN of the scheduled action.
     */
    scheduledActionARN: string;
    /**
     * Name of the Auto Scaling Group the action applies to.
     */
    autoScalingGroupName: string;
    /**
     * Cron expression for recurring actions.
     */
    recurrence?: string;
    /**
     * ISO-8601 time the action first fires.
     */
    startTime?: string;
    /**
     * ISO-8601 time after which the recurrence stops.
     */
    endTime?: string;
    /**
     * IANA timezone the recurrence is evaluated in.
     */
    timeZone?: string;
    /**
     * Minimum group size applied when the action fires.
     */
    minSize?: number;
    /**
     * Maximum group size applied when the action fires.
     */
    maxSize?: number;
    /**
     * Desired capacity applied when the action fires.
     */
    desiredCapacity?: number;
  },
  never,
  Providers
> {}

/**
 * A scheduled scaling action that changes an Auto Scaling Group's capacity on a
 * recurring cron schedule or at a single future time.
 *
 * @section Creating a Scheduled Action
 * @example Scale up every weekday morning
 * ```typescript
 * const action = yield* ScheduledAction("MorningScaleUp", {
 *   autoScalingGroup: group,
 *   recurrence: "0 9 * * MON-FRI",
 *   timeZone: "America/New_York",
 *   minSize: 2,
 *   maxSize: 10,
 *   desiredCapacity: 4,
 * });
 * ```
 *
 * @example One-time capacity change
 * ```typescript
 * const action = yield* ScheduledAction("BlackFriday", {
 *   autoScalingGroup: group,
 *   startTime: "2026-11-27T00:00:00Z",
 *   desiredCapacity: 20,
 * });
 * ```
 *
 * @resource
 */
export const ScheduledAction = Resource<ScheduledAction>(
  "AWS.AutoScaling.ScheduledAction",
);

// A whole AutoScalingGroup resource resolves to its bare Attributes before
// reaching the provider — narrow on the attributes shape, never on `Type`.
const toAutoScalingGroupName = (
  input: ScheduledActionProps["autoScalingGroup"] | undefined,
): string | undefined =>
  typeof input === "string"
    ? input
    : typeof (input as { autoScalingGroupName?: unknown } | undefined)
          ?.autoScalingGroupName === "string"
      ? (input as unknown as { autoScalingGroupName: string })
          .autoScalingGroupName
      : undefined;

export const ScheduledActionProvider = () =>
  Provider.effect(
    ScheduledAction,
    Effect.gen(function* () {
      const toName = (
        id: string,
        props: { scheduledActionName?: string } = {},
      ) =>
        props.scheduledActionName
          ? Effect.succeed(props.scheduledActionName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      const describeAction = ({
        autoScalingGroupName,
        scheduledActionName,
      }: {
        autoScalingGroupName: string | undefined;
        scheduledActionName: string;
      }) =>
        autoscaling
          .describeScheduledActions({
            AutoScalingGroupName: autoScalingGroupName,
            ScheduledActionNames: [scheduledActionName],
          } as any)
          .pipe(
            Effect.map((result) => result.ScheduledUpdateGroupActions?.[0]),
            // A deleted/absent Auto Scaling Group surfaces as
            // `ValidationError: AutoScalingGroup ... not found` (typed
            // `AutoScalingGroupNotFound` via the auto-scaling patch); treat it
            // as "action gone" so refresh/read converge instead of failing.
            Effect.catchTag("AutoScalingGroupNotFound", () =>
              Effect.succeed(undefined),
            ),
          );

      const toAttributes = (
        action: autoscaling.ScheduledUpdateGroupAction,
      ): ScheduledAction["Attributes"] => ({
        scheduledActionName: action.ScheduledActionName!,
        scheduledActionARN: action.ScheduledActionARN!,
        autoScalingGroupName: action.AutoScalingGroupName!,
        recurrence: action.Recurrence,
        startTime: action.StartTime
          ? new Date(action.StartTime).toISOString()
          : undefined,
        endTime: action.EndTime
          ? new Date(action.EndTime).toISOString()
          : undefined,
        timeZone: action.TimeZone,
        minSize: action.MinSize,
        maxSize: action.MaxSize,
        desiredCapacity: action.DesiredCapacity,
      });

      return {
        stables: [
          "scheduledActionName",
          "scheduledActionARN",
          "autoScalingGroupName",
        ],
        // `describeScheduledActions` enumerates scheduled actions across every
        // Auto Scaling Group in the account/region when no AutoScalingGroupName
        // filter is supplied, so no parent enumeration is needed.
        list: () =>
          autoscaling.describeScheduledActions.pages({} as any).pipe(
            Stream.runCollect,
            Effect.map((chunk) =>
              Array.from(chunk).flatMap((page) =>
                (page.ScheduledUpdateGroupActions ?? []).map(toAttributes),
              ),
            ),
          ),
        diff: Effect.fn(function* ({ id, olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news ?? {});
          const oldGroup = toAutoScalingGroupName(olds.autoScalingGroup);
          const newGroup = toAutoScalingGroupName(news.autoScalingGroup);
          if (
            oldName !== newName ||
            (oldGroup !== undefined &&
              newGroup !== undefined &&
              oldGroup !== newGroup)
          ) {
            return { action: "replace" } as const;
          }

          if (!deepEqual(olds, news)) {
            return {
              action: "update",
              stables: [
                "scheduledActionName",
                "scheduledActionARN",
                "autoScalingGroupName",
              ],
            } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const autoScalingGroupName =
            output?.autoScalingGroupName ??
            toAutoScalingGroupName(olds?.autoScalingGroup);
          const scheduledActionName =
            output?.scheduledActionName ?? (yield* toName(id, olds ?? {}));
          const action = yield* describeAction({
            autoScalingGroupName,
            scheduledActionName,
          });
          return action ? toAttributes(action) : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const autoScalingGroupName =
            output?.autoScalingGroupName ??
            toAutoScalingGroupName(news.autoScalingGroup);
          if (!autoScalingGroupName) {
            return yield* Effect.die(
              new Error(
                "ScheduledAction requires a resolvable autoScalingGroup name",
              ),
            );
          }
          const scheduledActionName =
            output?.scheduledActionName ?? (yield* toName(id, news));

          // Ensure + Sync — `putScheduledUpdateGroupAction` is the single
          // create-or-update API. It overwrites the whole action, so we issue
          // it unconditionally (idempotent on matching params).
          yield* autoscaling.putScheduledUpdateGroupAction({
            AutoScalingGroupName: autoScalingGroupName,
            ScheduledActionName: scheduledActionName,
            Recurrence: news.recurrence,
            StartTime: news.startTime ? new Date(news.startTime) : undefined,
            EndTime: news.endTime ? new Date(news.endTime) : undefined,
            TimeZone: news.timeZone,
            MinSize: news.minSize,
            MaxSize: news.maxSize,
            DesiredCapacity: news.desiredCapacity,
          } as any);

          const action = yield* describeAction({
            autoScalingGroupName,
            scheduledActionName,
          }).pipe(
            Effect.flatMap((action) =>
              action
                ? Effect.succeed(action)
                : Effect.fail(
                    new Error(
                      `Scheduled action '${scheduledActionName}' was not readable after reconcile`,
                    ),
                  ),
            ),
          );
          yield* session.note(scheduledActionName);
          return toAttributes(action);
        }),
        delete: Effect.fn(function* ({ output }) {
          // `deleteScheduledAction` is idempotent — a missing action returns
          // success. Retry only the transient contention fault.
          yield* autoscaling
            .deleteScheduledAction({
              AutoScalingGroupName: output.autoScalingGroupName,
              ScheduledActionName: output.scheduledActionName,
            } as any)
            .pipe(
              Effect.retry({
                while: (error) => error._tag === "ResourceContentionFault",
                schedule: Schedule.max([
                  Schedule.recurs(5),
                  Schedule.exponential("250 millis"),
                ]),
              }),
            );
        }),
      };
    }),
  );

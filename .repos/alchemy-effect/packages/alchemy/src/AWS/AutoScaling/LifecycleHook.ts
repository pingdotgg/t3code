import * as autoscaling from "@distilled.cloud/aws/auto-scaling";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schedule from "effect/Schedule";
import { deepEqual, isResolved } from "../../Diff.ts";
import type { Input } from "../../Input.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { toSeconds } from "../../Util/Duration.ts";
import type { Providers } from "../Providers.ts";
import type { AutoScalingGroup as AutoScalingGroupResource } from "./AutoScalingGroup.ts";

export type LifecycleHookName = string;

/**
 * Lifecycle transition the hook fires on. The friendly `LAUNCHING` /
 * `TERMINATING` aliases map to the `autoscaling:EC2_INSTANCE_*` transition
 * strings the API expects.
 */
export type LifecycleTransition =
  | "LAUNCHING"
  | "TERMINATING"
  | "autoscaling:EC2_INSTANCE_LAUNCHING"
  | "autoscaling:EC2_INSTANCE_TERMINATING";

export type LifecycleActionResult = "CONTINUE" | "ABANDON";

export const normalizeTransition = (transition: LifecycleTransition): string =>
  transition === "LAUNCHING"
    ? "autoscaling:EC2_INSTANCE_LAUNCHING"
    : transition === "TERMINATING"
      ? "autoscaling:EC2_INSTANCE_TERMINATING"
      : transition;

export interface LifecycleHookProps {
  /**
   * Lifecycle hook name. If omitted, a deterministic name is generated.
   */
  lifecycleHookName?: string;
  /**
   * Auto Scaling Group to attach the hook to.
   */
  autoScalingGroup: Input<string> | AutoScalingGroupResource;
  /**
   * Instance state transition the hook pauses on. Use `LAUNCHING` to drain
   * before an instance enters service, `TERMINATING` to drain before it is
   * removed.
   */
  lifecycleTransition: LifecycleTransition;
  /**
   * Maximum time the instance stays in the wait state before the
   * `defaultResult` is applied, e.g. `"5 minutes"` or
   * `Duration.seconds(300)` (30 seconds–2 hours on the wire).
   * @default "1 hour"
   */
  heartbeatTimeout?: Duration.Input;
  /**
   * Action taken when the hook times out or the ASG is otherwise unable to
   * respond.
   * @default "ABANDON"
   */
  defaultResult?: LifecycleActionResult;
  /**
   * ARN of an SNS topic or SQS queue to notify when the transition occurs.
   * Omit to receive lifecycle events via EventBridge (the default target).
   */
  notificationTargetARN?: string;
  /**
   * ARN of the IAM role that permits the ASG to publish to
   * `notificationTargetARN`. Required when `notificationTargetARN` is set.
   */
  roleARN?: string;
  /**
   * Arbitrary metadata delivered with the lifecycle notification.
   */
  notificationMetadata?: string;
}

export interface LifecycleHook extends Resource<
  "AWS.AutoScaling.LifecycleHook",
  LifecycleHookProps,
  {
    /**
     * Name of the lifecycle hook.
     */
    lifecycleHookName: LifecycleHookName;
    /**
     * Name of the Auto Scaling Group the hook is attached to.
     */
    autoScalingGroupName: string;
    /**
     * The paused transition (e.g. `autoscaling:EC2_INSTANCE_LAUNCHING`).
     */
    lifecycleTransition: string;
    /**
     * Seconds an instance stays paused before `defaultResult` applies.
     */
    heartbeatTimeout: number;
    /**
     * Maximum total seconds an instance can remain in the wait state
     * (100x heartbeat, capped by AWS).
     */
    globalTimeout: number;
    /**
     * Action taken when the hook times out (`CONTINUE` or `ABANDON`).
     */
    defaultResult: string;
    /**
     * SNS/SQS target lifecycle notifications are published to, if any.
     */
    notificationTargetARN?: string;
    /**
     * IAM role used to publish to the notification target, if any.
     */
    roleARN?: string;
    /**
     * Metadata delivered with each lifecycle event.
     */
    notificationMetadata?: string;
  },
  never,
  Providers
> {}

/**
 * A lifecycle hook that pauses an Auto Scaling instance in a wait state on
 * launch or termination so a handler can drain connections, snapshot state, or
 * warm caches before the transition completes. Pair with
 * {@link consumeLifecycleActions} to receive the transition events and
 * {@link CompleteLifecycleAction} to signal `CONTINUE` / `ABANDON`.
 *
 * @section Creating a Lifecycle Hook
 * @example Drain before termination (EventBridge target)
 * ```typescript
 * const hook = yield* LifecycleHook("Drain", {
 *   autoScalingGroup: group,
 *   lifecycleTransition: "TERMINATING",
 *   heartbeatTimeout: "300 seconds",
 *   defaultResult: "CONTINUE",
 * });
 * ```
 *
 * @example Warm caches before an instance enters service
 * ```typescript
 * const hook = yield* LifecycleHook("Warm", {
 *   autoScalingGroup: group,
 *   lifecycleTransition: "LAUNCHING",
 *   heartbeatTimeout: "2 minutes",
 * });
 * ```
 *
 * @resource
 */
export const LifecycleHook = Resource<LifecycleHook>(
  "AWS.AutoScaling.LifecycleHook",
);

// Derive the group name from either spelling of `autoScalingGroup`. A whole
// AutoScalingGroup resource resolves to its bare Attributes before reaching the
// provider — the resource `Type` marker does not survive resolution — so narrow
// on the attributes shape, never on `Type`.
const toAutoScalingGroupName = (
  input: LifecycleHookProps["autoScalingGroup"] | undefined,
): string | undefined =>
  typeof input === "string"
    ? input
    : typeof (input as { autoScalingGroupName?: unknown } | undefined)
          ?.autoScalingGroupName === "string"
      ? (input as unknown as { autoScalingGroupName: string })
          .autoScalingGroupName
      : undefined;

export const LifecycleHookProvider = () =>
  Provider.effect(
    LifecycleHook,
    Effect.gen(function* () {
      const toName = (
        id: string,
        props: { lifecycleHookName?: string } = {},
      ) =>
        props.lifecycleHookName
          ? Effect.succeed(props.lifecycleHookName)
          : createPhysicalName({ id, maxLength: 255, lowercase: true });

      const describeHook = ({
        autoScalingGroupName,
        lifecycleHookName,
      }: {
        autoScalingGroupName: string;
        lifecycleHookName: string;
      }) =>
        autoscaling
          .describeLifecycleHooks({
            AutoScalingGroupName: autoScalingGroupName,
            LifecycleHookNames: [lifecycleHookName],
          } as any)
          .pipe(
            Effect.map((result) => result.LifecycleHooks?.[0]),
            // A deleted/absent Auto Scaling Group surfaces as
            // `ValidationError: AutoScalingGroup ... not found` (typed
            // `AutoScalingGroupNotFound` via the auto-scaling patch); treat it
            // as "hook gone" so refresh/read converge instead of failing.
            Effect.catchTag("AutoScalingGroupNotFound", () =>
              Effect.succeed(undefined),
            ),
          );

      const toAttributes = (
        hook: autoscaling.LifecycleHook,
      ): LifecycleHook["Attributes"] => ({
        lifecycleHookName: hook.LifecycleHookName!,
        autoScalingGroupName: hook.AutoScalingGroupName!,
        lifecycleTransition: hook.LifecycleTransition!,
        heartbeatTimeout: hook.HeartbeatTimeout ?? 0,
        globalTimeout: hook.GlobalTimeout ?? 0,
        defaultResult: hook.DefaultResult ?? "ABANDON",
        notificationTargetARN: hook.NotificationTargetARN,
        roleARN: hook.RoleARN,
        notificationMetadata: hook.NotificationMetadata,
      });

      return {
        stables: ["lifecycleHookName", "autoScalingGroupName"],
        // A lifecycle hook is a sub-resource of its Auto Scaling Group;
        // `describeLifecycleHooks` requires an AutoScalingGroupName and cannot
        // enumerate account-wide, so there is no parent-free listing.
        list: () => Effect.succeed([]),
        diff: Effect.fn(function* ({ id, olds, news: _news }) {
          if (!isResolved(_news)) return undefined;
          const news = _news as typeof olds;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news ?? {});
          const oldGroup = toAutoScalingGroupName(olds.autoScalingGroup);
          const newGroup = toAutoScalingGroupName(news.autoScalingGroup);
          // Hook name or ASG change → replace (identity fields). Both sides must
          // be known before forcing a replacement; a half-created row may have
          // lost an Output-valued `autoScalingGroup`.
          if (
            oldName !== newName ||
            (oldGroup !== undefined &&
              newGroup !== undefined &&
              oldGroup !== newGroup)
          ) {
            return { action: "replace", deleteFirst: true } as const;
          }

          if (!deepEqual(olds, news)) {
            return {
              action: "update",
              stables: ["lifecycleHookName", "autoScalingGroupName"],
            } as const;
          }
        }),
        read: Effect.fn(function* ({ id, olds, output }) {
          const autoScalingGroupName =
            output?.autoScalingGroupName ??
            toAutoScalingGroupName(olds?.autoScalingGroup);
          const lifecycleHookName =
            output?.lifecycleHookName ?? (yield* toName(id, olds ?? {}));
          if (!autoScalingGroupName) return undefined;
          const hook = yield* describeHook({
            autoScalingGroupName,
            lifecycleHookName,
          });
          return hook ? toAttributes(hook) : undefined;
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          const autoScalingGroupName =
            output?.autoScalingGroupName ??
            toAutoScalingGroupName(news.autoScalingGroup);
          if (!autoScalingGroupName) {
            return yield* Effect.die(
              new Error(
                "LifecycleHook requires a resolvable autoScalingGroup name",
              ),
            );
          }
          const lifecycleHookName =
            output?.lifecycleHookName ?? (yield* toName(id, news));

          // Ensure + Sync — `putLifecycleHook` is the single create-or-update
          // API. It overwrites the whole hook configuration, so we issue it
          // unconditionally (idempotent on matching params).
          yield* autoscaling.putLifecycleHook({
            LifecycleHookName: lifecycleHookName,
            AutoScalingGroupName: autoScalingGroupName,
            LifecycleTransition: normalizeTransition(news.lifecycleTransition),
            HeartbeatTimeout: toSeconds(news.heartbeatTimeout),
            DefaultResult: news.defaultResult,
            NotificationTargetARN: news.notificationTargetARN,
            RoleARN: news.roleARN,
            NotificationMetadata: news.notificationMetadata,
          } as any);

          const hook = yield* describeHook({
            autoScalingGroupName,
            lifecycleHookName,
          }).pipe(
            Effect.flatMap((hook) =>
              hook
                ? Effect.succeed(hook)
                : Effect.fail(
                    new Error(
                      `Lifecycle hook '${lifecycleHookName}' was not readable after reconcile`,
                    ),
                  ),
            ),
          );
          yield* session.note(lifecycleHookName);
          return toAttributes(hook);
        }),
        delete: Effect.fn(function* ({ output }) {
          // `deleteLifecycleHook` is idempotent — a missing hook returns
          // success. Retry only the transient contention fault.
          yield* autoscaling
            .deleteLifecycleHook({
              AutoScalingGroupName: output.autoScalingGroupName,
              LifecycleHookName: output.lifecycleHookName,
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

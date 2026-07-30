import * as aas from "@distilled.cloud/aws/application-auto-scaling";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import type { Providers } from "../Providers.ts";
import { SERVICE_NAMESPACES, retryWhileTargetPropagates } from "./internal.ts";

export interface ScheduledActionProps {
  /**
   * Scheduled action name. If omitted, a deterministic name is generated.
   *
   * Changing this triggers a replacement.
   */
  scheduledActionName?: string;
  /**
   * The namespace of the AWS service that provides the scalable target,
   * e.g. `ecs`, `dynamodb`.
   *
   * Changing this triggers a replacement.
   */
  serviceNamespace: aas.ServiceNamespace;
  /**
   * The identifier of the resource the action's scalable target scales,
   * e.g. `service/{clusterName}/{serviceName}` or `table/{tableName}`.
   *
   * Changing this triggers a replacement.
   */
  resourceId: string;
  /**
   * The scalable dimension of the scalable target,
   * e.g. `ecs:service:DesiredCount` or `dynamodb:table:ReadCapacityUnits`.
   *
   * Changing this triggers a replacement.
   */
  scalableDimension: aas.ScalableDimension;
  /**
   * The schedule expression: `at(yyyy-mm-ddThh:mm:ss)` for one-time actions,
   * `rate(value unit)` or `cron(fields)` for recurring actions.
   */
  schedule: string;
  /**
   * Time zone for the schedule expression (IANA name, e.g.
   * `America/Los_Angeles`).
   * @default "UTC"
   */
  timezone?: string;
  /**
   * ISO-8601 date-time at which a recurring schedule begins.
   */
  startTime?: string;
  /**
   * ISO-8601 date-time at which a recurring schedule ends.
   */
  endTime?: string;
  /**
   * The new minimum and/or maximum capacity applied when the action runs.
   */
  scalableTargetAction: aas.ScalableTargetAction;
}

export interface ScheduledAction extends Resource<
  "AWS.ApplicationAutoScaling.ScheduledAction",
  ScheduledActionProps,
  {
    /**
     * Name of the scheduled action.
     */
    scheduledActionName: string;
    /**
     * ARN of the scheduled action.
     */
    scheduledActionArn: string;
    /**
     * Namespace of the AWS service that provides the scalable target.
     */
    serviceNamespace: aas.ServiceNamespace;
    /**
     * Identifier of the scaled resource.
     */
    resourceId: string;
    /**
     * Scalable dimension the action applies to.
     */
    scalableDimension: aas.ScalableDimension;
    /**
     * Schedule expression (`at(...)`, `rate(...)`, or `cron(...)`).
     */
    schedule: string;
    /**
     * IANA timezone the schedule is evaluated in.
     */
    timezone: string | undefined;
    /**
     * Capacity bounds applied when the action fires.
     */
    scalableTargetAction: aas.ScalableTargetAction | undefined;
  },
  never,
  Providers
> {}

/**
 * An Application Auto Scaling scheduled action — adjusts a scalable target's
 * minimum and/or maximum capacity on a one-time (`at(...)`) or recurring
 * (`cron(...)` / `rate(...)`) schedule.
 *
 * The action applies to the scalable target identified by the
 * (`serviceNamespace`, `resourceId`, `scalableDimension`) triple, which must
 * be registered (see {@link ScalableTarget}) before the action is created —
 * pass the target's outputs so deployment orders correctly.
 * @resource
 * @section Scheduling Capacity Changes
 * @example Scale Out for Business Hours
 * ```typescript
 * yield* ScheduledAction("BusinessHoursScaleOut", {
 *   serviceNamespace: target.serviceNamespace,
 *   resourceId: target.resourceId,
 *   scalableDimension: target.scalableDimension,
 *   schedule: "cron(0 8 ? * MON-FRI *)",
 *   timezone: "America/Los_Angeles",
 *   scalableTargetAction: { MinCapacity: 3, MaxCapacity: 10 },
 * });
 * ```
 *
 * @example One-Time Capacity Bump
 * ```typescript
 * yield* ScheduledAction("LaunchDayBump", {
 *   serviceNamespace: target.serviceNamespace,
 *   resourceId: target.resourceId,
 *   scalableDimension: target.scalableDimension,
 *   schedule: "at(2030-01-01T00:00:00)",
 *   scalableTargetAction: { MinCapacity: 5 },
 * });
 * ```
 */
export const ScheduledAction = Resource<ScheduledAction>(
  "AWS.ApplicationAutoScaling.ScheduledAction",
);

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
          : createPhysicalName({ id, maxLength: 255 });

      const describe = (props: {
        serviceNamespace: aas.ServiceNamespace;
        scheduledActionName: string;
        resourceId?: string;
        scalableDimension?: aas.ScalableDimension;
      }) =>
        aas
          .describeScheduledActions({
            ServiceNamespace: props.serviceNamespace,
            ScheduledActionNames: [props.scheduledActionName],
            ResourceId: props.resourceId,
            ScalableDimension: props.scalableDimension,
          })
          .pipe(
            Effect.map((res) =>
              res.ScheduledActions?.find(
                (a) => a.ScheduledActionName === props.scheduledActionName,
              ),
            ),
          );

      const toAttributes = (
        action: aas.ScheduledAction,
      ): ScheduledAction["Attributes"] => ({
        scheduledActionName: action.ScheduledActionName,
        scheduledActionArn: action.ScheduledActionARN,
        serviceNamespace: action.ServiceNamespace,
        resourceId: action.ResourceId,
        scalableDimension: action.ScalableDimension ?? "",
        schedule: action.Schedule,
        timezone: action.Timezone,
        scalableTargetAction: action.ScalableTargetAction,
      });

      return {
        stables: [
          "scheduledActionName",
          "scheduledActionArn",
          "serviceNamespace",
          "resourceId",
          "scalableDimension",
        ],

        // Account/region-wide enumeration; the describe API requires a
        // `ServiceNamespace` filter, so union the per-namespace pages.
        list: () =>
          Effect.forEach(
            SERVICE_NAMESPACES,
            (namespace) =>
              aas.describeScheduledActions
                .pages({ ServiceNamespace: namespace })
                .pipe(
                  Stream.runCollect,
                  Effect.map((chunk) =>
                    Array.from(chunk).flatMap((page) =>
                      (page.ScheduledActions ?? []).map(toAttributes),
                    ),
                  ),
                ),
            { concurrency: 4 },
          ).pipe(Effect.map((groups) => groups.flat())),

        diff: Effect.fn(function* ({ id, news, olds }) {
          if (!isResolved(news)) return undefined;
          const oldName = yield* toName(id, olds ?? {});
          const newName = yield* toName(id, news);
          if (oldName !== newName) {
            return { action: "replace" } as const;
          }
          // The target triple pins the action to a scalable target — any
          // change replaces the action. Only compare sides that are known:
          // a half-created state row may have lost Output-valued props.
          for (const key of [
            "serviceNamespace",
            "resourceId",
            "scalableDimension",
          ] as const) {
            const oldValue = olds?.[key];
            if (
              oldValue !== undefined &&
              isResolved(oldValue) &&
              oldValue !== news[key]
            ) {
              return { action: "replace" } as const;
            }
          }
        }),

        read: Effect.fn(function* ({ id, olds, output }) {
          const serviceNamespace =
            output?.serviceNamespace ?? olds?.serviceNamespace;
          if (serviceNamespace === undefined) return undefined;
          const scheduledActionName =
            output?.scheduledActionName ?? (yield* toName(id, olds ?? {}));
          const action = yield* describe({
            serviceNamespace,
            scheduledActionName,
            resourceId: output?.resourceId ?? olds?.resourceId,
            scalableDimension:
              output?.scalableDimension ?? olds?.scalableDimension,
          });
          return action ? toAttributes(action) : undefined;
        }),

        reconcile: Effect.fn(function* ({ id, news, session }) {
          const scheduledActionName = yield* toName(id, news);

          // Ensure + sync — `putScheduledAction` is the single
          // create-or-update API, keyed by (name, target triple). Note the
          // AWS semantics: unspecified StartTime/EndTime are *deleted* on
          // update, which matches declarative convergence exactly. A put
          // issued immediately after the target registers can race its
          // propagation — retry the typed ObjectNotFoundException briefly.
          yield* retryWhileTargetPropagates(
            aas.putScheduledAction({
              ScheduledActionName: scheduledActionName,
              ServiceNamespace: news.serviceNamespace,
              ResourceId: news.resourceId,
              ScalableDimension: news.scalableDimension,
              Schedule: news.schedule,
              Timezone: news.timezone,
              StartTime:
                news.startTime !== undefined
                  ? new Date(news.startTime)
                  : undefined,
              EndTime:
                news.endTime !== undefined ? new Date(news.endTime) : undefined,
              ScalableTargetAction: news.scalableTargetAction,
            }),
          );

          // Observe final state so attributes carry the generated ARN.
          const action = yield* describe({
            serviceNamespace: news.serviceNamespace,
            scheduledActionName,
            resourceId: news.resourceId,
            scalableDimension: news.scalableDimension,
          });
          if (action === undefined) {
            return yield* Effect.fail(
              new aas.ObjectNotFoundException({
                Message: `Scheduled action '${scheduledActionName}' was not readable after PutScheduledAction`,
              }),
            );
          }

          yield* session.note(action.ScheduledActionARN);
          return toAttributes(action);
        }),

        // Deleting the parent scalable target implicitly deletes its
        // scheduled actions, so an action that is already gone (typed
        // `ObjectNotFoundException`) is success.
        delete: Effect.fn(function* ({ output }) {
          yield* aas
            .deleteScheduledAction({
              ScheduledActionName: output.scheduledActionName,
              ServiceNamespace: output.serviceNamespace,
              ResourceId: output.resourceId,
              ScalableDimension: output.scalableDimension,
            })
            .pipe(
              Effect.catchTag("ObjectNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

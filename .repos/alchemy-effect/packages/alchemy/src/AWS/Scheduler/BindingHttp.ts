/**
 * Shared scaffolding for EventBridge Scheduler HTTP bindings.
 *
 * NOT exported from `index.ts` — every thin `{Op}Http.ts` in this service is
 * a `Layer.effect(Cap, make…HttpBinding({ … }))` over one of the builders
 * below. Everything except the operation and the IAM action list is
 * boilerplate:
 *
 * - **Group-scoped operations** (`scheduler:GetSchedule`,
 *   `scheduler:DeleteSchedule`, `scheduler:ListSchedules`) inject the bound
 *   {@link ScheduleGroup}'s name as the request's `GroupName` and are granted
 *   on the group's schedule ARN pattern. Dynamic schedules are named at
 *   runtime, so the resource pattern is group-scoped rather than an exact
 *   ARN: the group (or the default group) is the least-privilege boundary.
 * - **Write operations** (`scheduler:CreateSchedule`,
 *   `scheduler:UpdateSchedule`) additionally take the schedule **execution
 *   role** (the IAM role EventBridge Scheduler assumes to invoke the target)
 *   and contribute `iam:PassRole` on it — without the PassRole statement the
 *   write fails only at runtime. The bound role is injected as the target's
 *   `RoleArn` unless the request overrides it, and `FlexibleTimeWindow`
 *   defaults to `{ Mode: "OFF" }`.
 */
import type * as scheduler from "@distilled.cloud/aws/scheduler";
import * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import * as Output from "../../Output.ts";
import { AWSEnvironment } from "../Environment.ts";
import type { Role } from "../IAM/Role.ts";
import { isBindingHost } from "../Lambda/Function.ts";
import type { ScheduleGroup } from "./ScheduleGroup.ts";

/**
 * Resolve the group-scoped schedule ARN pattern the binding is granted on.
 * Passes unresolved Outputs — binding data is resolved by the engine before
 * the host reconciles.
 */
const scheduleArnPattern = Effect.fn(function* (
  group: ScheduleGroup | undefined,
) {
  const { accountId, region } =
    yield* AWSEnvironment.current as unknown as Effect.Effect<{
      accountId: string;
      region: string;
    }>;
  return group
    ? Output.interpolate`arn:aws:scheduler:${region}:${accountId}:schedule/${group.scheduleGroupName}/*`
    : (`arn:aws:scheduler:${region}:${accountId}:schedule/default/*` as const);
});

/**
 * Account-wide schedule ARN pattern — the resource IAM evaluates
 * `scheduler:ListSchedules` against, regardless of any `GroupName` filter in
 * the request.
 */
const allSchedulesArnPattern = Effect.gen(function* () {
  const { accountId, region } =
    yield* AWSEnvironment.current as unknown as Effect.Effect<{
      accountId: string;
      region: string;
    }>;
  return `arn:aws:scheduler:${region}:${accountId}:schedule/*/*` as const;
});

/**
 * Build the impl Effect for a group-scoped Scheduler operation: the
 * deploy-time half grants `actions` on the group's schedule ARN pattern, and
 * the runtime half injects the group's name as the request's `GroupName`.
 */
export const makeScheduleGroupScopedHttpBinding = <
  I extends { GroupName?: string },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Scheduler.GetSchedule`. */
  tag: string;
  /** The distilled operation; `GroupName` is injected from the bound group. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the group's schedule ARN pattern. */
  actions: readonly string[];
  /**
   * `GroupName` injected when no group is bound. Get/Delete leave it
   * undefined (the API defaults to the `default` group); ListSchedules pins
   * `"default"` explicitly because an absent `GroupName` there means "all
   * groups".
   */
  fallbackGroupName?: string;
  /**
   * IAM resource scope. `"group"` (default) grants on the bound group's
   * `schedule/{group}/*` pattern. `"all"` grants on `schedule/*​/*` —
   * required for `scheduler:ListSchedules`, which IAM evaluates against the
   * account-wide schedule pattern regardless of the request's `GroupName`
   * filter (AccessDenied cites `schedule/*​/*`).
   */
  resourceScope?: "group" | "all";
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* (group?: ScheduleGroup) {
      const GroupName = group ? yield* group.scheduleGroupName : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const pattern =
            options.resourceScope === "all"
              ? yield* allSchedulesArnPattern
              : yield* scheduleArnPattern(group);
          yield* host.bind`Allow(${host}, ${options.tag}(${group ?? "default"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: [pattern],
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${group?.LogicalId ?? "default"})`)(
        function* (request?: Omit<I, "GroupName">) {
          const groupName = GroupName
            ? yield* GroupName
            : options.fallbackGroupName;
          return yield* op({
            ...request,
            GroupName: groupName,
          } as I);
        },
      );
    });
  });

/**
 * Build the impl Effect for a Scheduler write operation
 * (`CreateSchedule`/`UpdateSchedule`): constructed with the schedule
 * execution role (plus an optional scoping {@link ScheduleGroup}), the
 * deploy-time half grants `actions` on the group's schedule ARN pattern AND
 * `iam:PassRole` on the execution role; the runtime half injects the group's
 * name, defaults `FlexibleTimeWindow` to `{ Mode: "OFF" }`, and defaults the
 * target's `RoleArn` to the bound execution role.
 */
export const makeScheduleWriteHttpBinding = <
  I extends {
    GroupName?: string;
    Target: scheduler.Target;
    FlexibleTimeWindow: scheduler.FlexibleTimeWindow;
  },
  A,
  E,
  R,
>(options: {
  /** Fully-qualified binding tag, e.g. `AWS.Scheduler.CreateSchedule`. */
  tag: string;
  /** The distilled operation; group, time window, and role are injected. */
  operation: Effect.Effect<(input: I) => Effect.Effect<A, E>, never, R>;
  /** IAM actions granted on the group's schedule ARN pattern. */
  actions: readonly string[];
}) =>
  Effect.gen(function* () {
    const op = yield* options.operation;

    return Effect.fn(function* <Ro extends Role>(
      executionRole: Ro,
      group?: ScheduleGroup,
    ) {
      const RoleArn = yield* executionRole.roleArn;
      const GroupName = group ? yield* group.scheduleGroupName : undefined;
      if (!globalThis.__ALCHEMY_RUNTIME__) {
        const host = yield* Binding.Host;
        if (isBindingHost(host)) {
          const pattern = yield* scheduleArnPattern(group);
          yield* host.bind`Allow(${host}, ${options.tag}(${executionRole}, ${group ?? "default"}))`(
            {
              policyStatements: [
                {
                  Effect: "Allow",
                  Action: [...options.actions],
                  Resource: [pattern],
                },
                // CRITICAL: without iam:PassRole on the execution role, the
                // write fails only at runtime with an AccessDenied.
                {
                  Effect: "Allow",
                  Action: ["iam:PassRole"],
                  Resource: [Output.interpolate`${executionRole.roleArn}`],
                  Condition: {
                    StringEquals: {
                      "iam:PassedToService": "scheduler.amazonaws.com",
                    },
                  },
                },
              ],
            },
          );
        }
      }
      return Effect.fn(`${options.tag}(${executionRole.LogicalId})`)(function* (
        request: Omit<I, "GroupName" | "Target" | "FlexibleTimeWindow"> & {
          Target: Omit<scheduler.Target, "RoleArn"> & { RoleArn?: string };
          FlexibleTimeWindow?: scheduler.FlexibleTimeWindow;
        },
      ) {
        const roleArn = yield* RoleArn;
        const groupName = GroupName ? yield* GroupName : undefined;
        return yield* op({
          ...request,
          GroupName: groupName,
          FlexibleTimeWindow: request.FlexibleTimeWindow ?? { Mode: "OFF" },
          Target: {
            ...request.Target,
            RoleArn: request.Target.RoleArn ?? roleArn,
          },
        } as I);
      });
    });
  });

import * as deadline from "@distilled.cloud/aws/deadline";
import * as Effect from "effect/Effect";
import * as EffectStream from "effect/Stream";
import { Unowned } from "../../AdoptPolicy.ts";
import { isResolved } from "../../Diff.ts";
import { createPhysicalName } from "../../PhysicalName.ts";
import * as Provider from "../../Provider.ts";
import { Resource } from "../../Resource.ts";
import { createInternalTags, hasAlchemyTags, type Tags } from "../../Tags.ts";
import type { Providers } from "../Providers.ts";
import {
  asPlain,
  deadlineArnOf,
  fetchDeadlineTags,
  retryWhileFarmSettling,
  syncDeadlineTags,
} from "./internal.ts";

export type BudgetStatus = deadline.BudgetStatus;
export type BudgetActionType = deadline.BudgetActionType;

export interface BudgetActionProps {
  /**
   * Action taken when the threshold is crossed
   * (`STOP_SCHEDULING_AND_COMPLETE_TASKS` or
   * `STOP_SCHEDULING_AND_CANCEL_TASKS`).
   */
  type: BudgetActionType;
  /**
   * Percentage of the dollar limit at which the action fires (e.g. `100`).
   */
  thresholdPercentage: number;
  /**
   * A description of the action.
   */
  description?: string;
}

export interface BudgetScheduleProps {
  /**
   * Fixed budget window.
   */
  fixed: {
    /**
     * ISO-8601 start of the budget window (e.g. `2026-01-01T00:00:00Z`).
     */
    startTime: string;
    /**
     * ISO-8601 end of the budget window.
     */
    endTime: string;
  };
}

export interface BudgetProps {
  /**
   * The identifier of the farm the budget belongs to. Changing it replaces
   * the budget.
   */
  farmId: string;
  /**
   * The identifier of the queue whose usage the budget tracks. Changing it
   * replaces the budget.
   */
  queueId: string;
  /**
   * Display name of the budget.
   * @default ${app}-${stage}-${id}
   */
  displayName?: string;
  /**
   * A description of the budget.
   */
  description?: string;
  /**
   * Approximate dollar limit of the budget.
   */
  approximateDollarLimit: number;
  /**
   * Threshold actions taken as usage approaches the limit.
   */
  actions: BudgetActionProps[];
  /**
   * The period the budget is measured over.
   */
  schedule: BudgetScheduleProps;
  /**
   * Whether the budget is evaluated (`ACTIVE`) or ignored (`INACTIVE`).
   * @default "ACTIVE"
   */
  status?: BudgetStatus;
  /**
   * Tags to associate with the budget.
   */
  tags?: Record<string, string>;
}

export interface Budget extends Resource<
  "AWS.Deadline.Budget",
  BudgetProps,
  {
    /**
     * The identifier of the farm the budget belongs to.
     */
    farmId: string;
    /**
     * Service-assigned unique identifier of the budget (`budget-...`).
     */
    budgetId: string;
    /**
     * ARN of the budget.
     */
    budgetArn: string;
    /**
     * The identifier of the queue whose usage the budget tracks.
     */
    queueId: string;
    /**
     * The budget's display name.
     */
    displayName: string;
    /**
     * Whether the budget is currently evaluated.
     */
    status: BudgetStatus;
    /**
     * The configured approximate dollar limit.
     */
    approximateDollarLimit: number;
    /**
     * Current tags reported for the budget.
     */
    tags: Record<string, string>;
  },
  never,
  Providers
> {}

/**
 * An AWS Deadline Cloud budget — tracks a queue's approximate render spend
 * over a fixed window and stops scheduling when thresholds are crossed.
 *
 * @resource
 * @section Creating Budgets
 * @example Queue Budget with Hard Stop
 * ```typescript
 * import * as AWS from "alchemy/AWS";
 *
 * const budget = yield* AWS.Deadline.Budget("MonthlyBudget", {
 *   farmId: farm.farmId,
 *   queueId: queue.queueId,
 *   approximateDollarLimit: 100,
 *   actions: [
 *     { type: "STOP_SCHEDULING_AND_COMPLETE_TASKS", thresholdPercentage: 100 },
 *   ],
 *   schedule: {
 *     fixed: {
 *       startTime: "2026-01-01T00:00:00Z",
 *       endTime: "2027-01-01T00:00:00Z",
 *     },
 *   },
 * });
 * ```
 *
 * @example Graduated Thresholds
 * ```typescript
 * // Let in-flight tasks finish at 90%, cancel everything at 100%.
 * const budget = yield* AWS.Deadline.Budget("QueueBudget", {
 *   farmId: farm.farmId,
 *   queueId: queue.queueId,
 *   approximateDollarLimit: 500,
 *   actions: [
 *     { type: "STOP_SCHEDULING_AND_COMPLETE_TASKS", thresholdPercentage: 90 },
 *     { type: "STOP_SCHEDULING_AND_CANCEL_TASKS", thresholdPercentage: 100 },
 *   ],
 *   schedule: {
 *     fixed: {
 *       startTime: "2026-01-01T00:00:00Z",
 *       endTime: "2026-02-01T00:00:00Z",
 *     },
 *   },
 * });
 * ```
 */
export const Budget = Resource<Budget>("AWS.Deadline.Budget");

const createBudgetName = (
  id: string,
  props: { displayName?: string | undefined },
) =>
  props.displayName
    ? Effect.succeed(props.displayName)
    : createPhysicalName({ id, maxLength: 100 });

interface BudgetState {
  attrs: Budget["Attributes"];
  described: deadline.GetBudgetResponse;
}

const readBudgetById = Effect.fn(function* (
  farmId: string,
  budgetId: string,
  arnOf: (path: string) => string,
) {
  const described = yield* deadline
    .getBudget({ farmId, budgetId })
    .pipe(
      Effect.catchTag("ResourceNotFoundException", () =>
        Effect.succeed(undefined),
      ),
    );
  if (!described) return undefined;
  const budgetArn = arnOf(`farm/${farmId}/budget/${described.budgetId}`);
  const state: BudgetState = {
    described,
    attrs: {
      farmId,
      budgetId: described.budgetId,
      budgetArn,
      queueId: described.usageTrackingResource.queueId,
      displayName: described.displayName,
      status: described.status,
      approximateDollarLimit: described.approximateDollarLimit,
      tags: yield* fetchDeadlineTags(budgetArn),
    },
  };
  return state;
});

const findBudgetByDisplayName = Effect.fn(function* (
  farmId: string,
  displayName: string,
  arnOf: (path: string) => string,
) {
  const summaries = yield* deadline.listBudgets.items({ farmId }).pipe(
    EffectStream.runCollect,
    Effect.map((chunk) => Array.from(chunk)),
    // The parent farm may itself be gone.
    Effect.catchTag("ResourceNotFoundException", () =>
      Effect.succeed([] as deadline.BudgetSummary[]),
    ),
  );
  const match = summaries.find(
    (summary) => summary.displayName === displayName,
  );
  if (!match) return undefined;
  return yield* readBudgetById(farmId, match.budgetId, arnOf);
});

const actionKey = (action: {
  type: BudgetActionType;
  thresholdPercentage: number;
}) => `${action.type}@${action.thresholdPercentage}`;

const toWireSchedule = (
  schedule: BudgetScheduleProps,
): deadline.BudgetSchedule => ({
  fixed: {
    startTime: new Date(schedule.fixed.startTime),
    endTime: new Date(schedule.fixed.endTime),
  },
});

export const BudgetProvider = () =>
  Provider.effect(
    Budget,
    Effect.gen(function* () {
      return {
        stables: ["farmId", "budgetId", "budgetArn", "queueId"],
        // Keyed by a parent farm — sub-resource list() convention.
        list: () => Effect.succeed([]),
        read: Effect.fn(function* ({ id, olds, output }) {
          const arnOf = yield* deadlineArnOf;
          const farmId = output?.farmId ?? olds?.farmId;
          if (farmId === undefined) return undefined;
          const state = output?.budgetId
            ? yield* readBudgetById(farmId, output.budgetId, arnOf)
            : yield* findBudgetByDisplayName(
                farmId,
                yield* createBudgetName(id, olds ?? {}),
                arnOf,
              );
          if (!state) return undefined;
          return (yield* hasAlchemyTags(id, state.attrs.tags as Tags))
            ? state.attrs
            : Unowned(state.attrs);
        }),
        diff: Effect.fn(function* ({ news, olds }) {
          if (!isResolved(news)) return;
          if (olds === undefined) return;
          // The parent farm and tracked queue are fixed at creation.
          if (olds.farmId !== news.farmId || olds.queueId !== news.queueId) {
            return { action: "replace" } as const;
          }
        }),
        reconcile: Effect.fn(function* ({ id, news, output, session }) {
          if (news === undefined) {
            return yield* Effect.fail(
              new Error("AWS.Deadline.Budget requires props"),
            );
          }
          const arnOf = yield* deadlineArnOf;
          const farmId = news.farmId;
          const displayName = yield* createBudgetName(id, news);
          const internalTags = yield* createInternalTags(id);
          const desiredTags = { ...internalTags, ...news.tags };
          const desiredSchedule = toWireSchedule(news.schedule);

          // Observe.
          let state = output?.budgetId
            ? yield* readBudgetById(farmId, output.budgetId, arnOf)
            : yield* findBudgetByDisplayName(farmId, displayName, arnOf);

          // Ensure.
          if (state === undefined) {
            const created = yield* retryWhileFarmSettling(
              deadline.createBudget({
                farmId,
                displayName,
                description: news.description,
                usageTrackingResource: { queueId: news.queueId },
                approximateDollarLimit: news.approximateDollarLimit,
                actions: news.actions,
                schedule: desiredSchedule,
                tags: desiredTags,
              }),
            );
            yield* session.note(
              `Created budget ${displayName} (${created.budgetId})`,
            );
            state = yield* readBudgetById(farmId, created.budgetId, arnOf);
            if (state === undefined) {
              return yield* Effect.fail(
                new Error(`failed to read created budget ${displayName}`),
              );
            }
          }

          // Sync mutable settings — compute action/schedule deltas from
          // OBSERVED state.
          const described = state.described;
          const observedActions = described.actions.map((action) => ({
            type: action.type,
            thresholdPercentage: action.thresholdPercentage,
          }));
          const observedKeys = new Set(observedActions.map(actionKey));
          const desiredKeys = new Set(news.actions.map(actionKey));
          const actionsToAdd = news.actions.filter(
            (action) => !observedKeys.has(actionKey(action)),
          );
          const actionsToRemove = observedActions.filter(
            (action) => !desiredKeys.has(actionKey(action)),
          );
          const observedSchedule = described.schedule.fixed;
          // Deadline clamps a startTime in the past to the creation instant,
          // so a past desired startTime can never converge — only compare it
          // while it is still in the future.
          const now = yield* Effect.sync(() => Date.now());
          const desiredStart = desiredSchedule.fixed.startTime.getTime();
          const scheduleDrifted =
            (desiredStart > now &&
              observedSchedule.startTime.getTime() !== desiredStart) ||
            observedSchedule.endTime.getTime() !==
              desiredSchedule.fixed.endTime.getTime();
          const desiredStatus = news.status ?? described.status;
          const needsUpdate =
            displayName !== described.displayName ||
            (news.description !== undefined &&
              news.description !== (asPlain(described.description) ?? "")) ||
            desiredStatus !== described.status ||
            news.approximateDollarLimit !== described.approximateDollarLimit ||
            actionsToAdd.length > 0 ||
            actionsToRemove.length > 0 ||
            scheduleDrifted;
          if (needsUpdate) {
            yield* retryWhileFarmSettling(
              deadline.updateBudget({
                farmId,
                budgetId: state.attrs.budgetId,
                displayName,
                description: news.description,
                status: news.status,
                approximateDollarLimit: news.approximateDollarLimit,
                actionsToAdd:
                  actionsToAdd.length > 0 ? actionsToAdd : undefined,
                actionsToRemove:
                  actionsToRemove.length > 0 ? actionsToRemove : undefined,
                schedule: scheduleDrifted ? desiredSchedule : undefined,
              }),
            );
            yield* session.note(`Updated budget ${displayName}`);
          }

          // Sync tags — diff against observed cloud tags.
          yield* syncDeadlineTags(state.attrs.budgetArn, desiredTags);

          yield* session.note(state.attrs.budgetArn);
          const final = yield* readBudgetById(
            farmId,
            state.attrs.budgetId,
            arnOf,
          );
          if (!final) {
            return yield* Effect.fail(
              new Error(`failed to read reconciled budget ${displayName}`),
            );
          }
          return final.attrs;
        }),
        delete: Effect.fn(function* ({ output }) {
          yield* deadline
            .deleteBudget({
              farmId: output.farmId,
              budgetId: output.budgetId,
            })
            .pipe(
              Effect.catchTag("ResourceNotFoundException", () => Effect.void),
            );
        }),
      };
    }),
  );

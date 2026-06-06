import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import {
  AutomationRuleId,
  AutomationRunId,
  type AutomationsRulesUpdateInput,
  type AutomationRule,
  type AutomationRuleScheduleState,
  type AutomationRun,
} from "../shared/schema.ts";
import { markActiveRule, releaseActiveRule } from "./activeRules.ts";
import { AutomationPluginError } from "./errors.ts";
import { nextRunId, scheduledRunId } from "./ids.ts";
import type { AutomationCollections, makeAutomationRepositories } from "./repositories.ts";
import { computeNextRunAt, isMissedRun, validateFiveFieldCron } from "./schedule.ts";
import type { AutomationRunReason, PreparedRun, ScheduledRunPreparation } from "./runtimeTypes.ts";
import { nowIso } from "./time.ts";

type AutomationRepositories = ReturnType<typeof makeAutomationRepositories>;
interface RuleLockEntry {
  readonly semaphore: Semaphore.Semaphore;
  readonly references: number;
}

const acquireRuleLock = (
  locksRef: Ref.Ref<ReadonlyMap<AutomationRuleId, RuleLockEntry>>,
  ruleId: AutomationRuleId,
) =>
  Effect.gen(function* () {
    const semaphore = yield* Semaphore.make(1);
    return yield* Ref.modify(locksRef, (locks) => {
      const current = locks.get(ruleId);
      if (current) {
        const next = new Map(locks);
        next.set(ruleId, { ...current, references: current.references + 1 });
        return [current.semaphore, next] as const;
      }
      const next = new Map(locks);
      next.set(ruleId, { semaphore, references: 1 });
      return [semaphore, next] as const;
    });
  });

const releaseRuleLockReference = (
  locksRef: Ref.Ref<ReadonlyMap<AutomationRuleId, RuleLockEntry>>,
  ruleId: AutomationRuleId,
) =>
  Ref.update(locksRef, (locks) => {
    const current = locks.get(ruleId);
    if (!current) {
      return locks;
    }
    const next = new Map(locks);
    if (current.references <= 1) {
      next.delete(ruleId);
    } else {
      next.set(ruleId, { ...current, references: current.references - 1 });
    }
    return next;
  });

const withRuleScheduleState = (
  rule: AutomationRule,
  scheduleState: AutomationRuleScheduleState | undefined,
): AutomationRule => {
  const { scheduleState: _previousScheduleState, ...ruleWithoutScheduleState } = rule;
  return scheduleState === undefined
    ? ruleWithoutScheduleState
    : { ...ruleWithoutScheduleState, scheduleState };
};

const sameScheduleState = (
  left: AutomationRuleScheduleState | undefined,
  right: AutomationRuleScheduleState | undefined,
) =>
  left === undefined
    ? right === undefined
    : right !== undefined &&
      left.nextRunAt === right.nextRunAt &&
      left.updatedAt === right.updatedAt;

const validateRuleSchedule = (rule: AutomationRule) =>
  Effect.try({
    try: () => validateFiveFieldCron(rule.cron, rule.timezone),
    catch: (cause) =>
      cause instanceof AutomationPluginError
        ? cause
        : new AutomationPluginError({
            message: "Invalid automation schedule.",
            cause,
          }),
  });

const calculateNextRunAt = (rule: AutomationRule, afterIso: string) =>
  Effect.try({
    try: () =>
      computeNextRunAt({
        cron: rule.cron,
        timezone: rule.timezone,
        afterIso,
      }),
    catch: (cause) =>
      cause instanceof AutomationPluginError
        ? cause
        : new AutomationPluginError({
            message: "Failed to calculate next automation run.",
            cause,
          }),
  });

const buildRuleScheduleState = (rule: AutomationRule, afterIso = rule.updatedAt) =>
  Effect.gen(function* () {
    yield* validateRuleSchedule(rule);
    if (!rule.enabled) {
      return undefined;
    }
    const nextRunAt = yield* calculateNextRunAt(rule, afterIso);
    return {
      nextRunAt,
      updatedAt: rule.updatedAt,
    } satisfies AutomationRuleScheduleState;
  });

export function makeAutomationRunPreparation(input: {
  readonly collections: AutomationCollections;
  readonly activeRuleIds: Set<AutomationRuleId>;
  readonly repositories: AutomationRepositories;
}) {
  return Effect.gen(function* () {
    const ruleLocksRef = yield* Ref.make<ReadonlyMap<AutomationRuleId, RuleLockEntry>>(new Map());
    const { getRule, requireRule, listRunsForRule, writeRule, writeRun, writeRunAndTrimForRule } =
      input.repositories;

    const withRulePreparationLock = <A, E, R>(
      ruleId: AutomationRuleId,
      effect: Effect.Effect<A, E, R>,
    ) =>
      Effect.acquireUseRelease(
        acquireRuleLock(ruleLocksRef, ruleId),
        (lock) => lock.withPermit(effect),
        () => releaseRuleLockReference(ruleLocksRef, ruleId),
      );

    const failAfterPreparedRelease = (prepared: PreparedRun, error: Error) =>
      prepared.status === "ready"
        ? prepared.release.pipe(Effect.andThen(Effect.fail(error)))
        : Effect.fail(error);

    const hasPersistedActiveRun = (ruleId: AutomationRuleId, ignoredRunId?: AutomationRunId) =>
      listRunsForRule(ruleId).pipe(
        Effect.map((runs) =>
          runs.some(
            (run) =>
              run.id !== ignoredRunId && (run.status === "queued" || run.status === "running"),
          ),
        ),
      );

    const hasActiveRun = (ruleId: AutomationRuleId, ignoredRunId?: AutomationRunId) =>
      hasPersistedActiveRun(ruleId, ignoredRunId).pipe(
        Effect.map((persistedActive) => persistedActive || input.activeRuleIds.has(ruleId)),
      );

    const createSkippedRun = (
      ruleId: AutomationRuleId,
      scheduledFor: string,
      runId: AutomationRunId = nextRunId(),
    ) =>
      Effect.gen(function* () {
        const completedAt = yield* nowIso;
        const run: AutomationRun = {
          id: runId,
          ruleId,
          status: "skipped",
          reason: "previous-run-active",
          scheduledFor,
          completedAt,
        };
        yield* writeRunAndTrimForRule(run, { runId: run.id, ruleId });
        return run;
      });

    const advanceScheduleForCurrentRule = (rule: AutomationRule, triggeredAt: string) =>
      calculateNextRunAt(rule, triggeredAt).pipe(
        Effect.flatMap((nextRunAt) =>
          writeRule(
            withRuleScheduleState(rule, {
              nextRunAt,
              updatedAt: rule.updatedAt,
            }),
          ),
        ),
      );

    const saveRule = (rule: AutomationRule) =>
      withRulePreparationLock(
        rule.id,
        Effect.gen(function* () {
          const scheduleState = yield* buildRuleScheduleState(rule);
          const persistedRule = withRuleScheduleState(rule, scheduleState);
          return yield* writeRule(persistedRule);
        }),
      );

    const updateRule = (ruleId: AutomationRuleId, patch: AutomationsRulesUpdateInput["patch"]) =>
      withRulePreparationLock(
        ruleId,
        Effect.gen(function* () {
          const existing = yield* getRule(ruleId);
          if (existing === null) {
            return yield* new AutomationPluginError({
              message: `Automation rule ${ruleId} was not found.`,
            });
          }
          const updatedAt = yield* nowIso;
          const rule: AutomationRule = {
            ...existing,
            name: patch.name ?? existing.name,
            enabled: patch.enabled ?? existing.enabled,
            projectId: patch.projectId ?? existing.projectId,
            cron: patch.cron ?? existing.cron,
            timezone: patch.timezone ?? existing.timezone,
            prompt: patch.prompt ?? existing.prompt,
            updatedAt,
          };
          const scheduleState = yield* buildRuleScheduleState(rule);
          const persistedRule = withRuleScheduleState(rule, scheduleState);
          return yield* writeRule(persistedRule);
        }),
      );

    const updateListedRuleSchedule = (
      listedRule: AutomationRule,
      expectedScheduleState: AutomationRuleScheduleState | undefined,
      scheduleState: AutomationRuleScheduleState | undefined,
    ) =>
      withRulePreparationLock(
        listedRule.id,
        Effect.gen(function* () {
          const currentRule = yield* getRule(listedRule.id);
          if (currentRule === null || currentRule.updatedAt !== listedRule.updatedAt) {
            return null;
          }
          if (!sameScheduleState(currentRule.scheduleState, expectedScheduleState)) {
            return null;
          }
          const persistedRule = withRuleScheduleState(currentRule, scheduleState);
          return yield* writeRule(persistedRule);
        }),
      );

    const repairListedRuleSchedule = (rule: AutomationRule, triggeredAt: string) =>
      buildRuleScheduleState(rule, triggeredAt).pipe(
        Effect.flatMap((scheduleState) =>
          updateListedRuleSchedule(rule, rule.scheduleState, scheduleState),
        ),
      );

    const prepareRunForCurrentRule = (
      rule: AutomationRule,
      reason: AutomationRunReason,
      scheduledFor: string,
      runId: AutomationRunId = nextRunId(),
    ): Effect.Effect<PreparedRun, Error> =>
      Effect.gen(function* () {
        const active = yield* hasActiveRun(rule.id);
        if (active) {
          const run = yield* createSkippedRun(rule.id, scheduledFor, runId);
          return { status: "skipped", run } as const;
        }

        const queuedRun: AutomationRun = {
          id: runId,
          ruleId: rule.id,
          status: "queued",
          reason,
          scheduledFor,
          ruleUpdatedAt: rule.updatedAt,
        };

        yield* markActiveRule(input.activeRuleIds, rule.id);
        yield* writeRun(queuedRun).pipe(
          Effect.catch((error) =>
            releaseActiveRule(input.activeRuleIds, rule.id).pipe(
              Effect.andThen(Effect.fail(error)),
            ),
          ),
        );

        return {
          status: "ready",
          rule,
          queuedRun,
          release: releaseActiveRule(input.activeRuleIds, rule.id),
        } as const;
      });

    const prepareExistingQueuedRunForCurrentRule = (
      rule: AutomationRule,
      queuedRun: AutomationRun,
    ): Effect.Effect<PreparedRun, Error> =>
      Effect.gen(function* () {
        const active = yield* hasActiveRun(rule.id, queuedRun.id);
        if (active) {
          const run = yield* createSkippedRun(rule.id, queuedRun.scheduledFor, queuedRun.id);
          return { status: "skipped", run } as const;
        }

        yield* markActiveRule(input.activeRuleIds, rule.id);
        return {
          status: "ready",
          rule,
          queuedRun,
          release: releaseActiveRule(input.activeRuleIds, rule.id),
        } as const;
      });

    const prepareManualRun = (
      ruleId: AutomationRuleId,
      reason: AutomationRunReason,
      scheduledFor: string,
    ): Effect.Effect<PreparedRun, Error> =>
      withRulePreparationLock(
        ruleId,
        Effect.gen(function* () {
          const rule = yield* requireRule(ruleId);
          return yield* prepareRunForCurrentRule(rule, reason, scheduledFor);
        }),
      );

    const prepareScheduledRun = (
      listedRule: AutomationRule,
      expectedScheduleState: AutomationRuleScheduleState,
      triggeredAt: string,
    ): Effect.Effect<ScheduledRunPreparation, Error> =>
      withRulePreparationLock(
        listedRule.id,
        Effect.gen(function* () {
          const currentRule = yield* getRule(listedRule.id);
          if (
            currentRule === null ||
            !currentRule.enabled ||
            currentRule.updatedAt !== listedRule.updatedAt ||
            !sameScheduleState(currentRule.scheduleState, expectedScheduleState)
          ) {
            return { status: "idle" } as const;
          }

          if (isMissedRun({ nextRunAt: expectedScheduleState.nextRunAt, nowIso: triggeredAt })) {
            yield* advanceScheduleForCurrentRule(currentRule, triggeredAt);
            return { status: "idle" } as const;
          }

          const runId = scheduledRunId(currentRule.id, expectedScheduleState.nextRunAt);
          const existingRun = yield* input.collections.runs.get(runId);
          if (existingRun !== null) {
            if (
              existingRun.status === "queued" &&
              existingRun.reason === "schedule" &&
              existingRun.scheduledFor === expectedScheduleState.nextRunAt
            ) {
              const prepared = yield* prepareExistingQueuedRunForCurrentRule(
                currentRule,
                existingRun,
              );
              yield* advanceScheduleForCurrentRule(currentRule, triggeredAt).pipe(
                Effect.catch((error) => failAfterPreparedRelease(prepared, error)),
              );
              return prepared;
            }

            yield* advanceScheduleForCurrentRule(currentRule, triggeredAt);
            return { status: "idle" } as const;
          }

          const prepared = yield* prepareRunForCurrentRule(
            currentRule,
            "schedule",
            expectedScheduleState.nextRunAt,
            runId,
          );
          yield* advanceScheduleForCurrentRule(currentRule, triggeredAt).pipe(
            Effect.catch((error) => failAfterPreparedRelease(prepared, error)),
          );
          return prepared;
        }),
      );

    return {
      saveRule,
      updateRule,
      withRulePreparationLock,
      repairListedRuleSchedule,
      prepareManualRun,
      prepareScheduledRun,
      prepareExistingQueuedRunForCurrentRule,
    } as const;
  });
}

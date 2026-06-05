import type {
  PluginActivationContext,
  PluginCollection,
  PluginStoreError,
} from "@t3tools/plugin-api/server";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import { AutomationRule, AutomationRuleId, AutomationRun } from "../shared/schema.ts";
import {
  RULES_COLLECTION,
  RUNS_COLLECTION,
  RUN_RETENTION_PER_RULE,
  SCHEDULE_STATE_COLLECTION,
} from "./constants.ts";
import { AutomationPluginError } from "./errors.ts";
import { nextRunId } from "./ids.ts";
import { compareNewestRuns } from "./runs.ts";
import {
  AutomationScheduleState,
  computeNextRunAt,
  isMissedRun,
  shouldFireSchedule,
  validateFiveFieldCron,
} from "./schedule.ts";
import { automationThreadTitle, errorMessage, nowIso } from "./time.ts";

export type AutomationRunReason = "manual" | "schedule";

export interface AutomationCollections {
  readonly rules: PluginCollection<AutomationRule>;
  readonly runs: PluginCollection<AutomationRun>;
  readonly scheduleState: PluginCollection<AutomationScheduleState>;
}

export const registerAutomationCollections = (
  ctx: PluginActivationContext,
): Effect.Effect<AutomationCollections, PluginStoreError> =>
  Effect.gen(function* () {
    const rules = yield* ctx.store.registerCollection(RULES_COLLECTION, AutomationRule);
    const runs = yield* ctx.store.registerCollection(RUNS_COLLECTION, AutomationRun);
    const scheduleState = yield* ctx.store.registerCollection(
      SCHEDULE_STATE_COLLECTION,
      AutomationScheduleState,
    );
    return { rules, runs, scheduleState };
  });

type PreparedRun =
  | {
      readonly status: "skipped";
      readonly run: AutomationRun;
    }
  | {
      readonly status: "ready";
      readonly rule: AutomationRule;
      readonly queuedRun: AutomationRun;
    };

const releaseActiveRule = (activeRuleIds: Set<AutomationRuleId>, ruleId: AutomationRuleId) =>
  Effect.sync(() => {
    activeRuleIds.delete(ruleId);
  });

const markActiveRule = (activeRuleIds: Set<AutomationRuleId>, ruleId: AutomationRuleId) =>
  Effect.sync(() => {
    activeRuleIds.add(ruleId);
  });

const getRuleSemaphore = (
  locksRef: Ref.Ref<ReadonlyMap<AutomationRuleId, Semaphore.Semaphore>>,
  ruleId: AutomationRuleId,
) =>
  Effect.gen(function* () {
    const existing = (yield* Ref.get(locksRef)).get(ruleId);
    if (existing) {
      return existing;
    }

    const semaphore = yield* Semaphore.make(1);
    return yield* Ref.modify(locksRef, (locks) => {
      const current = locks.get(ruleId);
      if (current) {
        return [current, locks] as const;
      }
      const next = new Map(locks);
      next.set(ruleId, semaphore);
      return [semaphore, next] as const;
    });
  });

export function makeAutomationsRuntime(
  ctx: PluginActivationContext,
  collections: AutomationCollections,
) {
  return Effect.gen(function* () {
    const activeRuleIds = new Set<AutomationRuleId>();
    const ruleLocksRef = yield* Ref.make<ReadonlyMap<AutomationRuleId, Semaphore.Semaphore>>(
      new Map(),
    );

    const withRulePreparationLock = <A, E, R>(
      ruleId: AutomationRuleId,
      effect: Effect.Effect<A, E, R>,
    ) =>
      getRuleSemaphore(ruleLocksRef, ruleId).pipe(
        Effect.flatMap((lock) => lock.withPermit(effect)),
      );

    const listRules = (input: {
      readonly projectId?: AutomationRule["projectId"] | undefined;
      readonly enabled?: boolean | undefined;
    }) =>
      collections.rules.list().pipe(
        Effect.map((rules) =>
          [...rules]
            .filter((rule) => input.projectId === undefined || rule.projectId === input.projectId)
            .filter((rule) => input.enabled === undefined || rule.enabled === input.enabled)
            .sort((first, second) => first.name.localeCompare(second.name)),
        ),
      );

    const getRule = (ruleId: AutomationRuleId) => collections.rules.get(ruleId);

    const requireRule = (ruleId: AutomationRuleId) =>
      getRule(ruleId).pipe(
        Effect.flatMap((rule) =>
          rule === null
            ? Effect.fail(
                new AutomationPluginError({
                  message: `Automation rule ${ruleId} was not found.`,
                }),
              )
            : Effect.succeed(rule),
        ),
      );

    const ruleExists = (ruleId: AutomationRuleId) =>
      getRule(ruleId).pipe(Effect.map((rule) => rule !== null));

    const listRuns = () => collections.runs.list();

    const listRunsForRule = (ruleId: AutomationRuleId) =>
      listRuns().pipe(
        Effect.map((runs) =>
          runs
            .filter((run) => run.ruleId === ruleId)
            .slice()
            .sort(compareNewestRuns),
        ),
      );

    const publishChanged = (payload: unknown) =>
      ctx.events.publish({
        type: "automations.changed",
        payload,
      });

    const writeRun = (run: AutomationRun) =>
      collections.runs
        .upsert(run.id, run)
        .pipe(Effect.andThen(publishChanged({ runId: run.id, ruleId: run.ruleId })));

    const trimRunsForRule = (ruleId: AutomationRuleId) =>
      Effect.gen(function* () {
        const staleRuns = (yield* listRunsForRule(ruleId)).slice(RUN_RETENTION_PER_RULE);
        yield* Effect.forEach(staleRuns, (run) => collections.runs.delete(run.id), {
          concurrency: 1,
          discard: true,
        });
      });

    const hasPersistedActiveRun = (ruleId: AutomationRuleId) =>
      listRunsForRule(ruleId).pipe(
        Effect.map((runs) =>
          runs.some((run) => run.status === "queued" || run.status === "running"),
        ),
      );

    const hasActiveRun = (ruleId: AutomationRuleId) =>
      hasPersistedActiveRun(ruleId).pipe(
        Effect.map((persistedActive) => persistedActive || activeRuleIds.has(ruleId)),
      );

    const getScheduleState = (ruleId: AutomationRuleId) => collections.scheduleState.get(ruleId);

    const writeScheduleState = (state: AutomationScheduleState) =>
      collections.scheduleState.upsert(state.ruleId, state);

    const deleteScheduleState = (ruleId: AutomationRuleId) =>
      collections.scheduleState.delete(ruleId);

    const createSkippedRun = (ruleId: AutomationRuleId, scheduledFor: string) =>
      Effect.gen(function* () {
        const completedAt = yield* nowIso;
        const run: AutomationRun = {
          id: nextRunId(),
          ruleId,
          status: "skipped",
          reason: "previous-run-active",
          scheduledFor,
          completedAt,
        };
        yield* writeRun(run);
        yield* trimRunsForRule(ruleId);
        return run;
      });

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

    const persistRuleSchedule = (rule: AutomationRule) =>
      Effect.gen(function* () {
        yield* validateRuleSchedule(rule);
        if (!rule.enabled) {
          yield* deleteScheduleState(rule.id);
          return;
        }
        const updatedAt = yield* nowIso;
        const nextRunAt = yield* Effect.try({
          try: () =>
            computeNextRunAt({
              cron: rule.cron,
              timezone: rule.timezone,
              afterIso: updatedAt,
            }),
          catch: (cause) =>
            cause instanceof AutomationPluginError
              ? cause
              : new AutomationPluginError({
                  message: "Failed to calculate next automation run.",
                  cause,
                }),
        });
        yield* writeScheduleState({
          ruleId: rule.id,
          nextRunAt,
          updatedAt,
        });
      });

    const prepareRun = (
      ruleId: AutomationRuleId,
      reason: AutomationRunReason,
      scheduledFor: string,
    ): Effect.Effect<PreparedRun, Error> =>
      withRulePreparationLock(
        ruleId,
        Effect.gen(function* () {
          const rule = yield* requireRule(ruleId);
          const active = yield* hasActiveRun(ruleId);
          if (active) {
            const run = yield* createSkippedRun(ruleId, scheduledFor);
            return { status: "skipped", run } as const;
          }

          const queuedRun: AutomationRun = {
            id: nextRunId(),
            ruleId,
            status: "queued",
            reason,
            scheduledFor,
          };

          yield* markActiveRule(activeRuleIds, ruleId);
          yield* writeRun(queuedRun).pipe(
            Effect.catch((error) =>
              releaseActiveRule(activeRuleIds, ruleId).pipe(Effect.andThen(Effect.fail(error))),
            ),
          );

          return { status: "ready", rule, queuedRun } as const;
        }),
      );

    const executeRule = (
      ruleId: AutomationRuleId,
      reason: AutomationRunReason,
      scheduledFor: string,
    ) =>
      Effect.gen(function* () {
        const prepared = yield* prepareRun(ruleId, reason, scheduledFor);
        if (prepared.status === "skipped") {
          return prepared.run;
        }
        const { rule, queuedRun } = prepared;
        let latestRun = queuedRun;

        return yield* Effect.gen(function* () {
          const startedAt = yield* nowIso;
          latestRun = {
            ...queuedRun,
            status: "running",
            startedAt,
          };
          yield* writeRun(latestRun);

          const launched = yield* ctx.runtime.createAndSendThread({
            projectId: rule.projectId,
            title: automationThreadTitle(rule, scheduledFor),
            prompt: rule.prompt,
          });

          const completedRun: AutomationRun = {
            ...latestRun,
            status: "completed",
            threadId: launched.threadId,
            completedAt: yield* nowIso,
          };
          if (yield* ruleExists(ruleId)) {
            yield* writeRun(completedRun);
            yield* trimRunsForRule(ruleId);
          }
          return completedRun;
        }).pipe(
          Effect.catch((error) =>
            Effect.gen(function* () {
              const failedRun: AutomationRun = {
                ...latestRun,
                status: "failed",
                completedAt: yield* nowIso,
                error: errorMessage(error),
              };
              if (yield* ruleExists(ruleId)) {
                yield* writeRun(failedRun);
                yield* trimRunsForRule(ruleId);
              }
              return failedRun;
            }),
          ),
          Effect.ensuring(releaseActiveRule(activeRuleIds, ruleId)),
        );
      });

    const deleteRule = (ruleId: AutomationRuleId) =>
      withRulePreparationLock(
        ruleId,
        Effect.gen(function* () {
          yield* deleteScheduleState(ruleId);
          const runs = yield* listRunsForRule(ruleId);
          yield* Effect.forEach(runs, (run) => collections.runs.delete(run.id), {
            concurrency: 1,
            discard: true,
          });
          yield* collections.rules.delete(ruleId);
          yield* publishChanged({ ruleId, deleted: true });
        }),
      );

    const countFailedOrSkippedRuns = () =>
      listRuns().pipe(
        Effect.map(
          (runs) =>
            runs.filter((run) => run.status === "failed" || run.status === "skipped").length,
        ),
      );

    const markInterruptedRunsFailed = Effect.gen(function* () {
      const completedAt = yield* nowIso;
      const runs = yield* listRuns();
      const touchedRuleIds = new Set<AutomationRuleId>();
      yield* Effect.forEach(
        runs.filter((run) => run.status === "queued" || run.status === "running"),
        (run) =>
          Effect.gen(function* () {
            const failedRun: AutomationRun = {
              ...run,
              status: "failed",
              completedAt,
              error: "Automation run did not complete before server restart.",
            };
            yield* writeRun(failedRun);
            touchedRuleIds.add(run.ruleId);
          }),
        { concurrency: 1, discard: true },
      );
      yield* Effect.forEach(touchedRuleIds, trimRunsForRule, {
        concurrency: 1,
        discard: true,
      });
    });

    const tickSchedules = (triggeredAt: string, options?: { readonly forkRuns?: boolean }) =>
      Effect.gen(function* () {
        const rules = yield* listRules({ enabled: true });
        for (const rule of rules) {
          const state = yield* getScheduleState(rule.id);
          if (state === null) {
            yield* persistRuleSchedule(rule);
            continue;
          }

          if (state.nextRunAt > triggeredAt) {
            continue;
          }

          const nextRunAt = yield* Effect.try({
            try: () =>
              computeNextRunAt({
                cron: rule.cron,
                timezone: rule.timezone,
                afterIso: triggeredAt,
              }),
            catch: (cause) =>
              cause instanceof AutomationPluginError
                ? cause
                : new AutomationPluginError({
                    message: "Failed to calculate next automation run.",
                    cause,
                  }),
          });
          yield* writeScheduleState({
            ruleId: rule.id,
            nextRunAt,
            updatedAt: triggeredAt,
          });

          if (isMissedRun({ nextRunAt: state.nextRunAt, nowIso: triggeredAt })) {
            continue;
          }
          if (!shouldFireSchedule({ nextRunAt: state.nextRunAt, nowIso: triggeredAt })) {
            continue;
          }

          const run = executeRule(rule.id, "schedule", state.nextRunAt).pipe(
            Effect.asVoid,
            Effect.catch((cause) =>
              Effect.logWarning("Automation schedule run failed", {
                ruleId: rule.id,
                cause,
              }),
            ),
          );
          if (options?.forkRuns ?? true) {
            yield* Effect.forkScoped(run);
          } else {
            yield* run;
          }
        }
      });

    return {
      listRules,
      executeRule,
      persistRuleSchedule,
      tickSchedules,
      deleteRule,
      countFailedOrSkippedRuns,
      listRunsForRule,
      listRuns,
      markInterruptedRunsFailed,
      publishChanged,
    } as const;
  });
}

export type AutomationsRuntime = Effect.Success<ReturnType<typeof makeAutomationsRuntime>>;

export const startAutomationScheduleLoop = (runtime: AutomationsRuntime) =>
  Effect.forever(
    Effect.sleep(Duration.seconds(60)).pipe(
      Effect.flatMap(() => nowIso),
      Effect.flatMap((triggeredAt) => runtime.tickSchedules(triggeredAt, { forkRuns: true })),
      Effect.catch((cause) =>
        Effect.logWarning("Automation scheduler tick failed", {
          cause,
        }),
      ),
    ),
  ).pipe(Effect.forkScoped);

export const runAutomationScheduleTick = (ctx: PluginActivationContext, triggeredAt: string) =>
  registerAutomationCollections(ctx).pipe(
    Effect.flatMap((collections) => makeAutomationsRuntime(ctx, collections)),
    Effect.flatMap((runtime) => runtime.tickSchedules(triggeredAt, { forkRuns: false })),
  );

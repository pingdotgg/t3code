import {
  PluginCommandName,
  PluginId,
  PluginRouteId,
  PluginUiPlacementId,
  ProjectId,
  ThreadId,
} from "@t3tools/plugin-api/schema";
import { PluginStoreError } from "@t3tools/plugin-api/server";
import {
  PluginActivationHarnessError,
  makePluginActivationTestHarness,
  type PluginActivationTestHarness,
} from "@t3tools/plugin-api/testing";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";

import {
  AUTOMATIONS_COMMANDS,
  AUTOMATIONS_PLUGIN_ID,
  automationsPlugin,
  computeNextRunAt,
  isMissedRun,
  validateFiveFieldCron,
} from "./server/index.ts";
import { registerAutomationCommands } from "./server/commands.ts";
import { PLACEMENT_MAIN_SIDEBAR } from "./server/constants.ts";
import { scheduledRunId } from "./server/ids.ts";
import {
  type AutomationsRuntime,
  makeAutomationsRuntime,
  registerAutomationCollections,
} from "./server/runtime.ts";
import { AutomationRunId, type AutomationRule, type AutomationRun } from "./shared/schema.ts";

type Harness = PluginActivationTestHarness;

function makeHarness(options?: {
  readonly createAndSendThread?: Harness["ctx"]["runtime"]["createAndSendThread"];
  readonly beforeDocumentUpsert?: (input: {
    readonly collection: string;
    readonly documentId: string;
    readonly document: unknown;
  }) => Effect.Effect<void, PluginStoreError>;
}): Harness {
  return makePluginActivationTestHarness({
    pluginId: PluginId.make(AUTOMATIONS_PLUGIN_ID),
    paths: {
      dataDir: "/tmp/t3-automations-test/data",
      cacheDir: "/tmp/t3-automations-test/cache",
      tempDir: "/tmp/t3-automations-test/tmp",
    },
    createAndSendThread: options?.createAndSendThread,
    beforeDocumentUpsert: options?.beforeDocumentUpsert,
  });
}

function commandName(command: (typeof AUTOMATIONS_COMMANDS)[keyof typeof AUTOMATIONS_COMMANDS]) {
  return PluginCommandName.make(command);
}

function invoke<T>(
  harness: Harness,
  command: (typeof AUTOMATIONS_COMMANDS)[keyof typeof AUTOMATIONS_COMMANDS],
  input: unknown,
) {
  return Effect.gen(function* () {
    const registration = harness.commands.get(commandName(command));
    if (!registration) {
      return yield* new PluginActivationHarnessError({
        message: `Command ${command} was not registered.`,
      });
    }
    const output = yield* registration.invoke(input);
    return (yield* registration.decodeOutput(output)) as T;
  });
}

const projectId = ProjectId.make("project-automations-test");

const createRuleInput = {
  name: "Daily check",
  enabled: true,
  projectId,
  cron: "0 9 * * *",
  timezone: "UTC",
  prompt: "Summarize the repo state.",
};

function runDueSchedulesNow(runtime: AutomationsRuntime, triggeredAt: string) {
  return runtime.runDueScheduledRuns(triggeredAt);
}

function activateHarnessRuntime(harness: Harness): Effect.Effect<AutomationsRuntime, Error> {
  return Effect.gen(function* () {
    const collections = yield* registerAutomationCollections(harness.ctx);
    const runtime = yield* makeAutomationsRuntime(harness.ctx, collections);
    yield* runtime.markInterruptedRunsFailed;
    yield* harness.ctx.ui.setPlacementBadgeProvider(
      PLACEMENT_MAIN_SIDEBAR,
      runtime.countFailedOrSkippedRuns,
    );
    yield* registerAutomationCommands(harness.ctx, runtime);
    return runtime;
  });
}

it("Automations cron policy helpers", () => {
  assert.equal(
    computeNextRunAt({
      cron: "0 9 * * *",
      timezone: "America/New_York",
      afterIso: "2026-01-01T00:00:00.000Z",
    }),
    "2026-01-01T14:00:00.000Z",
  );

  let cronError: unknown;
  try {
    validateFiveFieldCron("0 0 9 * * *", "UTC");
  } catch (error) {
    cronError = error;
  }
  assert.instanceOf(cronError, Error);

  assert.isTrue(
    isMissedRun({
      nextRunAt: "2026-01-01T14:00:00.000Z",
      nowIso: "2026-01-01T14:05:00.000Z",
    }),
  );
});

it.effect(
  "Automations plugin registers its manifest slice, commands, collections, and badge provider",
  () =>
    Effect.gen(function* () {
      const harness = makeHarness();

      yield* automationsPlugin.activate(harness.ctx);

      assert.equal(automationsPlugin.manifest.id, PluginId.make(AUTOMATIONS_PLUGIN_ID));
      assert.equal(automationsPlugin.manifest.routes[0]?.id, PluginRouteId.make("main"));
      assert.isTrue(harness.collections.has("rules"));
      assert.isTrue(harness.collections.has("runs"));
      assert.equal(harness.commands.size, automationsPlugin.manifest.commands.length);
      assert.isFunction(harness.badgeProviders.get(PluginUiPlacementId.make("main-sidebar")));
    }),
);

it.effect("Automations rule CRUD persists schedule state and hard deletes run history", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    assert.isString(created.rule.scheduleState?.nextRunAt);
    assert.equal(created.rule.scheduleState?.updatedAt, created.rule.updatedAt);

    const updated = yield* invoke<{
      readonly rule: {
        readonly name: string;
        readonly enabled: boolean;
        readonly scheduleState?: unknown;
      };
    }>(harness, AUTOMATIONS_COMMANDS.rulesUpdate, {
      ruleId: created.rule.id,
      patch: {
        name: "Daily disabled check",
        enabled: false,
      },
    });
    assert.equal(updated.rule.name, "Daily disabled check");
    assert.isFalse(updated.rule.enabled);
    assert.isUndefined(updated.rule.scheduleState);

    yield* invoke(harness, AUTOMATIONS_COMMANDS.rulesRunNow, {
      ruleId: created.rule.id,
    });
    const beforeDelete = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.equal(beforeDelete.runs.length, 1);

    yield* invoke(harness, AUTOMATIONS_COMMANDS.rulesDelete, {
      ruleId: created.rule.id,
    });

    const afterDeleteRules = yield* invoke<{
      readonly rules: ReadonlyArray<unknown>;
    }>(harness, AUTOMATIONS_COMMANDS.rulesList, {});
    const afterDeleteRuns = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.deepEqual(afterDeleteRules.rules, []);
    assert.deepEqual(afterDeleteRuns.runs, []);
  }),
);

it.effect("Automations concurrent rule updates patch the latest persisted rule", () =>
  Effect.gen(function* () {
    const firstUpdateReady = yield* Deferred.make<void>();
    const releaseFirstUpdate = yield* Deferred.make<void>();
    let pausedFirstUpdate = false;
    const harness = makeHarness({
      beforeDocumentUpsert: ({ collection, document }) =>
        Effect.gen(function* () {
          if (collection !== "rules" || pausedFirstUpdate) return;
          const rule = document as AutomationRule;
          if (rule.name !== "Renamed check") return;
          pausedFirstUpdate = true;
          yield* Deferred.succeed(firstUpdateReady, undefined);
          yield* Deferred.await(releaseFirstUpdate);
        }),
    });
    yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const firstUpdate = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesUpdate,
      {
        ruleId: created.rule.id,
        patch: { name: "Renamed check" },
      },
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(firstUpdateReady);
    const secondUpdate = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesUpdate,
      {
        ruleId: created.rule.id,
        patch: { prompt: "Use the latest repo state." },
      },
    ).pipe(Effect.forkScoped);
    yield* Deferred.succeed(releaseFirstUpdate, undefined);

    yield* Fiber.join(firstUpdate);
    const updated = yield* Fiber.join(secondUpdate);

    assert.equal(updated.rule.name, "Renamed check");
    assert.equal(updated.rule.prompt, "Use the latest repo state.");
  }),
);

it.effect("Automations run-now creates a new thread and records a completed manual run", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const result = yield* invoke<{ readonly run: AutomationRun }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesRunNow,
      { ruleId: created.rule.id },
    );

    assert.equal(result.run.status, "completed");
    assert.equal(result.run.reason, "manual");
    assert.equal(result.run.threadId, ThreadId.make("thread-1"));
    assert.equal(harness.launchedThreads.length, 1);
    assert.equal(harness.launchedThreads[0]?.projectId, projectId);
    assert.match(harness.launchedThreads[0]?.title ?? "", /^Daily check - /);
  }),
);

it.effect("Automations scheduled tick creates a schedule run and thread", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const runtime = yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    yield* harness.documents.upsert<AutomationRule>("rules", created.rule.id, {
      ...created.rule,
      scheduleState: {
        nextRunAt: "2026-01-01T09:00:00.000Z",
        updatedAt: created.rule.updatedAt,
      },
    });
    yield* runDueSchedulesNow(runtime, "2026-01-01T09:00:10.000Z");

    const runs = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.equal(runs.runs[0]?.status, "completed");
    assert.equal(runs.runs[0]?.reason, "schedule");
    assert.equal(harness.launchedThreads.length, 1);
  }),
);

it.effect("Automations scheduled tick repairs stale rule schedule state before firing", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const runtime = yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    yield* harness.documents.upsert<AutomationRule>("rules", created.rule.id, {
      ...created.rule,
      scheduleState: {
        nextRunAt: "2026-01-01T09:00:00.000Z",
        updatedAt: "2025-12-31T00:00:00.000Z",
      },
    });

    yield* runDueSchedulesNow(runtime, "2026-01-01T09:00:10.000Z");

    const repairedRule = yield* harness.documents.get<AutomationRule>("rules", created.rule.id);
    assert.equal(repairedRule?.scheduleState?.updatedAt, created.rule.updatedAt);
    const runs = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.deepEqual(runs.runs, []);
    assert.equal(harness.launchedThreads.length, 0);
  }),
);

it.effect("Automations overlapping scheduler ticks do not run the same due state twice", () =>
  Effect.gen(function* () {
    const firstAdvanceReady = yield* Deferred.make<void>();
    const releaseFirstAdvance = yield* Deferred.make<void>();
    let advanceWrites = 0;
    const harness = makeHarness({
      beforeDocumentUpsert: ({ collection, document }) =>
        Effect.gen(function* () {
          if (collection !== "rules") return;
          const rule = document as AutomationRule;
          if (rule.scheduleState?.nextRunAt !== "2026-01-02T09:00:00.000Z") return;
          advanceWrites += 1;
          if (advanceWrites === 1) {
            yield* Deferred.succeed(firstAdvanceReady, undefined);
            yield* Deferred.await(releaseFirstAdvance);
          }
        }),
    });
    const runtime = yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    yield* harness.documents.upsert<AutomationRule>("rules", created.rule.id, {
      ...created.rule,
      scheduleState: {
        nextRunAt: "2026-01-01T09:00:00.000Z",
        updatedAt: created.rule.updatedAt,
      },
    });
    const firstTick = yield* runDueSchedulesNow(runtime, "2026-01-01T09:00:10.000Z").pipe(
      Effect.forkScoped,
    );
    yield* Deferred.await(firstAdvanceReady);
    const secondTick = yield* runDueSchedulesNow(runtime, "2026-01-01T09:00:10.000Z").pipe(
      Effect.forkScoped,
    );
    yield* Deferred.succeed(releaseFirstAdvance, undefined);

    yield* Fiber.join(firstTick);
    yield* Fiber.join(secondTick);

    const runs = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.equal(advanceWrites, 1);
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0]?.scheduledFor, "2026-01-01T09:00:00.000Z");
    assert.equal(harness.launchedThreads.length, 1);
  }),
);

it.effect("Automations scheduled tick resumes queued deterministic runs after claim failure", () =>
  Effect.gen(function* () {
    let failScheduleAdvance = true;
    const harness = makeHarness({
      beforeDocumentUpsert: ({ collection, document }) =>
        Effect.gen(function* () {
          if (collection !== "rules" || !failScheduleAdvance) return;
          const rule = document as AutomationRule;
          if (rule.scheduleState?.nextRunAt !== "2026-01-02T09:00:00.000Z") return;
          failScheduleAdvance = false;
          return yield* Effect.fail(new PluginStoreError("Failed to advance schedule."));
        }),
    });
    const runtime = yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    yield* harness.documents.upsert<AutomationRule>("rules", created.rule.id, {
      ...created.rule,
      scheduleState: {
        nextRunAt: "2026-01-01T09:00:00.000Z",
        updatedAt: created.rule.updatedAt,
      },
    });

    const failedTick = yield* Effect.result(
      runDueSchedulesNow(runtime, "2026-01-01T09:00:10.000Z"),
    );
    assert.equal(failedTick._tag, "Failure");

    yield* runtime.markInterruptedRunsFailed;
    yield* runtime.recoverQueuedScheduledRuns();

    yield* runDueSchedulesNow(runtime, "2026-01-01T09:00:10.000Z");

    const runs = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0]?.status, "completed");
    assert.equal(runs.runs[0]?.scheduledFor, "2026-01-01T09:00:00.000Z");
    assert.equal(harness.launchedThreads.length, 1);
  }),
);

it.effect("Automations startup recovers queued deterministic runs after schedule advancement", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const runtime = yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const scheduledFor = "2026-01-01T09:00:00.000Z";
    yield* harness.documents.upsert<AutomationRule>("rules", created.rule.id, {
      ...created.rule,
      scheduleState: {
        nextRunAt: "2026-01-02T09:00:00.000Z",
        updatedAt: created.rule.updatedAt,
      },
    });
    yield* harness.documents.upsert<AutomationRun>(
      "runs",
      scheduledRunId(created.rule.id, scheduledFor),
      {
        id: scheduledRunId(created.rule.id, scheduledFor),
        ruleId: created.rule.id,
        status: "queued",
        reason: "schedule",
        scheduledFor,
        ruleUpdatedAt: created.rule.updatedAt,
      },
    );

    yield* runtime.markInterruptedRunsFailed;
    yield* runtime.recoverQueuedScheduledRuns();
    yield* runDueSchedulesNow(runtime, "2026-01-01T09:00:10.000Z");

    const runs = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0]?.status, "completed");
    assert.equal(runs.runs[0]?.scheduledFor, scheduledFor);
    assert.equal(harness.launchedThreads.length, 1);
  }),
);

it.effect("Automations startup fails stale queued deterministic runs after rule edits", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const runtime = yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const scheduledFor = "2026-01-01T09:00:00.000Z";
    yield* harness.documents.upsert<AutomationRule>("rules", created.rule.id, {
      ...created.rule,
      prompt: "mutated prompt",
      updatedAt: "2026-01-01T09:30:00.000Z",
      scheduleState: {
        nextRunAt: "2026-01-02T09:00:00.000Z",
        updatedAt: "2026-01-01T09:30:00.000Z",
      },
    });
    yield* harness.documents.upsert<AutomationRun>(
      "runs",
      scheduledRunId(created.rule.id, scheduledFor),
      {
        id: scheduledRunId(created.rule.id, scheduledFor),
        ruleId: created.rule.id,
        status: "queued",
        reason: "schedule",
        scheduledFor,
        ruleUpdatedAt: created.rule.updatedAt,
      },
    );

    yield* runtime.markInterruptedRunsFailed;
    yield* runtime.recoverQueuedScheduledRuns();

    const runs = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.equal(runs.runs.length, 1);
    assert.equal(runs.runs[0]?.status, "failed");
    assert.equal(harness.launchedThreads.length, 0);
  }),
);

it.effect("Automations scheduled tick applies overlap policy to existing queued runs", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const runtime = yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const scheduledFor = "2026-01-01T09:00:00.000Z";
    const runId = scheduledRunId(created.rule.id, scheduledFor);
    yield* harness.documents.upsert<AutomationRule>("rules", created.rule.id, {
      ...created.rule,
      scheduleState: {
        nextRunAt: scheduledFor,
        updatedAt: created.rule.updatedAt,
      },
    });
    yield* harness.documents.upsert<AutomationRun>("runs", "run-active", {
      id: AutomationRunId.make("run-active"),
      ruleId: created.rule.id,
      status: "running",
      reason: "manual",
      scheduledFor: "2026-01-01T08:59:00.000Z",
      startedAt: "2026-01-01T08:59:01.000Z",
    });
    yield* harness.documents.upsert<AutomationRun>("runs", runId, {
      id: runId,
      ruleId: created.rule.id,
      status: "queued",
      reason: "schedule",
      scheduledFor,
      ruleUpdatedAt: created.rule.updatedAt,
    });

    yield* runDueSchedulesNow(runtime, "2026-01-01T09:00:10.000Z");

    const runs = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    const scheduledRun = runs.runs.find((run) => run.id === runId);
    assert.equal(scheduledRun?.status, "skipped");
    assert.equal(scheduledRun?.reason, "previous-run-active");
    assert.equal(harness.launchedThreads.length, 0);
  }),
);

it.effect("Automations recovery applies overlap policy to queued deterministic runs", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    const runtime = yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const scheduledFor = "2026-01-01T09:00:00.000Z";
    const runId = scheduledRunId(created.rule.id, scheduledFor);
    yield* harness.documents.upsert<AutomationRule>("rules", created.rule.id, {
      ...created.rule,
      scheduleState: {
        nextRunAt: "2026-01-02T09:00:00.000Z",
        updatedAt: created.rule.updatedAt,
      },
    });
    yield* harness.documents.upsert<AutomationRun>("runs", "run-active", {
      id: AutomationRunId.make("run-active"),
      ruleId: created.rule.id,
      status: "running",
      reason: "manual",
      scheduledFor: "2026-01-01T08:59:00.000Z",
      startedAt: "2026-01-01T08:59:01.000Z",
    });
    yield* harness.documents.upsert<AutomationRun>("runs", runId, {
      id: runId,
      ruleId: created.rule.id,
      status: "queued",
      reason: "schedule",
      scheduledFor,
      ruleUpdatedAt: created.rule.updatedAt,
    });

    yield* runtime.recoverQueuedScheduledRuns();

    const runs = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    const scheduledRun = runs.runs.find((run) => run.id === runId);
    assert.equal(scheduledRun?.status, "skipped");
    assert.equal(scheduledRun?.reason, "previous-run-active");
    assert.equal(harness.launchedThreads.length, 0);
  }),
);

it.effect("Automations overlap policy records skipped runs without launching a thread", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    yield* harness.documents.upsert<AutomationRun>("runs", "run-active", {
      id: AutomationRunId.make("run-active"),
      ruleId: created.rule.id,
      status: "running",
      reason: "manual",
      scheduledFor: "2026-01-01T09:00:00.000Z",
      startedAt: "2026-01-01T09:00:01.000Z",
    });

    const result = yield* invoke<{ readonly run: AutomationRun }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesRunNow,
      { ruleId: created.rule.id },
    );

    assert.equal(result.run.status, "skipped");
    assert.equal(result.run.reason, "previous-run-active");
    assert.equal(harness.launchedThreads.length, 0);
  }),
);

it.effect("Automations concurrent run-now requests use the overlap policy", () =>
  Effect.gen(function* () {
    const firstThreadStarted = yield* Deferred.make<void>();
    const releaseFirstThread = yield* Deferred.make<void>();
    let launchedThreadCount = 0;
    const harness = makeHarness({
      createAndSendThread: () =>
        Effect.gen(function* () {
          launchedThreadCount += 1;
          yield* Deferred.succeed(firstThreadStarted, undefined);
          yield* Deferred.await(releaseFirstThread);
          return { threadId: ThreadId.make(`thread-${launchedThreadCount}`) };
        }),
    });
    yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const firstRun = yield* invoke<{ readonly run: AutomationRun }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesRunNow,
      { ruleId: created.rule.id },
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(firstThreadStarted);

    const secondRun = yield* invoke<{ readonly run: AutomationRun }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesRunNow,
      { ruleId: created.rule.id },
    );

    assert.equal(secondRun.run.status, "skipped");
    assert.equal(secondRun.run.reason, "previous-run-active");
    assert.equal(launchedThreadCount, 1);

    yield* Deferred.succeed(releaseFirstThread, undefined);
    const completedFirstRun = yield* Fiber.join(firstRun);
    assert.equal(completedFirstRun.run.status, "completed");
  }),
);

it.effect("Automations interrupted post-launch runs retain the launched thread id", () =>
  Effect.gen(function* () {
    const completingWriteStarted = yield* Deferred.make<void>();
    const releaseCompletingWrite = yield* Deferred.make<void>();
    let pausedCompletingWrite = false;
    const harness = makeHarness({
      createAndSendThread: () => Effect.succeed({ threadId: ThreadId.make("thread-launched") }),
      beforeDocumentUpsert: ({ collection, document }) =>
        Effect.gen(function* () {
          if (collection !== "runs" || pausedCompletingWrite) return;
          const run = document as AutomationRun;
          if (run.status !== "completed") return;
          pausedCompletingWrite = true;
          yield* Deferred.succeed(completingWriteStarted, undefined);
          yield* Deferred.await(releaseCompletingWrite);
        }),
    });
    yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const running = yield* invoke<{ readonly run: AutomationRun }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesRunNow,
      { ruleId: created.rule.id },
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(completingWriteStarted);
    yield* Fiber.interrupt(running);

    const runs = yield* invoke<{ readonly runs: ReadonlyArray<AutomationRun> }>(
      harness,
      AUTOMATIONS_COMMANDS.runsListRecent,
      { ruleId: created.rule.id, limit: 10 },
    );
    assert.equal(runs.runs[0]?.status, "failed");
    assert.equal(runs.runs[0]?.threadId, ThreadId.make("thread-launched"));
  }),
);

it.effect("Automations deleting an active rule does not recreate run history", () =>
  Effect.gen(function* () {
    const firstThreadStarted = yield* Deferred.make<void>();
    const releaseFirstThread = yield* Deferred.make<void>();
    const harness = makeHarness({
      createAndSendThread: () =>
        Deferred.succeed(firstThreadStarted, undefined).pipe(
          Effect.andThen(Deferred.await(releaseFirstThread)),
          Effect.as({ threadId: ThreadId.make("thread-active-delete") }),
        ),
    });
    yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    const running = yield* invoke<{ readonly run: AutomationRun }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesRunNow,
      { ruleId: created.rule.id },
    ).pipe(Effect.forkScoped);
    yield* Deferred.await(firstThreadStarted);

    yield* invoke(harness, AUTOMATIONS_COMMANDS.rulesDelete, {
      ruleId: created.rule.id,
    });
    yield* Deferred.succeed(releaseFirstThread, undefined);
    yield* Fiber.join(running);

    const runs = yield* invoke<{
      readonly runs: ReadonlyArray<AutomationRun>;
    }>(harness, AUTOMATIONS_COMMANDS.runsListRecent, {
      ruleId: created.rule.id,
      limit: 10,
    });
    assert.deepEqual(runs.runs, []);
  }),
);

it.effect("Automations retains only the last 100 runs per rule", () =>
  Effect.gen(function* () {
    const harness = makeHarness();
    yield* activateHarnessRuntime(harness);

    const created = yield* invoke<{ readonly rule: AutomationRule }>(
      harness,
      AUTOMATIONS_COMMANDS.rulesCreate,
      createRuleInput,
    );
    for (let index = 0; index < 101; index += 1) {
      const id = AutomationRunId.make(`run-stale-${index}`);
      yield* harness.documents.upsert<AutomationRun>("runs", id, {
        id,
        ruleId: created.rule.id,
        status: "completed",
        reason: "schedule",
        scheduledFor: `2026-01-01T${String(index % 24).padStart(2, "0")}:00:00.000Z`,
        completedAt: `2026-01-01T${String(index % 24).padStart(2, "0")}:01:00.000Z`,
      });
    }

    yield* invoke(harness, AUTOMATIONS_COMMANDS.rulesRunNow, {
      ruleId: created.rule.id,
    });

    const runs = yield* invoke<{ readonly runs: ReadonlyArray<AutomationRun> }>(
      harness,
      AUTOMATIONS_COMMANDS.runsListRecent,
      { ruleId: created.rule.id, limit: 500 },
    );
    assert.equal(runs.runs.length, 100);
  }),
);

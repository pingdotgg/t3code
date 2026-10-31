import { assert, describe, it } from "@effect/vitest";
import {
  ProviderInstanceId,
  ProviderDriverKind,
  RunId,
  ThreadId,
  type OrchestrationV2LimitRecovery,
  type ServerProvider,
  type OrchestrationV2DomainEvent,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";
import * as UsageLimitRecoveryWorker from "./UsageLimitRecoveryWorker.ts";
import { limitRecoveryCommand } from "./UsageLimitRecoveryWorker.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";

it.effect("backs off a pending account attempt across repeated sweep ticks", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const baseThread = failedThread(0, -5 * HOUR_MS);
    const attemptedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 10_000));
    const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 5_000));
    const thread = {
      ...baseThread,
      limitRecovery: {
        runId: baseThread.latestRunId!,
        resetAt: baseThread.usageLimitResetAt!,
        autoResume: true,
        codexResetRedemption: {
          providerInstanceId: baseThread.providerInstanceId,
          redeemedByProviderInstanceId: baseThread.providerInstanceId,
          accountFingerprint: "codex-account:fingerprint",
          accountLabel: "test account",
          idempotencyKey: "attempt:pending",
          attemptedAt,
          creditsBefore: 1,
          outcome: "pending",
          allowanceCleared: false,
        },
      },
    };
    const refreshes = yield* Ref.make(0);
    const queries = yield* Ref.make(0);
    const provider = {
      instanceId: baseThread.providerInstanceId,
      driver: ProviderDriverKind.make("codex"),
      usageLimits: {
        credentialFingerprint: "codex-account:fingerprint",
        checkedAt,
        windows: [],
        resetCredits: { availableCount: 1 },
      },
    } as unknown as ServerProvider;
    const layer = Layer.mergeAll(
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getLimitRecoveryCandidates: () =>
          Ref.updateAndGet(queries, (count) => count + 1).pipe(Effect.as([thread])),
        getLimitRecoveryWakeAt: () => Effect.succeed(nowMs + 5 * HOUR_MS),
        getCodexResetAttempt: () =>
          Effect.succeed({
            accountFingerprint: "codex-account:fingerprint",
            resetAt: thread.usageLimitResetAt!,
            idempotencyKey: "attempt:pending",
            attemptedAt,
            outcome: "pending",
            allowanceCleared: false,
            checkedAt,
            nextCheckAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 55_000)),
          }),
      } as never),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(Orchestrator.OrchestratorV2)({ streamDomainEvents: Stream.never }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          autoResumeLimitedThreads: true,
          snoozeLimitedThreads: false,
          autoRedeemCodexResetCredits: { [baseThread.providerInstanceId]: true },
        } as never),
        streamChanges: Stream.never,
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([provider]),
        refreshInstance: () =>
          Ref.updateAndGet(refreshes, (count) => count + 1).pipe(Effect.as([provider])),
        supportsAutoRedeemResetCredit: () => Effect.succeed(true),
      }),
    );
    const sweep = yield* UsageLimitRecoveryWorker.makeSweep.pipe(Effect.provide(layer));
    yield* sweep();
    yield* TestClock.adjust("5 seconds");
    yield* sweep();
    assert.strictEqual(yield* Ref.get(queries), 1);
    assert.strictEqual(yield* Ref.get(refreshes), 0);
  }),
);

it.effect("reports the driver's fresh redemption timestamp and credit count", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const base = failedThread(0, -HOUR_MS);
    const fingerprint = "codex-account:fresh-result";
    const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs + 1_000));
    const thread = {
      ...base,
      limitRecovery: {
        runId: base.latestRunId!,
        resetAt: base.usageLimitResetAt!,
        autoResume: true,
      },
    };
    const provider = {
      instanceId: base.providerInstanceId,
      driver: ProviderDriverKind.make("codex"),
      usageLimits: {
        credentialFingerprint: fingerprint,
        checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - 60_000)),
        windows: [],
        resetCredits: { availableCount: 1 },
      },
    } as unknown as ServerProvider;
    const ledger = yield* Ref.make<ProjectionStore.CodexResetAttempt | null>(null);
    const reports = yield* Ref.make<
      ReadonlyArray<{
        readonly threadId: ThreadId;
        readonly report: NonNullable<OrchestrationV2LimitRecovery["codexResetRedemption"]>;
      }>
    >([]);
    const dispatches = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const layer = Layer.mergeAll(
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getLimitRecoveryCandidates: () => Effect.succeed([thread]),
        getLimitRecoveryWakeAt: () => Effect.succeed(nowMs + HOUR_MS),
        getCodexResetAttempt: () => Ref.get(ledger),
        claimCodexResetAttempt: (attempt: ProjectionStore.CodexResetAttempt) =>
          Ref.set(ledger, attempt).pipe(Effect.as(true)),
        updateCodexResetAttempt: (attempt: ProjectionStore.CodexResetAttempt) =>
          Ref.set(ledger, attempt),
        releaseCodexResetAttempt: () => Ref.set(ledger, null),
      } as never),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          command.type === "message.dispatch"
            ? Ref.update(dispatches, (ids) => [...ids, command.threadId]).pipe(
                Effect.as({ sequence: 1, storedEvents: [] }),
              )
            : Effect.die("expected a limit continuation"),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.never,
        recordCodexResetRedemption: (input) =>
          Ref.update(reports, (entries) => [
            ...entries,
            { threadId: input.threadId, report: input.codexResetRedemption },
          ]).pipe(Effect.as(true)),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          autoResumeLimitedThreads: true,
          snoozeLimitedThreads: false,
          autoRedeemCodexResetCredits: { [base.providerInstanceId]: true },
        } as never),
        streamChanges: Stream.never,
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([provider]),
        refreshInstance: () => Effect.succeed([provider]),
        supportsAutoRedeemResetCredit: () => Effect.succeed(true),
        autoRedeemResetCredit: (input) =>
          Effect.succeed({
            status: "sent",
            accountFingerprint: fingerprint,
            creditsBefore: 4,
            outcome: "reset",
            checkedAt,
            allowanceCleared: true,
            idempotencyKey: input.idempotencyKey,
          } as const),
      }),
    );
    const sweep = yield* UsageLimitRecoveryWorker.makeSweep.pipe(Effect.provide(layer));
    yield* sweep();

    const driverReport = (yield* Ref.get(reports)).find(
      (entry) => entry.threadId === base.id && entry.report.outcome === "reset",
    );
    assert.isDefined(driverReport);
    assert.equal(driverReport.report.checkedAt, checkedAt);
    assert.equal(driverReport.report.creditsBefore, 4);
    assert.isTrue(driverReport.report.allowanceCleared);
    assert.deepEqual(yield* Ref.get(dispatches), [base.id]);
  }),
);

it.effect("resumes a cleared account instance after a reset while the driver remains limited", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(nowMs);
    const base = failedThread(0, -HOUR_MS);
    const driverInstanceId = base.providerInstanceId;
    const secondInstanceId = ProviderInstanceId.make("provider-codex-second-instance");
    const fingerprint = "codex-account:follow-up";
    const attemptedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 120_000));
    const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 60_000));
    const threadFor = (input: { readonly id: string; readonly instanceId: ProviderInstanceId }) => {
      const threadId = ThreadId.make(input.id);
      const runId = RunId.make(`run:${input.id}`);
      return {
        ...base,
        id: threadId,
        providerInstanceId: input.instanceId,
        modelSelection: { ...base.modelSelection, instanceId: input.instanceId },
        latestRunId: runId,
        limitRecovery: {
          runId,
          resetAt: base.usageLimitResetAt!,
          autoResume: true,
          codexResetRedemption: {
            providerInstanceId: input.instanceId,
            redeemedByProviderInstanceId: driverInstanceId,
            accountFingerprint: fingerprint,
            idempotencyKey: "codex-auto-reset:follow-up",
            attemptedAt,
            creditsBefore: 1,
            outcome: "reset" as const,
            checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - 180_000)),
            allowanceCleared: false,
          },
        },
      };
    };
    const driverThread = threadFor({ id: "thread:follow-up-driver", instanceId: driverInstanceId });
    const secondThread = threadFor({ id: "thread:follow-up-second", instanceId: secondInstanceId });
    const candidates = [driverThread, secondThread];
    const previousAttempt: ProjectionStore.CodexResetAttempt = {
      accountFingerprint: fingerprint,
      resetAt: base.usageLimitResetAt!,
      idempotencyKey: "codex-auto-reset:follow-up",
      attemptedAt,
      outcome: "reset",
      allowanceCleared: false,
      checkedAt,
      nextCheckAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - 1_000)),
    };
    const ledger = yield* Ref.make(previousAttempt);
    const cachedProvider = (instanceId: ProviderInstanceId) =>
      ({
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        usageLimits: {
          credentialFingerprint: fingerprint,
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - 180_000)),
          windows: [],
          resetCredits: { availableCount: 1 },
        },
      }) as unknown as ServerProvider;
    const refreshedDriver = {
      ...cachedProvider(driverInstanceId),
      usageLimits: {
        credentialFingerprint: fingerprint,
        checkedAt,
        windows: [
          {
            id: "session",
            label: "Session",
            usedPercent: 100,
            resetsAt: base.usageLimitResetAt,
          },
        ],
        resetCredits: { availableCount: 1 },
      },
    } as unknown as ServerProvider;
    const refreshedSecond = {
      ...cachedProvider(secondInstanceId),
      usageLimits: {
        credentialFingerprint: fingerprint,
        checkedAt,
        windows: [],
        resetCredits: { availableCount: 1 },
      },
    } as unknown as ServerProvider;
    const reports = yield* Ref.make<
      ReadonlyArray<{
        readonly threadId: ThreadId;
        readonly report: NonNullable<OrchestrationV2LimitRecovery["codexResetRedemption"]>;
      }>
    >([]);
    const dispatches = yield* Ref.make<ReadonlyArray<ThreadId>>([]);
    const layer = Layer.mergeAll(
      Layer.succeed(ProjectionStore.ProjectionStoreV2, {
        getLimitRecoveryCandidates: () => Effect.succeed(candidates),
        getLimitRecoveryWakeAt: () => Effect.succeed(nowMs + HOUR_MS),
        getCodexResetAttempt: () => Ref.get(ledger),
        updateCodexResetAttempt: (attempt: ProjectionStore.CodexResetAttempt) =>
          Ref.set(ledger, attempt),
      } as never),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        dispatch: (command) =>
          command.type === "message.dispatch"
            ? Ref.update(dispatches, (ids) => [...ids, command.threadId]).pipe(
                Effect.as({ sequence: 1, storedEvents: [] }),
              )
            : Effect.die("expected a limit continuation"),
      }),
      Layer.mock(Orchestrator.OrchestratorV2)({
        streamDomainEvents: Stream.never,
        recordCodexResetRedemption: (input) =>
          Ref.update(reports, (entries) => [
            ...entries,
            { threadId: input.threadId, report: input.codexResetRedemption },
          ]).pipe(Effect.as(true)),
      }),
      Layer.mock(ServerSettings.ServerSettingsService)({
        getSettings: Effect.succeed({
          autoResumeLimitedThreads: true,
          snoozeLimitedThreads: false,
          autoRedeemCodexResetCredits: {
            [driverInstanceId]: true,
            [secondInstanceId]: true,
          },
        } as never),
        streamChanges: Stream.never,
      }),
      Layer.mock(ProviderRegistry.ProviderRegistry)({
        getProviders: Effect.succeed([
          cachedProvider(driverInstanceId),
          cachedProvider(secondInstanceId),
        ]),
        refreshInstance: (instanceId) =>
          Effect.succeed([instanceId === driverInstanceId ? refreshedDriver : refreshedSecond]),
        supportsAutoRedeemResetCredit: () => Effect.succeed(true),
      }),
    );
    const sweep = yield* UsageLimitRecoveryWorker.makeSweep.pipe(Effect.provide(layer));
    yield* sweep();

    const results = yield* Ref.get(reports);
    const driverReport = results.find((entry) => entry.threadId === driverThread.id);
    const secondReport = results.find((entry) => entry.threadId === secondThread.id);
    assert.isDefined(driverReport);
    assert.isDefined(secondReport);
    assert.isFalse(driverReport.report.allowanceCleared);
    assert.isTrue(secondReport.report.allowanceCleared);
    assert.equal(secondReport.report.checkedAt, checkedAt);
    assert.deepEqual(yield* Ref.get(dispatches), [secondThread.id]);
  }),
);

it.effect(
  "releases a first claim after a pre-send probe failure and throttles the next probe",
  () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const base = failedThread(0, -5 * HOUR_MS);
      const thread = {
        ...base,
        limitRecovery: {
          runId: base.latestRunId!,
          resetAt: base.usageLimitResetAt!,
          autoResume: true,
        },
      };
      const fingerprint = "codex-account:probe-failure";
      const provider = {
        instanceId: base.providerInstanceId,
        driver: ProviderDriverKind.make("codex"),
        usageLimits: {
          credentialFingerprint: fingerprint,
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          windows: [],
          resetCredits: { availableCount: 1 },
        },
      } as unknown as ServerProvider;
      const ledger = yield* Ref.make<ProjectionStore.CodexResetAttempt | null>(null);
      const probes = yield* Ref.make(0);
      const releases = yield* Ref.make(0);
      const reports = yield* Ref.make<ReadonlyArray<string>>([]);
      const projections: Partial<ProjectionStore.ProjectionStoreV2["Service"]> = {
        getLimitRecoveryCandidates: () => Effect.succeed([thread]),
        getLimitRecoveryWakeAt: () => Effect.succeed(nowMs + 5 * HOUR_MS),
        getCodexResetAttempt: () => Ref.get(ledger),
        claimCodexResetAttempt: (input, now) =>
          Ref.modify(ledger, (current) => {
            const expired =
              current !== null && Date.parse(current.resetAt) <= DateTime.toEpochMillis(now);
            if (current !== null && !expired) return [false, current] as const;
            return [true, input] as const;
          }),
        updateCodexResetAttempt: (input) =>
          Ref.update(ledger, (current) =>
            current?.idempotencyKey === input.idempotencyKey ? input : current,
          ),
        releaseCodexResetAttempt: (accountFingerprint, idempotencyKey) =>
          Effect.gen(function* () {
            const removed = yield* Ref.modify(ledger, (current) => {
              if (
                current?.accountFingerprint === accountFingerprint &&
                current.idempotencyKey === idempotencyKey
              )
                return [true, null] as const;
              return [false, current] as const;
            });
            if (removed) yield* Ref.update(releases, (count) => count + 1);
          }),
      };
      const layer = Layer.mergeAll(
        Layer.succeed(ProjectionStore.ProjectionStoreV2, projections as never),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.never,
          recordCodexResetRedemption: (input) =>
            Ref.update(reports, (outcomes) => [
              ...outcomes,
              input.codexResetRedemption.outcome,
            ]).pipe(Effect.as(true)),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            autoResumeLimitedThreads: true,
            snoozeLimitedThreads: false,
            autoRedeemCodexResetCredits: { [base.providerInstanceId]: true },
          } as never),
          streamChanges: Stream.never,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([provider]),
          refreshInstance: () => Effect.succeed([provider]),
          supportsAutoRedeemResetCredit: () => Effect.succeed(true),
          autoRedeemResetCredit: (input) =>
            Ref.updateAndGet(probes, (count) => count + 1).pipe(
              Effect.as({
                status: "notSent",
                reason: "probeFailed",
                accountFingerprint: fingerprint,
                creditsBefore: 1,
                idempotencyKey: input.idempotencyKey,
              } as const),
            ),
        }),
      );
      const sweep = yield* UsageLimitRecoveryWorker.makeSweep.pipe(Effect.provide(layer));
      yield* sweep();
      assert.isNull(yield* Ref.get(ledger));
      assert.strictEqual(yield* Ref.get(probes), 1);
      assert.strictEqual(yield* Ref.get(releases), 1);
      assert.deepEqual(yield* Ref.get(reports), []);
      yield* TestClock.adjust("5 seconds");
      yield* sweep();
      assert.strictEqual(yield* Ref.get(probes), 1);
      yield* TestClock.adjust("55 seconds");
      yield* sweep();
      assert.strictEqual(yield* Ref.get(probes), 2);
      assert.isNull(yield* Ref.get(ledger));
    }),
);

it.effect.each(["pending", "reset"] as const)(
  "recovers an eligible thread after another thread has a %s account attempt",
  (outcome) =>
    Effect.gen(function* () {
      yield* TestClock.setTime(nowMs);
      const baseThread = failedThread(0, -5 * HOUR_MS);
      const instanceId = ProviderInstanceId.make("provider-codex-second-instance");
      const thread = {
        ...baseThread,
        providerInstanceId: instanceId,
        modelSelection: { ...baseThread.modelSelection, instanceId },
        limitRecovery: {
          runId: baseThread.latestRunId!,
          resetAt: baseThread.usageLimitResetAt!,
          autoResume: true,
        },
      };
      const fingerprint = "codex-account:shared-login";
      const attemptedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 120_000));
      const checkedAt = DateTime.formatIso(DateTime.makeUnsafe(nowMs - 90_000));
      const previousAttempt = {
        accountFingerprint: fingerprint,
        resetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 2 * HOUR_MS)),
        idempotencyKey: "codex-auto-reset:shared-login:previous-window",
        attemptedAt,
        outcome,
        allowanceCleared: outcome === "reset",
        checkedAt,
        ...(outcome === "reset"
          ? { nextCheckAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs + 60_000)) }
          : {}),
      };
      const previousAttemptRef =
        yield* Ref.make<ProjectionStore.CodexResetAttempt>(previousAttempt);
      const stoppedThread = {
        ...baseThread,
        id: ThreadId.make("thread:limited-stopped"),
        latestRunId: RunId.make("run:limited-stopped"),
        usageLimitResetAt: previousAttempt.resetAt,
        providerInstanceId: ProviderInstanceId.make("provider-codex-stopped"),
        limitRecovery: {
          runId: RunId.make("run:limited-stopped"),
          resetAt: previousAttempt.resetAt,
          autoResume: false,
          codexResetRedemption: {
            providerInstanceId: ProviderInstanceId.make("provider-codex-stopped"),
            redeemedByProviderInstanceId: ProviderInstanceId.make("provider-codex-stopped"),
            accountFingerprint: fingerprint,
            idempotencyKey: previousAttempt.idempotencyKey,
            attemptedAt,
            creditsBefore: 1,
            outcome: "pending" as const,
            allowanceCleared: false,
          },
        },
      };
      const candidates = [stoppedThread, thread].filter(
        (candidate) => candidate.limitRecovery?.autoResume === true,
      );
      const provider = {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        usageLimits: {
          credentialFingerprint: fingerprint,
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          windows: [],
          resetCredits: { availableCount: 1 },
        },
      } as unknown as ServerProvider;
      const refreshes = yield* Ref.make(0);
      const consumes = yield* Ref.make(0);
      const layer = Layer.mergeAll(
        Layer.succeed(ProjectionStore.ProjectionStoreV2, {
          getLimitRecoveryCandidates: () => Effect.succeed(candidates),
          getLimitRecoveryWakeAt: () => Effect.succeed(nowMs + 5 * HOUR_MS),
          getCodexResetAttempt: () => Ref.get(previousAttemptRef),
          claimCodexResetAttempt: (attempt: ProjectionStore.CodexResetAttempt) =>
            Ref.set(previousAttemptRef, attempt).pipe(Effect.as(true)),
          updateCodexResetAttempt: (attempt: ProjectionStore.CodexResetAttempt) =>
            Ref.set(previousAttemptRef, attempt),
        } as never),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          dispatch: () => Effect.succeed({ sequence: 1, storedEvents: [] }),
        }),
        Layer.mock(Orchestrator.OrchestratorV2)({
          streamDomainEvents: Stream.never,
          recordCodexResetRedemption: () => Effect.succeed(true),
        }),
        Layer.mock(ServerSettings.ServerSettingsService)({
          getSettings: Effect.succeed({
            autoResumeLimitedThreads: true,
            snoozeLimitedThreads: false,
            autoRedeemCodexResetCredits: { [instanceId]: true },
          } as never),
          streamChanges: Stream.never,
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([provider]),
          refreshInstance: () =>
            Ref.updateAndGet(refreshes, (count) => count + 1).pipe(Effect.as([provider])),
          supportsAutoRedeemResetCredit: () => Effect.succeed(true),
          autoRedeemResetCredit: (input) =>
            Ref.updateAndGet(consumes, (count) => count + 1).pipe(
              Effect.as({
                status: "sent",
                accountFingerprint: fingerprint,
                creditsBefore: 1,
                outcome: "reset",
                allowanceCleared: true,
                idempotencyKey: input.idempotencyKey,
              } as const),
            ),
        }),
      );
      const sweep = yield* UsageLimitRecoveryWorker.makeSweep.pipe(Effect.provide(layer));
      yield* sweep();
      assert.strictEqual(yield* Ref.get(refreshes), 0);
      assert.strictEqual(yield* Ref.get(consumes), 1);
      assert.strictEqual(
        (yield* Ref.get(previousAttemptRef)).idempotencyKey,
        outcome === "pending"
          ? previousAttempt.idempotencyKey
          : UsageLimitRecoveryWorker.codexAutoResetIdempotencyKey(
              fingerprint,
              thread.usageLimitResetAt!,
            ),
      );

      // The stopped thread is absent from candidates; a fresh worker relies on the account ledger.
      const restartedSweep = yield* UsageLimitRecoveryWorker.makeSweep.pipe(Effect.provide(layer));
      yield* restartedSweep();
      assert.strictEqual(yield* Ref.get(refreshes), 0);
      assert.strictEqual(yield* Ref.get(consumes), 1);
    }),
);

it.effect("idle sweeps skip SQL until the next wake time or a relevant event", () =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse("2026-07-01T09:00:00.000Z"));
    const startMs = Date.parse("2026-07-01T09:00:00.000Z");
    const queries = yield* Queue.unbounded<number>();
    const events = yield* Queue.unbounded<OrchestrationV2DomainEvent>();
    const layer = UsageLimitRecoveryWorker.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Scheduler.layer,
          Layer.mock(ProjectionStore.ProjectionStoreV2)({
            getLimitRecoveryCandidates: () =>
              Clock.currentTimeMillis.pipe(
                Effect.flatMap((nowMs) => Queue.offer(queries, nowMs - startMs)),
                Effect.as([]),
              ),
            // One armed thread resets at 60s.
            getLimitRecoveryWakeAt: (now) =>
              Effect.succeed(
                DateTime.toEpochMillis(now) < startMs + 60_000 ? startMs + 60_000 : null,
              ),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({}),
          Layer.mock(Orchestrator.OrchestratorV2)({
            streamDomainEvents: Stream.fromQueue(events),
          }),
          Layer.mock(ServerSettings.ServerSettingsService)({
            getSettings: Effect.succeed({
              autoResumeLimitedThreads: true,
              snoozeLimitedThreads: false,
            } as never),
            streamChanges: Stream.never,
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({}),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      assert.equal(yield* Queue.take(queries), 0);
      // Eleven idle ticks before the recorded wake time, then the wake tick itself.
      yield* TestClock.adjust("60 seconds");
      assert.equal(yield* Queue.take(queries), 60_000);
      yield* Queue.offer(events, {
        type: "turn-item.updated",
        payload: { type: "assistant_message" },
      } as never);
      yield* TestClock.adjust("30 seconds");
      yield* Queue.offer(events, { type: "run.updated", payload: { status: "failed" } } as never);
      yield* TestClock.adjust("5 seconds");
      // A streaming item at 90s does not wake it; the failed run does on the 95s tick.
      assert.equal(yield* Queue.take(queries), 95_000);
    }).pipe(Effect.provide(layer));
  }),
);

const HOUR_MS = 60 * 60 * 1000;
const nowMs = Date.parse("2026-10-19T12:00:00.000Z");

const failedThread = (failedAgoMs: number, resetAgoMs: number) => {
  const failedAt = DateTime.makeUnsafe(nowMs - failedAgoMs);
  const candidate: ProjectionStore.ProjectionLimitRecoveryCandidate = {
    id: ThreadId.make("thread:limited"),
    providerInstanceId: ProviderInstanceId.make("provider-codex"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("provider-codex"),
      model: "gpt-5-codex",
    },
    status: "failed",
    lastErrorClass: "usage_limit",
    usageLimitResetAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - resetAgoMs)),
    latestRunId: RunId.make("run:limited"),
    latestRunCompletedAt: failedAt,
    updatedAt: failedAt,
    archivedAt: null,
    settledOverride: null,
    pendingRuntimeRequest: null,
    limitRecovery: null,
    snoozedUntil: null,
  };
  return candidate;
};

describe("limitRecoveryCommand arming", () => {
  it("does not freshly arm a failure whose reset passed days ago", () => {
    const thread = failedThread(5 * 24 * HOUR_MS, 4 * 24 * HOUR_MS);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, true));
  });

  it("still arms a failure whose reset only just passed", () => {
    const thread = failedThread(6 * HOUR_MS, HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("arms a reset that is exactly 24 hours overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS);
    const arm = limitRecoveryCommand(thread, true, nowMs);
    assert.equal(arm?.type, "thread.metadata.update");
  });

  it("does not arm a reset that is 24 hours and 1ms overdue", () => {
    const thread = failedThread(30 * HOUR_MS, 24 * HOUR_MS + 1);
    assert.isNull(limitRecoveryCommand(thread, true, nowMs));
  });

  it("resumes early only for a confirmed reset on the opted-in account", () => {
    const base = failedThread(HOUR_MS, -HOUR_MS);
    const thread = {
      ...base,
      limitRecovery: {
        runId: RunId.make("run:limited"),
        resetAt: base.usageLimitResetAt!,
        autoResume: true,
        snooze: false,
        codexResetRedemption: {
          providerInstanceId: base.providerInstanceId,
          redeemedByProviderInstanceId: base.providerInstanceId,
          accountFingerprint: "account-fingerprint",
          idempotencyKey: "retry-key",
          attemptedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs - 1_000)),
          creditsBefore: 1,
          outcome: "reset" as const,
          checkedAt: DateTime.formatIso(DateTime.makeUnsafe(nowMs)),
          allowanceCleared: true,
        },
      },
    };

    assert.equal(
      limitRecoveryCommand(thread, true, nowMs, false, true, true)?.type,
      "message.dispatch",
    );
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, false, true));
    assert.isNull(limitRecoveryCommand(thread, true, nowMs, false, false));
    const redemption = thread.limitRecovery.codexResetRedemption;
    assert.isNotNull(redemption);
    for (const outcome of ["pending", "unconfirmed", "noCredit", "nothingToReset"] as const) {
      assert.isNull(
        limitRecoveryCommand(
          {
            ...thread,
            limitRecovery: {
              ...thread.limitRecovery,
              codexResetRedemption: { ...redemption, outcome },
            },
          },
          true,
          nowMs,
          false,
          true,
          true,
        ),
      );
    }
    assert.isNull(
      limitRecoveryCommand(
        {
          ...thread,
          limitRecovery: {
            ...thread.limitRecovery,
            codexResetRedemption: { ...redemption, outcome: "noCredit" },
          },
        },
        true,
        nowMs,
        false,
        true,
      ),
    );
    assert.isNull(
      limitRecoveryCommand(
        {
          ...thread,
          limitRecovery: {
            ...thread.limitRecovery,
            codexResetRedemption: { ...redemption, allowanceCleared: false },
          },
        },
        true,
        nowMs,
        false,
        true,
      ),
    );
    assert.isNull(
      limitRecoveryCommand(
        {
          ...thread,
          limitRecovery: {
            ...thread.limitRecovery,
            codexResetRedemption: { ...redemption, checkedAt: redemption.attemptedAt },
          },
        },
        true,
        nowMs,
        false,
        true,
        true,
      ),
    );
    assert.isNull(
      limitRecoveryCommand(
        {
          ...thread,
          limitRecovery: {
            ...thread.limitRecovery,
            codexResetRedemption: {
              ...redemption,
              providerInstanceId: ProviderInstanceId.make("provider-other"),
            },
          },
        },
        true,
        nowMs,
        false,
        true,
        true,
      ),
    );
  });

  it("reuses the same account-window idempotency key across threads and instances", () => {
    const resetAt = "2026-10-19T13:00:00.000Z";
    const first = UsageLimitRecoveryWorker.codexAutoResetIdempotencyKey("shared-account", resetAt);
    const retry = UsageLimitRecoveryWorker.codexAutoResetIdempotencyKey("shared-account", resetAt);
    assert.strictEqual(first, retry);
    assert.notStrictEqual(
      first,
      UsageLimitRecoveryWorker.codexAutoResetIdempotencyKey("other-account", resetAt),
    );
    assert.notStrictEqual(
      first,
      UsageLimitRecoveryWorker.codexAutoResetIdempotencyKey(
        "shared-account",
        "2026-10-19T14:00:00.000Z",
      ),
    );
  });
});

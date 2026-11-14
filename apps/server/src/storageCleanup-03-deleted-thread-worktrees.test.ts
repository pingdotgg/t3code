import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Path from "effect/Path";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { SCAN_CACHE_FILE_NAME } from "./usage/usageScanCache.ts";
import { TestClock } from "effect/testing";
import * as SqlClient from "effect/sql/SqlClient";
import {
  DEFAULT_SERVER_SETTINGS,
  type WorktreeKeepWhen,
  type StorageCleanupSettings,
  type TerminalMetadataStreamEvent,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as ServerConfig from "./config.ts";
import * as StorageCleanup from "./storageCleanup.ts";
import * as GitVcsDriver from "./vcs/GitVcsDriver.ts";
import * as GitManager from "./git/GitManager.ts";
import * as Settings from "./serverSettings.ts";
import * as ProjectionStore from "./orchestration-v2/ProjectionStore.ts";
import * as ProviderSessionManager from "./orchestration-v2/ProviderSessionManager.ts";
import * as ProjectStore from "./orchestration-v2/ProjectStore.ts";
import * as Orchestrator from "./orchestration-v2/Orchestrator.ts";
import * as TerminalManager from "./terminal/Manager.ts";
import { CodexProviderCapabilitiesV2 } from "./orchestration-v2/Adapters/CodexAdapterV2.ts";
import { ServerActivation } from "./serverActivation.ts";
import { describe, expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  RunId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import {
  storageCleanupActivityAt,
  storageCleanupPullRequestMerged,
  storageCleanupThreadIdle,
} from "./storageCleanup.ts";














import { NOW_MS, DAY_MS, at, shell, allocatedBytes, cleanupFixture, pausedMeasurementFixture, cleanupTestLayer, runCleanupTest } from "./storageCleanup-fixtures.testkit.ts";
describe("deleted thread worktrees", () => {
  const parent = (worktreePath: string) =>
    shell({ branch: "feature", worktreePath, deletedAt: at(-DAY_MS) });
  // Deleting the parent leaves its native subagent thread in the projection.
  const subagent = (
    owner: OrchestrationV2ThreadShell,
    overrides: Partial<OrchestrationV2ThreadShell> = {},
  ) =>
    shell({
      id: ThreadId.make("child"),
      title: "Subagent",
      branch: "feature",
      worktreePath: owner.worktreePath,
      status: "completed",
      createdBy: "agent",
      creationSource: "provider",
      lineage: {
        rootThreadId: owner.id,
        parentThreadId: owner.id,
        relationshipToParent: "subagent",
      },
      ...overrides,
    });

  it.effect.each(["no subagents", "native subagent"] as const)(
    "removes a deleted thread's worktree with %s",
    (scenario) =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setDeletedThreads([owner]);
        fixture.setThreads(scenario === "native subagent" ? [subagent(owner)] : []);
        const report = yield* fixture.service.runNow;
        expect(report.entries[0]).toMatchObject({
          threadId: owner.id,
          outcome: "removed",
          reason: "Thread was deleted",
        });
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("applies the remaining subagent's rules when deletion cleanup is off", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: 8,
        worktreeOnDelete: false,
      });
      const owner = parent(fixture.worktree);
      const child = subagent(owner);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([child]);
      const report = yield* fixture.service.runNow;
      expect(report.entries[0]).toMatchObject({
        threadId: child.id,
        outcome: "removed",
        reason: "Inactive for 30 days",
      });
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  // Releases one stopped-session event after the startup sweep and returns the snapshot reads it caused.
  const stopSessionAfterStartupSweep = (
    fixture: Effect.Success<ReturnType<typeof cleanupFixture>>,
    threadId: ThreadId,
    beforeStop: Effect.Effect<void> = Effect.void,
    cwd = fixture.worktree,
  ) =>
    Effect.gen(function* () {
      const startupSwept = yield* Deferred.make<void>();
      const delivered = yield* Deferred.make<void>();
      const stopped: OrchestrationV2DomainEvent = {
        id: EventId.make("event:session-stopped"),
        type: "provider-session.updated",
        threadId,
        occurredAt: at(0),
        payload: {
          id: ProviderSessionId.make("session-1"),
          driver: ProviderDriverKind.make("codex"),
          providerInstanceId: ProviderInstanceId.make("codex"),
          status: "stopped",
          cwd,
          model: null,
          capabilities: CodexProviderCapabilitiesV2,
          createdAt: at(-DAY_MS),
          updatedAt: at(0),
          lastError: null,
        },
      };
      yield* fixture.activate(
        Stream.fromEffect(Deferred.await(startupSwept)).pipe(
          Stream.flatMap(() => Stream.make(stopped)),
          Stream.concat(
            Stream.fromEffect(Deferred.succeed(delivered, undefined)).pipe(Stream.drain),
          ),
        ),
      );
      yield* fixture.service.reports.pipe(
        Stream.filter((report) => report !== null),
        Stream.take(1),
        Stream.runDrain,
      );
      yield* fixture.service.drain;
      yield* beforeStop;
      const readsBefore = fixture.snapshotReads();
      yield* Deferred.succeed(startupSwept, undefined);
      yield* Deferred.await(delivered);
      yield* fixture.service.drain;
      return fixture.snapshotReads() - readsBefore;
    });

  it.effect("does not sweep when a live thread's session stops and no deleted worktree waits", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture();
      const reads = yield* stopSessionAfterStartupSweep(fixture, ThreadId.make("thread-1"));
      expect(reads, "a live thread's stopped session re-read every thread").toBe(0);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("removes a deleted thread's worktree once its session stops", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      const owner = parent(fixture.worktree);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([]);
      fixture.setOpenSessionCwd(fixture.worktree);
      const reads = yield* stopSessionAfterStartupSweep(
        fixture,
        owner.id,
        Effect.sync(() => fixture.setSessionLive(false)),
      );
      expect(reads).toBeGreaterThan(0);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("removes a deleted thread's worktree once a live thread's session in it stops", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      const owner = parent(fixture.worktree);
      const child = subagent(owner);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([child]);
      fixture.setOpenSessionCwd(fixture.worktree);
      const reads = yield* stopSessionAfterStartupSweep(
        fixture,
        child.id,
        Effect.gen(function* () {
          expect((yield* fixture.service.latestReport)?.entries[0]).toMatchObject({
            threadId: owner.id,
            outcome: "kept",
            reason: "Provider session is still open",
          });
          fixture.setSessionLive(false);
        }),
      );
      expect(reads).toBeGreaterThan(0);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect(
    "removes a deleted thread's worktree once its terminal closes and its session stops",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setDeletedThreads([owner]);
        fixture.setThreads([]);
        yield* fixture.setTerminals([
          {
            threadId: owner.id,
            terminalId: "terminal-1",
            cwd: fixture.worktree,
            worktreePath: fixture.worktree,
            status: "running",
            pid: 1,
            exitCode: null,
            exitSignal: null,
            hasRunningSubprocess: false,
            label: "Terminal",
            updatedAt: DateTime.formatIso(at(0)),
          },
        ]);
        const reads = yield* stopSessionAfterStartupSweep(
          fixture,
          owner.id,
          Effect.gen(function* () {
            expect((yield* fixture.service.latestReport)?.entries[0]).toMatchObject({
              threadId: owner.id,
              outcome: "kept",
              reason: "Open terminal",
            });
            yield* fixture.setTerminals([]);
          }),
          fixture.repo,
        );
        expect(reads).toBeGreaterThan(0);
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect(
    "retries a deleted thread's worktree kept for another reason when a session in it stops",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setDeletedThreads([owner]);
        fixture.setThreads([]);
        yield* fixture.fs.writeFileString(`${fixture.worktree}/tracked.txt`, "agent edit\n");
        const reads = yield* stopSessionAfterStartupSweep(
          fixture,
          owner.id,
          Effect.gen(function* () {
            expect((yield* fixture.service.latestReport)?.entries[0]).toMatchObject({
              threadId: owner.id,
              outcome: "kept",
              reason: "Has uncommitted changes (1 file)",
            });
            yield* fixture.fs
              .writeFileString(`${fixture.worktree}/tracked.txt`, "original\n")
              .pipe(Effect.orDie);
          }),
        );
        expect(reads).toBeGreaterThan(0);
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("does not sweep for a kept deleted worktree when a session elsewhere stops", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      fixture.setDeletedThreads([parent(fixture.worktree)]);
      fixture.setThreads([]);
      yield* fixture.fs.writeFileString(`${fixture.worktree}/tracked.txt`, "agent edit\n");
      const reads = yield* stopSessionAfterStartupSweep(
        fixture,
        ThreadId.make("thread-elsewhere"),
        Effect.void,
        fixture.repo,
      );
      expect(reads).toBe(0);
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect(
    "does not sweep for a deleted thread whose cleanup effect failed when a session elsewhere stops",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setDeletedThreads([owner]);
        fixture.setThreads([]);
        fixture.setOutboxStatus("failed");
        const reads = yield* stopSessionAfterStartupSweep(
          fixture,
          ThreadId.make("thread-elsewhere"),
          Effect.gen(function* () {
            expect((yield* fixture.service.latestReport)?.entries[0]).toMatchObject({
              threadId: owner.id,
              outcome: "kept",
              reason: "Thread deletion is still pending",
            });
          }),
          fixture.repo,
        );
        expect(reads).toBe(0);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect(
    "removes a deleted thread's worktree when its session stops during the deletion's sweep",
    () =>
      Effect.gen(function* () {
        yield* TestClock.setTime(NOW_MS);
        const fixture = yield* cleanupFixture({
          ...DEFAULT_SERVER_SETTINGS.storageCleanup,
          worktreeAfterDays: null,
          worktreeOnDelete: true,
        });
        const owner = parent(fixture.worktree);
        fixture.setThreads([]);
        const startupSwept = yield* Deferred.make<void>();
        const sessionChecked = yield* Deferred.make<void>();
        const delivered = yield* Deferred.make<void>();
        const deleted = {
          id: EventId.make("event:thread-deleted"),
          type: "thread.deleted",
          threadId: owner.id,
          occurredAt: at(0),
          payload: owner,
        } as unknown as OrchestrationV2DomainEvent;
        const stopped: OrchestrationV2DomainEvent = {
          id: EventId.make("event:session-stopped"),
          type: "provider-session.updated",
          threadId: owner.id,
          occurredAt: at(0),
          payload: {
            id: ProviderSessionId.make("session-1"),
            driver: ProviderDriverKind.make("codex"),
            providerInstanceId: ProviderInstanceId.make("codex"),
            status: "stopped",
            cwd: fixture.worktree,
            model: null,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: at(-DAY_MS),
            updatedAt: at(0),
            lastError: null,
          },
        };
        yield* fixture.activate(
          Stream.fromEffect(Deferred.await(startupSwept)).pipe(
            Stream.flatMap(() => Stream.make(deleted)),
            Stream.concat(Stream.fromEffect(Deferred.await(sessionChecked)).pipe(Stream.drain)),
            Stream.concat(Stream.make(stopped)),
            Stream.concat(
              Stream.fromEffect(Deferred.succeed(delivered, undefined)).pipe(Stream.drain),
            ),
          ),
        );
        yield* fixture.service.reports.pipe(
          Stream.filter((report) => report !== null),
          Stream.take(1),
          Stream.runDrain,
        );
        yield* fixture.service.drain;
        fixture.setDeletedThreads([owner]);
        fixture.setOpenSessionCwd(fixture.worktree);
        // The deletion's sweep sees the session live; it stops before that sweep publishes its result.
        fixture.setOnLiveCheck(
          Effect.gen(function* () {
            fixture.setOnLiveCheck(Effect.void);
            yield* Deferred.succeed(sessionChecked, undefined);
            yield* Deferred.await(delivered);
            fixture.setSessionLive(false);
          }),
        );
        yield* Deferred.succeed(startupSwept, undefined);
        yield* Deferred.await(delivered);
        yield* fixture.service.drain;
        expect(yield* fixture.fs.exists(fixture.worktree)).toBe(false);
      }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );

  it.effect("waits out the settle grace of a subagent that just settled", () =>
    Effect.gen(function* () {
      yield* TestClock.setTime(NOW_MS);
      const fixture = yield* cleanupFixture({
        ...DEFAULT_SERVER_SETTINGS.storageCleanup,
        worktreeAfterDays: null,
        worktreeOnDelete: true,
      });
      const owner = parent(fixture.worktree);
      fixture.setDeletedThreads([owner]);
      fixture.setThreads([subagent(owner, { settledAt: at(0), updatedAt: at(0) })]);
      const report = yield* fixture.service.runNow;
      expect(report.entries[0]).toMatchObject({
        threadId: owner.id,
        outcome: "kept",
        reason: "Settled moments ago",
      });
      expect(yield* fixture.fs.exists(fixture.worktree)).toBe(true);
    }).pipe(Effect.provide(cleanupTestLayer), Effect.scoped),
  );
});

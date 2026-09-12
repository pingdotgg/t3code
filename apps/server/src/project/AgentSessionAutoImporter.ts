import {
  CommandId,
  ProjectId,
  initialAgentSessionAutoImportStatus,
  type AgentSessionAutoImportStatus,
  type AgentSessionImportWindow,
  type AgentSessionProjectCandidate,
} from "@t3tools/contracts";
import { makeDrainableWorker, type DrainableWorker } from "@t3tools/shared/DrainableWorker";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import * as OrchestrationEngine from "../orchestration/Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as ProviderSessionDirectory from "../provider/Services/ProviderSessionDirectory.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import { importRecentAgentThreads } from "./AgentSessionImporter.ts";
import * as AgentSessionScanner from "./AgentSessionScanner.ts";

export class AgentSessionAutoImporter extends Context.Service<
  AgentSessionAutoImporter,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly runNow: Effect.Effect<AgentSessionAutoImportStatus>;
    readonly status: Effect.Effect<AgentSessionAutoImportStatus>;
    readonly streamStatus: Stream.Stream<AgentSessionAutoImportStatus>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/project/AgentSessionAutoImporter") {}

/** Window widening order for the settings trigger: 30d < 90d < 1y < all. */
const windowRank = (window: AgentSessionImportWindow): number => {
  switch (window) {
    case "30d":
      return 0;
    case "90d":
      return 1;
    case "1y":
      return 2;
    case "all":
      return 3;
  }
};

export const make = Effect.gen(function* () {
  const scanner = yield* AgentSessionScanner.AgentSessionScanner;
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const directory = yield* ProviderSessionDirectory.ProviderSessionDirectory;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const crypto = yield* Crypto.Crypto;

  const statusRef = yield* SubscriptionRef.make<AgentSessionAutoImportStatus>(
    initialAgentSessionAutoImportStatus,
  );
  const runSemaphore = yield* Semaphore.make(1);
  const isRunning = yield* Ref.make(false);
  const isQueued = yield* Ref.make(false);
  const rerunRequested = yield* Ref.make(false);

  // importRecentAgentThreads reads its dependencies from context. The
  // auto-importer holds them all, so provide them here instead of at call sites.
  const runImport = (input: {
    readonly projectId: ProjectId;
    readonly expectedWorkspaceRoot: AgentSessionProjectCandidate["path"];
  }) =>
    importRecentAgentThreads(input).pipe(
      Effect.provideService(AgentSessionScanner.AgentSessionScanner, scanner),
      Effect.provideService(OrchestrationEngine.OrchestrationEngineService, engine),
      Effect.provideService(ProjectionSnapshotQuery.ProjectionSnapshotQuery, snapshots),
      Effect.provideService(ProviderSessionDirectory.ProviderSessionDirectory, directory),
      Effect.provideService(Crypto.Crypto, crypto),
      Effect.provideService(ServerSettings.ServerSettingsService, settingsService),
    );

  // Resolve a scan candidate to a project, creating one when needed. Returns
  // null when the candidate must be skipped; never fails the run except on
  // interruption.
  const projectForCandidate = Effect.fn("AgentSessionAutoImporter.projectForCandidate")(function* (
    candidate: AgentSessionProjectCandidate,
  ) {
    if (candidate.alreadyImported && candidate.projectId !== undefined) {
      return { projectId: candidate.projectId, path: candidate.path, created: false as const };
    }
    const dispatchExit = yield* Effect.exit(
      Effect.gen(function* () {
        const projectId = ProjectId.make(yield* crypto.randomUUIDv4);
        yield* engine.dispatch({
          type: "project.create",
          commandId: CommandId.make(yield* crypto.randomUUIDv4),
          projectId,
          title: candidate.title,
          workspaceRoot: candidate.path,
          createWorkspaceRootIfMissing: false,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        return projectId;
      }),
    );
    if (dispatchExit._tag === "Success") {
      return { projectId: dispatchExit.value, path: candidate.path, created: true as const };
    }
    if (Cause.hasInterruptsOnly(dispatchExit.cause)) {
      return yield* Effect.interrupt;
    }
    // A project.create that loses the duplicate-root race (or a root the
    // scan snapshot missed) leaves a usable project behind. Re-read the
    // shell snapshot and reuse it instead of failing the run.
    const snapshotExit = yield* Effect.exit(snapshots.getShellSnapshot());
    if (snapshotExit._tag === "Success") {
      const existing = snapshotExit.value.projects.find(
        (project) =>
          normalizeProjectPathForComparison(project.workspaceRoot) ===
          normalizeProjectPathForComparison(candidate.path),
      );
      if (existing !== undefined) {
        return { projectId: existing.id, path: candidate.path, created: false as const };
      }
    } else if (Cause.hasInterruptsOnly(snapshotExit.cause)) {
      return yield* Effect.interrupt;
    }
    // Anything else (excluded or unreadable path, snapshot failure) skips
    // the candidate without failing the run.
    yield* Effect.logWarning("agent session auto-import skipped a project candidate", {
      path: candidate.path,
      cause: Cause.pretty(dispatchExit.cause),
    });
    return null;
  });

  // Drain one project's backlog. importRecentAgentThreads applies the settings
  // window on each pass (no explicit window is passed), so repeat until the
  // result reports nothing left or a pass makes no progress.
  const importProjectHistory = Effect.fn("AgentSessionAutoImporter.importProjectHistory")(
    function* (target: {
      readonly projectId: ProjectId;
      readonly path: AgentSessionProjectCandidate["path"];
    }) {
      let imported = 0;
      let skipped = 0;
      let previousRemaining: number | null = null;
      while (true) {
        const result = yield* runImport({
          projectId: target.projectId,
          expectedWorkspaceRoot: target.path,
        }).pipe(
          // catch handles typed failures only; defects and interrupts pass
          // through (defects fail the run via performRun's exit, interrupts
          // propagate to the fiber).
          Effect.catch((error) =>
            Effect.logWarning("agent session auto-import skipped a project import", {
              projectId: target.projectId,
              path: target.path,
              cause: error,
            }).pipe(Effect.as(null)),
          ),
        );
        if (result === null) break;
        imported += result.importedCount;
        skipped += result.skippedCount;
        if (result.remainingCount === 0) break;
        if (
          result.importedCount === 0 &&
          previousRemaining !== null &&
          result.remainingCount >= previousRemaining
        ) {
          break;
        }
        previousRemaining = result.remainingCount;
      }
      return { imported, skipped };
    },
  );

  const performRun = Effect.fn("AgentSessionAutoImporter.performRun")(function* () {
    const startedAt = DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.set(statusRef, {
      ...initialAgentSessionAutoImportStatus,
      state: "scanning",
      startedAt,
    });
    const exit = yield* runSemaphore
      .withPermits(1)(
        Effect.gen(function* () {
          // A fresh scan refreshes the scanner's memoized candidates, so this
          // run and every recentThreads call below see current transcripts.
          const scanResult = yield* scanner.scan;
          let projectsCreated = 0;
          const targets: Array<{
            readonly projectId: ProjectId;
            readonly path: AgentSessionProjectCandidate["path"];
          }> = [];
          for (const candidate of scanResult.candidates) {
            const target = yield* projectForCandidate(candidate);
            if (target === null) continue;
            if (target.created) projectsCreated += 1;
            targets.push(target);
          }
          yield* SubscriptionRef.set(statusRef, {
            ...initialAgentSessionAutoImportStatus,
            state: "importing",
            startedAt,
            projectsCreated,
          });
          let threadsImported = 0;
          let threadsSkipped = 0;
          for (const target of targets) {
            const counts = yield* importProjectHistory(target);
            threadsImported += counts.imported;
            threadsSkipped += counts.skipped;
          }
          return { projectsCreated, threadsImported, threadsSkipped };
        }),
      )
      .pipe(Effect.exit);
    if (exit._tag === "Success") {
      const finishedAt = DateTime.formatIso(yield* DateTime.now);
      yield* SubscriptionRef.set(statusRef, {
        ...initialAgentSessionAutoImportStatus,
        state: "completed",
        startedAt,
        finishedAt,
        projectsCreated: exit.value.projectsCreated,
        threadsImported: exit.value.threadsImported,
        threadsSkipped: exit.value.threadsSkipped,
      });
      yield* Effect.logInfo("agent session auto-import completed", {
        projectsCreated: exit.value.projectsCreated,
        threadsImported: exit.value.threadsImported,
        threadsSkipped: exit.value.threadsSkipped,
      });
      return;
    }
    if (Cause.hasInterruptsOnly(exit.cause)) {
      return yield* Effect.interrupt;
    }
    const finishedAt = DateTime.formatIso(yield* DateTime.now);
    const error = Cause.pretty(exit.cause);
    yield* SubscriptionRef.set(statusRef, {
      ...initialAgentSessionAutoImportStatus,
      state: "failed",
      startedAt,
      finishedAt,
      error,
    });
    yield* Effect.logWarning("agent session auto-import failed", { cause: error });
  });

  const worker: DrainableWorker<void> = yield* makeDrainableWorker<void, never, never>(() =>
    Effect.gen(function* () {
      yield* Ref.set(isQueued, false);
      yield* Ref.set(isRunning, true);
      yield* Effect.gen(function* () {
        // Triggers arriving mid-run only set rerunRequested, so a burst of
        // triggers coalesces into exactly one follow-up run.
        let followUp = true;
        while (followUp) {
          yield* Ref.set(rerunRequested, false);
          yield* performRun();
          followUp = yield* Ref.getAndSet(rerunRequested, false);
        }
      }).pipe(
        Effect.ensuring(
          Effect.gen(function* () {
            yield* Ref.set(isRunning, false);
            // A trigger that landed after the final flag check already set
            // rerunRequested; re-enqueue so the run is not lost.
            if (yield* Ref.getAndSet(rerunRequested, false)) {
              yield* worker.enqueue(undefined);
            }
          }),
        ),
      );
    }),
  );

  const requestRun = Effect.gen(function* () {
    if (yield* Ref.get(isRunning)) {
      yield* Ref.set(rerunRequested, true);
    } else if (!(yield* Ref.getAndSet(isQueued, true))) {
      yield* worker.enqueue(undefined);
    }
  });

  const start: AgentSessionAutoImporter["Service"]["start"] = Effect.fn(
    "AgentSessionAutoImporter.start",
  )(function* () {
    // Subscribe before reading so a change between the snapshot and the
    // stream below cannot be lost.
    const settingsChanges = yield* settingsService.subscribeChanges;
    const initialSettings = yield* settingsService.getSettings.pipe(Effect.orDie);
    let lastEnabled = initialSettings.agentSessionAutoImport;
    let lastWindow = initialSettings.agentSessionImportWindow;
    const seenAuthenticated = new Map<string, boolean>();

    // Startup: run once when the toggle is on. Parked so server boot never waits.
    yield* forkParked(
      Effect.gen(function* () {
        yield* settingsService.ready.pipe(Effect.orDie);
        const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
        lastEnabled = settings.agentSessionAutoImport;
        lastWindow = settings.agentSessionImportWindow;
        if (settings.agentSessionAutoImport) {
          yield* requestRun;
        }
      }),
    );

    // Provider auth: when a claudeAgent/codex instance becomes authenticated
    // (the first snapshot counts), request a run if the toggle is on.
    // Debounced latest-wins so a burst of snapshots yields one run.
    // ProviderRegistry exposes only streamChanges (no subscribeChanges).
    yield* forkParked(
      providerRegistry.streamChanges.pipe(
        Stream.debounce(Duration.seconds(2)),
        Stream.runForEach((providers) =>
          Effect.gen(function* () {
            let becameAuthenticated = false;
            const currentIds = new Set<string>();
            for (const provider of providers) {
              if (provider.driver !== "claudeAgent" && provider.driver !== "codex") continue;
              currentIds.add(provider.instanceId);
              const authenticated = provider.auth.status === "authenticated";
              if (authenticated && seenAuthenticated.get(provider.instanceId) !== true) {
                becameAuthenticated = true;
              }
              seenAuthenticated.set(provider.instanceId, authenticated);
            }
            for (const instanceId of Array.from(seenAuthenticated.keys())) {
              if (!currentIds.has(instanceId)) seenAuthenticated.delete(instanceId);
            }
            if (!becameAuthenticated) return;
            const settings = yield* settingsService.getSettings.pipe(Effect.orDie);
            if (settings.agentSessionAutoImport) {
              yield* requestRun;
            }
          }),
        ),
      ),
    );

    // Settings: run when the toggle flips false->true or the window widens.
    yield* forkParked(
      Stream.runForEach(settingsChanges, (settings) =>
        Effect.gen(function* () {
          const flipped = !lastEnabled && settings.agentSessionAutoImport;
          const widened = windowRank(settings.agentSessionImportWindow) > windowRank(lastWindow);
          lastEnabled = settings.agentSessionAutoImport;
          lastWindow = settings.agentSessionImportWindow;
          if (settings.agentSessionAutoImport && (flipped || widened)) {
            yield* requestRun;
          }
        }),
      ),
    );
  });

  return {
    start,
    // Manual trigger. Ignores the enabled toggle; returns the current status
    // immediately without waiting for the run.
    runNow: Effect.gen(function* () {
      yield* requestRun;
      return yield* SubscriptionRef.get(statusRef);
    }),
    status: SubscriptionRef.get(statusRef),
    // SubscriptionRef.changes replays the current value first, then every change.
    streamStatus: SubscriptionRef.changes(statusRef),
    // The worker decrements its outstanding count only after the run's final
    // status is published, so drain resolves after the status is visible.
    drain: worker.drain,
  } satisfies AgentSessionAutoImporter["Service"];
});

export const layer = Layer.effect(AgentSessionAutoImporter, make);

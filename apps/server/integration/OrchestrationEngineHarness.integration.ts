import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { Effect, Exit, Layer, ManagedRuntime, Option, Schedule, Scope, Stream } from "effect";

import { CheckpointStoreLive } from "../src/checkpointing/Layers/CheckpointStore.ts";
import { CheckpointStore } from "../src/checkpointing/Services/CheckpointStore.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../src/persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../src/persistence/Layers/OrchestrationEventStore.ts";
import { ProjectionCheckpointRepositoryLive } from "../src/persistence/Layers/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepositoryLive } from "../src/persistence/Layers/ProjectionPendingApprovals.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../src/persistence/Layers/ProviderSessionRuntime.ts";
import { makeSqlitePersistenceLive } from "../src/persistence/Layers/Sqlite.ts";
import { ProjectionCheckpointRepository } from "../src/persistence/Services/ProjectionCheckpoints.ts";
import { ProjectionPendingApprovalRepository } from "../src/persistence/Services/ProjectionPendingApprovals.ts";
import { ProviderUnsupportedError } from "../src/provider/Errors.ts";
import { ProviderAdapterRegistry } from "../src/provider/Services/ProviderAdapterRegistry.ts";
import { ProviderSessionDirectoryLive } from "../src/provider/Layers/ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "../src/provider/Layers/ProviderService.ts";
import { ProviderService } from "../src/provider/Services/ProviderService.ts";
import { CheckpointReactorLive } from "../src/orchestration/Layers/CheckpointReactor.ts";
import { OrchestrationEngineLive } from "../src/orchestration/Layers/OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "../src/orchestration/Layers/ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "../src/orchestration/Layers/ProjectionSnapshotQuery.ts";
import { OrchestrationReactorLive } from "../src/orchestration/Layers/OrchestrationReactor.ts";
import { ProviderCommandReactorLive } from "../src/orchestration/Layers/ProviderCommandReactor.ts";
import { ProviderRuntimeIngestionLive } from "../src/orchestration/Layers/ProviderRuntimeIngestion.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../src/orchestration/Services/OrchestrationEngine.ts";
import { OrchestrationReactor } from "../src/orchestration/Services/OrchestrationReactor.ts";
import { ProjectionSnapshotQuery } from "../src/orchestration/Services/ProjectionSnapshotQuery.ts";

import {
  makeTestProviderAdapterHarness,
  type TestProviderAdapterHarness,
} from "./TestProviderAdapter.integration.ts";

function runGit(cwd: string, args: ReadonlyArray<string>) {
  return execFileSync("git", args, {
    cwd,
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
}

function initializeGitWorkspace(cwd: string) {
  runGit(cwd, ["init", "--initial-branch=main"]);
  runGit(cwd, ["config", "user.email", "test@example.com"]);
  runGit(cwd, ["config", "user.name", "Test User"]);
  fs.writeFileSync(path.join(cwd, "README.md"), "v1\n", "utf8");
  runGit(cwd, ["add", "."]);
  runGit(cwd, ["commit", "-m", "Initial"]);
}

export function gitRefExists(cwd: string, ref: string): boolean {
  try {
    runGit(cwd, ["show-ref", "--verify", "--quiet", ref]);
    return true;
  } catch {
    return false;
  }
}

export function gitShowFileAtRef(cwd: string, ref: string, filePath: string): string {
  return runGit(cwd, ["show", `${ref}:${filePath}`]);
}

function waitFor<A>(
  read: Effect.Effect<A, unknown>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs?: number,
): Effect.Effect<A, never>;
function waitFor<A, B extends A>(
  read: Effect.Effect<A, unknown>,
  predicate: (value: A) => value is B,
  description: string,
  timeoutMs?: number,
): Effect.Effect<B, never>;
function waitFor<A>(
  read: Effect.Effect<A, unknown>,
  predicate: (value: A) => boolean,
  description: string,
  timeoutMs = 3000,
): Effect.Effect<A, never> {
  const RETRY_SIGNAL = "wait_for_retry";
  const retryIntervalMs = 10;
  const maxRetries = Math.max(0, Math.floor(timeoutMs / retryIntervalMs));
  const retrySchedule = Schedule.spaced(`${retryIntervalMs} millis`);

  return read.pipe(
    Effect.filterOrFail(predicate, () => RETRY_SIGNAL),
    Effect.retry({
      schedule: retrySchedule,
      times: maxRetries,
      while: (error) => error === RETRY_SIGNAL,
    }),
    Effect.mapError((error) =>
      error === RETRY_SIGNAL ? new Error(`Timed out waiting for ${description}.`) : error,
    ),
    Effect.orDie,
  );
}

export interface OrchestrationIntegrationHarness {
  readonly rootDir: string;
  readonly workspaceDir: string;
  readonly dbPath: string;
  readonly adapterHarness: TestProviderAdapterHarness;
  readonly engine: OrchestrationEngineShape;
  readonly snapshotQuery: ProjectionSnapshotQuery["Service"];
  readonly providerService: ProviderService["Service"];
  readonly checkpointStore: CheckpointStore["Service"];
  readonly checkpointRepository: ProjectionCheckpointRepository["Service"];
  readonly pendingApprovalRepository: ProjectionPendingApprovalRepository["Service"];
  readonly waitForThread: (
    threadId: string,
    predicate: (thread: OrchestrationThread) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<OrchestrationThread, never>;
  readonly waitForDomainEvent: (
    predicate: (event: OrchestrationEvent) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<ReadonlyArray<OrchestrationEvent>, never>;
  readonly waitForPendingApproval: (
    requestId: string,
    predicate: (row: {
      readonly status: "pending" | "resolved";
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
      readonly resolvedAt: string | null;
    }) => boolean,
    timeoutMs?: number,
  ) => Effect.Effect<
    {
      readonly status: "pending" | "resolved";
      readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
      readonly resolvedAt: string | null;
    },
    never
  >;
  readonly dispose: Effect.Effect<void, never>;
}

export const makeOrchestrationIntegrationHarness = Effect.gen(function* () {
  const sleep = (ms: number) =>
    Effect.promise(() => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const adapterHarness = yield* makeTestProviderAdapterHarness;

  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "t3-orchestration-integration-"));
  const workspaceDir = path.join(rootDir, "workspace");
  const stateDir = path.join(rootDir, "state");
  const dbPath = path.join(stateDir, "state.sqlite");
  fs.mkdirSync(workspaceDir, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  initializeGitWorkspace(workspaceDir);

  const registry: typeof ProviderAdapterRegistry.Service = {
    getByProvider: (provider) =>
      provider === "codex"
        ? Effect.succeed(adapterHarness.adapter)
        : Effect.fail(new ProviderUnsupportedError({ provider })),
    listProviders: () => Effect.succeed(["codex"]),
  };

  const persistenceLayer = makeSqlitePersistenceLive(dbPath);
  const orchestrationLayer = OrchestrationEngineLive.pipe(
    Layer.provide(OrchestrationProjectionPipelineLive),
    Layer.provide(OrchestrationEventStoreLive),
    Layer.provide(OrchestrationCommandReceiptRepositoryLive),
  );
  const providerSessionDirectoryLayer = ProviderSessionDirectoryLive.pipe(
    Layer.provide(ProviderSessionRuntimeRepositoryLive),
  );
  const providerLayer = makeProviderServiceLive().pipe(
    Layer.provide(providerSessionDirectoryLayer),
    Layer.provide(Layer.succeed(ProviderAdapterRegistry, registry)),
  );
  const checkpointStoreLayer = CheckpointStoreLive.pipe(Layer.provide(NodeServices.layer));

  const runtimeServicesLayer = Layer.mergeAll(
    orchestrationLayer,
    OrchestrationProjectionSnapshotQueryLive,
    ProjectionCheckpointRepositoryLive,
    ProjectionPendingApprovalRepositoryLive,
    checkpointStoreLayer,
    providerLayer,
  );
  const runtimeIngestionLayer = ProviderRuntimeIngestionLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const providerCommandReactorLayer = ProviderCommandReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const checkpointReactorLayer = CheckpointReactorLive.pipe(
    Layer.provideMerge(runtimeServicesLayer),
  );
  const orchestrationReactorLayer = OrchestrationReactorLive.pipe(
    Layer.provideMerge(runtimeIngestionLayer),
    Layer.provideMerge(providerCommandReactorLayer),
    Layer.provideMerge(checkpointReactorLayer),
  );
  const layer = orchestrationReactorLayer.pipe(
    Layer.provide(persistenceLayer),
    Layer.provideMerge(NodeServices.layer),
  );

  const runtime = ManagedRuntime.make(layer);
  const engine = yield* Effect.promise(() =>
    runtime.runPromise(Effect.service(OrchestrationEngineService)),
  );
  const reactor = yield* Effect.promise(() =>
    runtime.runPromise(Effect.service(OrchestrationReactor)),
  );
  const snapshotQuery = yield* Effect.promise(() =>
    runtime.runPromise(Effect.service(ProjectionSnapshotQuery)),
  );
  const providerService = yield* Effect.promise(() =>
    runtime.runPromise(Effect.service(ProviderService)),
  );
  const checkpointStore = yield* Effect.promise(() =>
    runtime.runPromise(Effect.service(CheckpointStore)),
  );
  const checkpointRepository = yield* Effect.promise(() =>
    runtime.runPromise(Effect.service(ProjectionCheckpointRepository)),
  );
  const pendingApprovalRepository = yield* Effect.promise(() =>
    runtime.runPromise(Effect.service(ProjectionPendingApprovalRepository)),
  );

  const scope = yield* Effect.promise(() => Effect.runPromise(Scope.make("sequential")));
  yield* Effect.promise(() => runtime.runPromise(reactor.start.pipe(Scope.provide(scope))));
  yield* sleep(10);

  const waitForThread: OrchestrationIntegrationHarness["waitForThread"] = (
    threadId,
    predicate,
    timeoutMs,
  ) =>
    waitFor(
      snapshotQuery
        .getSnapshot()
        .pipe(
          Effect.map(
            (snapshot) => snapshot.threads.find((thread) => thread.id === threadId) ?? null,
          ),
        ),
      (thread): thread is OrchestrationThread => thread !== null && predicate(thread),
      `projected thread '${threadId}'`,
      timeoutMs,
    ) as Effect.Effect<OrchestrationThread, never>;

  const waitForDomainEvent: OrchestrationIntegrationHarness["waitForDomainEvent"] = (
    predicate,
    timeoutMs,
  ) =>
    waitFor(
      Stream.runCollect(engine.readEvents(0)).pipe(
        Effect.map((chunk): ReadonlyArray<OrchestrationEvent> => Array.from(chunk)),
      ),
      (events) => events.some(predicate),
      "domain event",
      timeoutMs,
    );

  const waitForPendingApproval: OrchestrationIntegrationHarness["waitForPendingApproval"] = (
    requestId,
    predicate,
    timeoutMs,
  ) =>
    waitFor(
      pendingApprovalRepository
        .getByRequestId({ requestId: ApprovalRequestId.makeUnsafe(requestId) })
        .pipe(
          Effect.map((row) =>
            Option.match(row, {
              onNone: () => null,
              onSome: (value) => ({
                status: value.status,
                decision: value.decision,
                resolvedAt: value.resolvedAt,
              }),
            }),
          ),
        ),
      (
        row,
      ): row is {
        readonly status: "pending" | "resolved";
        readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
        readonly resolvedAt: string | null;
      } => row !== null && predicate(row),
      `pending approval '${requestId}'`,
      timeoutMs,
    ) as Effect.Effect<
      {
        readonly status: "pending" | "resolved";
        readonly decision: "accept" | "acceptForSession" | "decline" | "cancel" | null;
        readonly resolvedAt: string | null;
      },
      never
    >;

  let disposed = false;
  const dispose = Effect.gen(function* () {
    if (disposed) {
      return;
    }
    disposed = true;

    const shutdown = Effect.gen(function* () {
      const stopAllExit = yield* Effect.exit(
        Effect.promise(() => runtime.runPromise(providerService.stopAll())),
      );
      const closeScopeExit = yield* Effect.exit(
        Effect.promise(() => Effect.runPromise(Scope.close(scope, Exit.void))),
      );
      const disposeRuntimeExit = yield* Effect.exit(Effect.promise(() => runtime.dispose()));

      const failureCause =
        Exit.isFailure(stopAllExit)
          ? stopAllExit.cause
          : Exit.isFailure(closeScopeExit)
            ? closeScopeExit.cause
            : Exit.isFailure(disposeRuntimeExit)
              ? disposeRuntimeExit.cause
              : null;

      if (failureCause) {
        yield* Effect.failCause(failureCause);
      }
    });

    yield* shutdown.pipe(
      Effect.ensuring(
        Effect.sync(() => {
          fs.rmSync(rootDir, { recursive: true, force: true });
        }),
      ),
    );
  });

  return {
    rootDir,
    workspaceDir,
    dbPath,
    adapterHarness,
    engine,
    snapshotQuery,
    providerService,
    checkpointStore,
    checkpointRepository,
    pendingApprovalRepository,
    waitForThread,
    waitForDomainEvent,
    waitForPendingApproval,
    dispose,
  } satisfies OrchestrationIntegrationHarness;
});

import {
  CommandId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationProjectShell,
  type OrchestrationThreadShell,
  type ProjectScript,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { ExitCode } from "effect/unstable/process/ChildProcessSpawner";

import { ProcessRunner, type ProcessRunInput } from "../processRunner.ts";
import {
  ProjectSetupScriptRunner,
  type ProjectSetupScriptRunnerInput,
} from "../project/ProjectSetupScriptRunner.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  WorktreeTeardownReactor,
  layer as WorktreeTeardownReactorLive,
} from "./WorktreeTeardownReactor.ts";

const now = "2026-09-14T00:00:00.000Z";
const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const otherThreadId = ThreadId.make("thread-2");
const modelSelection = createModelSelection(ProviderInstanceId.make("codex"), "gpt-5-codex");

const setupScript: ProjectScript = {
  id: "setup",
  name: "Setup",
  command: "vp i",
  icon: "configure",
  runOnWorktreeCreate: true,
};
const teardownScript: ProjectScript = {
  id: "teardown",
  name: "Teardown",
  command: "rm -rf node_modules",
  icon: "configure",
  runOnWorktreeCreate: false,
  runOnThreadSettle: true,
};

function makeThread(
  overrides: Partial<OrchestrationThreadShell> & { readonly id: ThreadId },
): OrchestrationThreadShell {
  return {
    projectId,
    title: "Thread",
    modelSelection,
    runtimeMode: "approval-required",
    interactionMode: "default",
    branch: "t3code/feature",
    worktreePath: null,
    latestTurn: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    session: null,
    latestUserMessageAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    pullRequests: [],
    ...overrides,
  };
}

function settleEvent(
  type: "thread.settled" | "thread.unsettled",
  id: ThreadId,
): OrchestrationEvent {
  const base = {
    eventId: EventId.make(`event-${type}-${id}`),
    sequence: 1,
    aggregateKind: "thread" as const,
    aggregateId: id,
    occurredAt: now,
    commandId: CommandId.make(`cmd-${type}-${id}`),
    causationEventId: null,
    correlationId: null,
    metadata: {},
  };
  return type === "thread.settled"
    ? { ...base, type, payload: { threadId: id, settledAt: now, updatedAt: now } }
    : { ...base, type, payload: { threadId: id, reason: "user", updatedAt: now } };
}

/** Temp worktree plus a sibling "project root" path that never exists on disk. */
const makeWorktree = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-settle-reactor-" });
  const worktreePath = path.join(root, "worktree");
  yield* fs.makeDirectory(worktreePath);
  return { workspaceRoot: path.join(root, "root"), worktreePath };
});

/**
 * Builds the reactor over stubbed services and starts it in the current
 * scope. Events flow through a queue rather than a PubSub so nothing is
 * dropped before the reactor subscribes; `drain` ends the queue and waits for
 * the stream fiber to hand every event to the worker before draining it.
 */
const makeHarness = Effect.fnUntraced(function* (input: {
  readonly workspaceRoot: string;
  readonly scripts: ReadonlyArray<ProjectScript>;
  readonly threads: ReadonlyArray<OrchestrationThreadShell>;
}) {
  const runs: ProcessRunInput[] = [];
  const setupRuns: ProjectSetupScriptRunnerInput[] = [];
  const project: OrchestrationProjectShell = {
    id: projectId,
    title: "Project",
    workspaceRoot: input.workspaceRoot,
    defaultModelSelection: null,
    scripts: input.scripts,
    createdAt: now,
    updatedAt: now,
  };
  const events = yield* Queue.unbounded<OrchestrationEvent, Cause.Done>();
  const consumed = yield* Deferred.make<void>();
  const layer = WorktreeTeardownReactorLive.pipe(
    Layer.provideMerge(
      Layer.succeed(OrchestrationEngineService, {
        readEvents: () => Stream.empty,
        readThreadEvents: () => Stream.empty,
        getThreadReplayStats: () => Effect.die("replay stats are not used by the teardown reactor"),
        dispatch: () => Effect.die("dispatch is not used by the teardown reactor"),
        streamDomainEvents: Stream.fromQueue(events).pipe(
          Stream.ensuring(Deferred.succeed(consumed, undefined)),
        ),
        subscribeDomainEvents: Effect.die("subscribe is not used by the teardown reactor"),
        latestSequence: Effect.succeed(0),
      }),
    ),
    Layer.provideMerge(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadShellById: (id) =>
          Effect.succeed(Option.fromUndefinedOr(input.threads.find((thread) => thread.id === id))),
        getProjectShellById: (id) =>
          Effect.succeed(id === projectId ? Option.some(project) : Option.none()),
        getShellSnapshot: () =>
          Effect.succeed({
            snapshotSequence: 0,
            projects: [project],
            threads: input.threads,
            updatedAt: now,
          }),
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProcessRunner, {
        run: (runInput) => {
          runs.push(runInput);
          return Effect.succeed({
            stdout: "",
            stderr: "",
            code: ExitCode(0),
            timedOut: false,
            stdoutTruncated: false,
            stderrTruncated: false,
            stdoutInvalidUtf8: false,
            stderrInvalidUtf8: false,
          });
        },
      }),
    ),
    Layer.provideMerge(
      Layer.succeed(ProjectSetupScriptRunner, {
        runForThread: (runInput) => {
          setupRuns.push(runInput);
          return Effect.succeed({ status: "no-script" as const });
        },
      }),
    ),
    Layer.provideMerge(ServerSettingsService.layerTest({ defaultProjectScripts: input.scripts })),
    Layer.provideMerge(NodeServices.layer),
  );
  const services = yield* Layer.build(layer);
  const reactor = yield* WorktreeTeardownReactor.pipe(Effect.provide(services));
  yield* reactor.start();
  return {
    publish: (event: OrchestrationEvent) => Queue.offer(events, event),
    drain: Queue.end(events).pipe(
      Effect.andThen(Deferred.await(consumed)),
      Effect.andThen(reactor.drain),
    ),
    runs,
    setupRuns,
  };
});

it.layer(NodeServices.layer)("WorktreeTeardownReactor", (it) => {
  describe("WorktreeTeardownReactor", () => {
    it.effect("runs the teardown script in the worktree when a thread settles", () =>
      Effect.gen(function* () {
        const { workspaceRoot, worktreePath } = yield* makeWorktree;
        const harness = yield* makeHarness({
          workspaceRoot,
          scripts: [setupScript, teardownScript],
          threads: [makeThread({ id: threadId, worktreePath, settledOverride: "settled" })],
        });

        yield* harness.publish(settleEvent("thread.settled", threadId));
        yield* harness.drain;

        assert.lengthOf(harness.runs, 1);
        assert.deepInclude(harness.runs[0], {
          command: "rm -rf node_modules",
          shell: true,
          cwd: worktreePath,
          env: { T3CODE_PROJECT_ROOT: workspaceRoot, T3CODE_WORKTREE_PATH: worktreePath },
        });
        assert.lengthOf(harness.setupRuns, 0);
      }).pipe(Effect.scoped),
    );

    it.effect("reruns the setup script when a thread is un-settled", () =>
      Effect.gen(function* () {
        const { workspaceRoot, worktreePath } = yield* makeWorktree;
        const harness = yield* makeHarness({
          workspaceRoot,
          scripts: [setupScript, teardownScript],
          threads: [makeThread({ id: threadId, worktreePath })],
        });

        yield* harness.publish(settleEvent("thread.unsettled", threadId));
        yield* harness.drain;

        assert.lengthOf(harness.runs, 0);
        assert.deepEqual(harness.setupRuns, [{ threadId, projectId, worktreePath }]);
      }).pipe(Effect.scoped),
    );

    it.effect("does nothing without a teardown script", () =>
      Effect.gen(function* () {
        const { workspaceRoot, worktreePath } = yield* makeWorktree;
        const harness = yield* makeHarness({
          workspaceRoot,
          scripts: [setupScript],
          threads: [makeThread({ id: threadId, worktreePath, settledOverride: "settled" })],
        });

        yield* harness.publish(settleEvent("thread.settled", threadId));
        yield* harness.publish(settleEvent("thread.unsettled", threadId));
        yield* harness.drain;

        assert.lengthOf(harness.runs, 0);
        assert.lengthOf(harness.setupRuns, 0);
      }).pipe(Effect.scoped),
    );

    it.effect("skips teardown while another active thread shares the worktree", () =>
      Effect.gen(function* () {
        const { workspaceRoot, worktreePath } = yield* makeWorktree;
        const harness = yield* makeHarness({
          workspaceRoot,
          scripts: [teardownScript],
          threads: [
            makeThread({ id: threadId, worktreePath, settledOverride: "settled" }),
            makeThread({ id: otherThreadId, worktreePath }),
          ],
        });

        yield* harness.publish(settleEvent("thread.settled", threadId));
        yield* harness.drain;

        assert.lengthOf(harness.runs, 0);
      }).pipe(Effect.scoped),
    );

    it.effect("never runs teardown against the project checkout or a missing worktree", () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const { workspaceRoot, worktreePath } = yield* makeWorktree;
        yield* fs.remove(worktreePath, { recursive: true });
        const harness = yield* makeHarness({
          workspaceRoot,
          scripts: [teardownScript],
          threads: [
            makeThread({ id: threadId, worktreePath: workspaceRoot, settledOverride: "settled" }),
            makeThread({ id: otherThreadId, worktreePath, settledOverride: "settled" }),
          ],
        });

        yield* harness.publish(settleEvent("thread.settled", threadId));
        yield* harness.publish(settleEvent("thread.settled", otherThreadId));
        yield* harness.drain;

        assert.lengthOf(harness.runs, 0);
      }).pipe(Effect.scoped),
    );
  });
});

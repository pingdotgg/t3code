import type { OrchestrationEvent, ThreadId } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import {
  projectScriptRuntimeEnv,
  resolveProjectScripts,
  setupProjectScript,
  teardownProjectScript,
} from "@t3tools/shared/projectScripts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { ProcessRunner } from "../processRunner.ts";
import { ProjectSetupScriptRunner } from "../project/ProjectSetupScriptRunner.ts";
import * as ServerSettings from "../serverSettings.ts";
import { forkParked } from "../serverActivation.ts";
import { OrchestrationEngineService } from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";

/**
 * Runs a project's teardown script in a thread's worktree when the thread
 * settles, and its setup script again when the thread is un-settled, so a
 * settled thread stops costing disk without ever leaving a broken checkout.
 */
export class WorktreeTeardownReactor extends Context.Service<
  WorktreeTeardownReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    /** Resolves when the queue is empty and idle; for tests instead of sleeps. */
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/WorktreeTeardownReactor") {}

type SettleEvent = Extract<OrchestrationEvent, { type: "thread.settled" | "thread.unsettled" }>;

const TEARDOWN_TIMEOUT = "10 minutes";
const TEARDOWN_MAX_OUTPUT_BYTES = 64 * 1024;

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const processRunner = yield* ProcessRunner;
  const setupScriptRunner = yield* ProjectSetupScriptRunner;
  const fileSystem = yield* FileSystem.FileSystem;

  /**
   * A thread qualifies only when it owns a real worktree directory (never the
   * project checkout itself) and its project has a teardown script.
   */
  const resolveTarget = Effect.fnUntraced(function* (threadId: ThreadId) {
    const thread = yield* projectionSnapshotQuery
      .getThreadShellById(threadId)
      .pipe(Effect.map(Option.getOrNull));
    if (!thread?.worktreePath) return null;
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(thread.projectId)
      .pipe(Effect.map(Option.getOrNull));
    if (!project || project.workspaceRoot === thread.worktreePath) return null;
    const scripts = resolveProjectScripts(yield* settingsService.getSettings, project);
    const teardown = teardownProjectScript(scripts);
    if (!teardown) return null;
    const exists = yield* fileSystem
      .exists(thread.worktreePath)
      .pipe(Effect.orElseSucceed(() => false));
    if (!exists) return null;
    return { thread, project, scripts, teardown, worktreePath: thread.worktreePath };
  });

  const processSettled = Effect.fnUntraced(function* (threadId: ThreadId) {
    const target = yield* resolveTarget(threadId);
    if (!target) return;
    const { thread, project, teardown, worktreePath } = target;
    // Another thread working in the same worktree still needs it intact.
    const snapshot = yield* projectionSnapshotQuery.getShellSnapshot();
    const sharedWithActiveThread = snapshot.threads.some(
      (other) =>
        other.id !== thread.id &&
        other.worktreePath === worktreePath &&
        other.settledOverride !== "settled",
    );
    if (sharedWithActiveThread) {
      yield* Effect.logInfo("worktree teardown skipped for a shared worktree", {
        threadId: thread.id,
        worktreePath,
      });
      return;
    }
    yield* Effect.logInfo("worktree teardown running script", {
      threadId: thread.id,
      worktreePath,
      scriptId: teardown.id,
    });
    const result = yield* processRunner.run({
      command: teardown.command,
      args: [],
      shell: true,
      cwd: worktreePath,
      env: projectScriptRuntimeEnv({ project: { cwd: project.workspaceRoot }, worktreePath }),
      timeout: TEARDOWN_TIMEOUT,
      outputMode: "truncate",
      maxOutputBytes: TEARDOWN_MAX_OUTPUT_BYTES,
    });
    if (result.code !== 0) {
      yield* Effect.logWarning("worktree teardown script exited with an error", {
        threadId: thread.id,
        worktreePath,
        scriptId: teardown.id,
        code: result.code,
        stderr: result.stderr.slice(-2_000),
      });
    }
  });

  /** Un-settling reverses the teardown: the setup script restores the worktree. */
  const processUnsettled = Effect.fnUntraced(function* (threadId: ThreadId) {
    const target = yield* resolveTarget(threadId);
    if (!target || !setupProjectScript(target.scripts)) return;
    yield* Effect.logInfo("worktree teardown rerunning setup script after un-settle", {
      threadId,
      worktreePath: target.worktreePath,
    });
    yield* setupScriptRunner.runForThread({
      threadId,
      projectId: target.project.id,
      worktreePath: target.worktreePath,
    });
  });

  const processEvent = Effect.fnUntraced(
    function* (event: SettleEvent) {
      if (event.type === "thread.settled") {
        yield* processSettled(event.payload.threadId);
      } else {
        yield* processUnsettled(event.payload.threadId);
      }
    },
    (effect, event) =>
      effect.pipe(
        Effect.catchCauseIf(
          (cause) => !Cause.hasInterruptsOnly(cause),
          (cause) =>
            Effect.logWarning("worktree teardown reactor failed to process event", {
              eventType: event.type,
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
        ),
      ),
  );

  const worker = yield* makeDrainableWorker(processEvent);

  const start: WorktreeTeardownReactor["Service"]["start"] = Effect.fn(
    "WorktreeTeardownReactor.start",
  )(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.settled" || event.type === "thread.unsettled"
          ? worker.enqueue(event)
          : Effect.void,
      ),
    );
  });

  return { start, drain: worker.drain } satisfies WorktreeTeardownReactor["Service"];
});

export const layer = Layer.effect(WorktreeTeardownReactor, make);

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { ProjectId, ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as TerminalManager from "../terminal/Manager.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ProjectService from "./ProjectService.ts";
import * as ProjectScriptPorts from "./ProjectScriptPorts.ts";
import * as ProjectSetupScriptRunner from "./ProjectSetupScriptRunner.ts";

it.effect("ReservedScript-overlappingStarts-reusesOwnerAndRetriesAfterCompletionOrFailure", () =>
  Effect.gen(function* () {
    const opening = yield* Deferred.make<void>();
    const releaseOpen = yield* Deferred.make<void>();
    const writing = yield* Deferred.make<void>();
    let writeGate: Deferred.Deferred<void> | null = null;
    const listeners = new Set<
      Parameters<TerminalManager.TerminalManager["Service"]["subscribe"]>[0]
    >();
    let openCount = 0;
    const openRequests: Array<Parameters<TerminalManager.TerminalManager["Service"]["open"]>[0]> =
      [];
    let failWrite = false;
    let exitBeforeSubscribe = false;
    let terminalExited = false;
    const writes: string[] = [];
    const projectId = ProjectId.make("project:reserved-runner");
    const script = {
      id: "preview",
      name: "Preview",
      command: "vp dev",
      icon: "play" as const,
      runOnWorktreeCreate: true,
      runOnSettle: true,
      reservePort: true,
      previewUrl: "http://localhost:${T3CODE_PREVIEW_PORT}",
      async: false,
    };
    const project = {
      id: projectId,
      title: "Project",
      workspaceRoot: "/repo",
      repositoryIdentity: null,
      faviconPath: null,
      defaultModelSelection: null,
      scripts: [script],
      createdAt: "2026-06-20T00:00:00.000Z",
      updatedAt: "2026-06-20T00:00:00.000Z",
      deletedAt: null,
    };
    const input = {
      threadId: ThreadId.make("thread-owner"),
      projectId,
      worktreePath: "/repo-worktree",
      scriptId: script.id,
    };
    const layer = ProjectSetupScriptRunner.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeed(Option.some(project)),
          }),
          Layer.mock(ProjectScriptPorts.ProjectScriptPorts)({
            reserve: () => Effect.succeed(43123),
          }),
          Layer.mock(TerminalManager.TerminalManager)({
            open: (request) =>
              Effect.gen(function* () {
                openRequests.push(request);
                if (openCount++ === 0) {
                  yield* Deferred.succeed(opening, undefined);
                  yield* Deferred.await(releaseOpen);
                }
                terminalExited = exitBeforeSubscribe;
                if (terminalExited) {
                  yield* Effect.forEach([...listeners], (listener) =>
                    listener({
                      type: "exited",
                      threadId: request.threadId,
                      terminalId: request.terminalId,
                      exitCode: 1,
                      exitSignal: null,
                    }),
                  );
                }
                return {
                  ...request,
                  worktreePath: request.worktreePath ?? null,
                  status: "running" as const,
                  pid: 123,
                  history: "",
                  exitCode: null,
                  exitSignal: null,
                  label: "Shell",
                  updatedAt: project.createdAt,
                };
              }),
            write: (request) =>
              Effect.gen(function* () {
                assert.equal(request.expectedPid, 123);
                assert.match(request.data, /^ \S/);
                if (terminalExited) {
                  return yield* new TerminalManager.TerminalNotRunningError({
                    threadId: request.threadId,
                    terminalId: request.terminalId,
                  });
                }
                if (failWrite) {
                  return yield* new TerminalManager.TerminalWriteError({
                    threadId: request.threadId,
                    terminalId: request.terminalId,
                    terminalPid: 123,
                    cause: new Error("write failed"),
                  });
                }
                writes.push(request.data);
                const pendingWrite = writeGate;
                if (pendingWrite) {
                  yield* Deferred.succeed(writing, undefined);
                  yield* Deferred.await(pendingWrite);
                }
              }),
            subscribe: (listener) =>
              Effect.sync(() => {
                listeners.add(listener);
                return () => listeners.delete(listener);
              }),
            closeIdle: () => Effect.void,
          }),
          ServerSettings.layerTest(),
          NodeCrypto.layer,
        ),
      ),
    );

    yield* Effect.gen(function* () {
      const runner = yield* ProjectSetupScriptRunner.ProjectSetupScriptRunner;
      const first = yield* runner.runScript(input).pipe(Effect.forkChild);
      yield* Deferred.await(opening);
      const contenders = yield* Effect.all(
        [
          runner.runScript({ ...input, threadId: ThreadId.make("thread-other") }),
          runner.runForThread({
            threadId: input.threadId,
            projectId,
            worktreePath: input.worktreePath,
            trigger: "settle",
            observeCompletion: {},
          }),
        ],
        { concurrency: "unbounded" },
      ).pipe(Effect.forkChild);
      yield* Deferred.succeed(releaseOpen, undefined);
      const started = yield* Fiber.join(first);
      const [otherThread, lifecycle] = yield* Fiber.join(contenders);
      assert.deepEqual(started, {
        status: "started",
        threadId: input.threadId,
        terminalId: "script-43123",
        port: 43123,
      });
      assert.deepEqual(otherThread, started);
      assert.equal(openCount, 1);
      assert.equal(writes.length, 1);
      assert.equal(lifecycle.status, "started");
      if (lifecycle.status !== "started") return;
      assert.equal(lifecycle.async, false);
      assert.deepEqual(
        yield* runner.runForThread({
          threadId: "thread-other",
          projectId,
          worktreePath: input.worktreePath,
          trigger: "settle",
        }),
        { status: "no-script" },
      );

      const token = /__T3_SETUP_DONE___(\w+):/.exec(writes[0]!)![1];
      yield* Effect.forEach([...listeners], (listener) =>
        listener({
          type: "output",
          threadId: input.threadId,
          terminalId: "script-43123",
          data: `\r\n__T3_SETUP_DONE___${token}:0\r\n$ `,
        }),
      );
      assert.equal((yield* lifecycle.completion!).exitCode, 0);
      assert.equal(listeners.size, 0);
      failWrite = true;
      assert.equal(
        (yield* runner.runScript(input).pipe(Effect.flip))._tag,
        "ProjectSetupScriptOperationError",
      );
      assert.equal(listeners.size, 0);
      failWrite = false;
      assert.deepEqual(yield* runner.runScript(input), started);
      assert.equal(openCount, 3);
      assert.equal(writes.length, 2);

      const restarted = yield* runner.runForThread({
        threadId: input.threadId,
        projectId,
        worktreePath: input.worktreePath,
      });
      yield* Effect.forEach([...listeners], (listener) =>
        listener({
          type: "restarted",
          threadId: input.threadId,
          terminalId: "script-43123",
          snapshot: {
            threadId: input.threadId,
            terminalId: "script-43123",
            cwd: input.worktreePath,
            worktreePath: input.worktreePath,
            status: "running",
            pid: 456,
            history: "",
            exitCode: null,
            exitSignal: null,
            label: "Shell",
            updatedAt: project.createdAt,
          },
        }),
      );
      assert.equal(restarted.status, "started");
      if (restarted.status === "started") {
        assert.equal((yield* restarted.completion!).exitCode, null);
      }
      assert.equal(listeners.size, 0);

      writeGate = yield* Deferred.make<void>();
      const disconnected = yield* runner.runScript(input).pipe(Effect.forkChild);
      yield* Deferred.await(writing);
      const interruption = yield* Fiber.interrupt(disconnected).pipe(Effect.forkChild);
      yield* Deferred.succeed(writeGate, undefined);
      yield* Fiber.join(interruption);
      writeGate = null;
      const writtenBeforeRetry = writes.length;
      assert.deepEqual(yield* runner.runScript(input), started);
      assert.equal(writes.length, writtenBeforeRetry);
      const interruptedRun = yield* runner.runForThread({
        threadId: input.threadId,
        projectId,
        worktreePath: input.worktreePath,
      });
      yield* Effect.forEach([...listeners], (listener) =>
        listener({
          type: "exited",
          threadId: input.threadId,
          terminalId: "script-43123",
          exitCode: 0,
          exitSignal: null,
        }),
      );
      if (interruptedRun.status === "started") yield* interruptedRun.completion!;

      exitBeforeSubscribe = true;
      const lostExit = yield* runner.runScript(input).pipe(Effect.flip);
      assert.equal(lostExit._tag, "ProjectSetupScriptOperationError");
      if (lostExit._tag === "ProjectSetupScriptOperationError") {
        assert.equal(lostExit.operation, "writeCommand");
      }
      assert.equal(listeners.size, 0);
      exitBeforeSubscribe = false;

      yield* runner.runScript({ ...input, worktreePath: null });
      assert.deepEqual(openRequests.at(-1), {
        threadId: input.threadId,
        terminalId: "script-43123",
        cwd: project.workspaceRoot,
        worktreePath: null,
        env: {
          T3CODE_PROJECT_ROOT: project.workspaceRoot,
          T3CODE_PREVIEW_PORT: "43123",
        },
      });
    }).pipe(Effect.provide(layer));
    assert.equal(listeners.size, 0);
  }),
);

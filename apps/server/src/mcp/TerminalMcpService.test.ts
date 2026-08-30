import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type Project,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import { OrchestratorProjectionError } from "../orchestration-v2/Orchestrator.ts";
import { ThreadCommandExecutor } from "../orchestration-v2/ThreadCommandExecutor.ts";
import { ProjectionStoreThreadNotFoundError } from "../orchestration-v2/ProjectionStore.ts";
import {
  ThreadManagementProjectionLoadError,
  ThreadManagementService,
} from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as TerminalMcpService from "./TerminalMcpService.ts";

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly resizeCalls: Array<{ cols: number; rows: number }> = [];
  readonly pid: number;
  writeFailure: unknown | undefined;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  constructor(pid: number) {
    this.pid = pid;
  }

  write(data: string): void {
    if (this.writeFailure !== undefined) throw this.writeFailure;
    this.writes.push(data);
  }

  resize(cols: number, rows: number): void {
    this.resizeCalls.push({ cols, rows });
  }

  kill(): void {}

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  emitData(data: string): void {
    for (const listener of this.dataListeners) listener(data);
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  failNextSpawn = false;

  spawn(
    input: PtyAdapter.PtySpawnInput,
  ): Effect.Effect<PtyAdapter.PtyProcess, PtyAdapter.PtySpawnError> {
    this.spawnInputs.push(input);
    if (this.failNextSpawn) {
      this.failNextSpawn = false;
      return Effect.fail(
        new PtyAdapter.PtySpawnError({ adapter: "fake", cause: new Error("spawn failed") }),
      );
    }
    const process = new FakePtyProcess(12_000 + this.processes.length);
    this.processes.push(process);
    return Effect.succeed(process);
  }
}

function projection(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly runtimeMode?: "approval-required" | "full-access";
  readonly interactionMode?: "plan" | "default";
  readonly worktreePath?: string | null;
  readonly executionCwd?: string;
}): OrchestrationV2ThreadProjection {
  const providerSessionId = "provider-session:terminal-target";
  const providerThreadId = "provider-thread:terminal-target";
  return {
    thread: {
      id: input.threadId,
      projectId: input.projectId,
      runtimeMode: input.runtimeMode ?? "full-access",
      interactionMode: input.interactionMode ?? "default",
      worktreePath: input.worktreePath ?? null,
      activeProviderThreadId: input.executionCwd === undefined ? null : providerThreadId,
      deletedAt: null,
    },
    providerThreads:
      input.executionCwd === undefined ? [] : [{ id: providerThreadId, providerSessionId }],
    providerSessions:
      input.executionCwd === undefined
        ? []
        : [{ id: providerSessionId, cwd: input.executionCwd, status: "ready" }],
  } as unknown as OrchestrationV2ThreadProjection;
}

function project(projectId: ProjectId, workspaceRoot: string): Project {
  return {
    id: projectId,
    title: "Terminal project",
    workspaceRoot,
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("TerminalMcpService", () => {
  it.effect("uses the real manager without letting reads spawn or mutations bypass policy", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-terminal-mcp-" });
        const workspaceRoot = path.join(baseDir, "workspace");
        const worktreePath = path.join(baseDir, "worktree");
        const nestedExecutionCwd = path.join(worktreePath, "packages", "app");
        yield* fs.makeDirectory(workspaceRoot, { recursive: true });
        yield* fs.makeDirectory(worktreePath, { recursive: true });
        yield* fs.makeDirectory(nestedExecutionCwd, { recursive: true });

        const projectId = ProjectId.make("project:terminal-mcp");
        const callerThreadId = ThreadId.make("thread:terminal-caller");
        const targetThreadId = ThreadId.make("thread:terminal-target");
        const restrictedThreadId = ThreadId.make("thread:terminal-restricted");
        const missingProjectThreadId = ThreadId.make("thread:terminal-missing-project");
        const typedMissingCallerId = ThreadId.make("thread:terminal-typed-missing");
        const missingProjectId = ProjectId.make("project:terminal-missing");
        const projections = new Map([
          [callerThreadId, projection({ threadId: callerThreadId, projectId })],
          [
            targetThreadId,
            projection({
              threadId: targetThreadId,
              projectId,
              worktreePath,
              executionCwd: nestedExecutionCwd,
            }),
          ],
          [
            restrictedThreadId,
            projection({
              threadId: restrictedThreadId,
              projectId,
              runtimeMode: "approval-required",
              interactionMode: "plan",
            }),
          ],
          [
            missingProjectThreadId,
            projection({ threadId: missingProjectThreadId, projectId: missingProjectId }),
          ],
        ]);
        const ptyAdapter = new FakePtyAdapter();
        const manager = yield* TerminalManager.makeWithOptions({
          logsDir: path.join(baseDir, "terminal-history"),
          ptyAdapter,
          processKillGraceMs: 1,
        });
        const threadDispatch = yield* makeKeyedSerialExecutor<ThreadId>();
        const threads = ThreadManagementService.of({
          getThreadProjection: (threadId: ThreadId) =>
            threadId === typedMissingCallerId
              ? Effect.fail(
                  new OrchestratorProjectionError({
                    threadId,
                    cause: new ProjectionStoreThreadNotFoundError({ threadId }),
                  }),
                )
              : projections.has(threadId)
                ? Effect.succeed(projections.get(threadId)!)
                : Effect.fail(new Error("projection storage failed") as never),
          getProjectThread: ({
            projectId: expectedProjectId,
            threadId,
          }: {
            readonly projectId: ProjectId;
            readonly threadId: ThreadId;
          }) => {
            const target = projections.get(threadId);
            return target !== undefined && target.thread.projectId === expectedProjectId
              ? Effect.succeed(target)
              : Effect.fail(
                  new ThreadManagementProjectionLoadError({
                    projectId: expectedProjectId,
                    threadId,
                    cause: new OrchestratorProjectionError({
                      threadId,
                      cause: new ProjectionStoreThreadNotFoundError({ threadId }),
                    }),
                  }),
                );
          },
        } as unknown as ThreadManagementService["Service"]);
        const projects = ProjectService.ProjectService.of({
          getById: (requestedProjectId: ProjectId) =>
            Effect.succeed(
              requestedProjectId === projectId
                ? Option.some(project(projectId, workspaceRoot))
                : Option.none(),
            ),
        } as unknown as ProjectService.ProjectService["Service"]);
        const service = yield* TerminalMcpService.make.pipe(
          Effect.provideService(ThreadManagementService, threads),
          Effect.provideService(ProjectService.ProjectService, projects),
          Effect.provideService(TerminalManager.TerminalManager, manager),
          Effect.provideService(ThreadCommandExecutor, threadDispatch),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:terminal-mcp"),
          threadId: callerThreadId,
          providerSessionId: "provider-session:terminal-mcp",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };

        assert.deepEqual((yield* service.list(scope, {})).terminals, []);
        assert.equal(ptyAdapter.spawnInputs.length, 0);
        const missingRead = yield* service
          .read(scope, { terminalId: "term-missing" })
          .pipe(Effect.flip);
        assert.equal(missingRead.code, "terminal_not_found");
        assert.equal(ptyAdapter.spawnInputs.length, 0);
        const unknownThread = yield* service
          .list(scope, { threadId: ThreadId.make("thread:terminal-unknown") })
          .pipe(Effect.flip);
        assert.equal(unknownThread.code, "thread_not_found");
        const callerLoadFailure = yield* service
          .list({ ...scope, threadId: ThreadId.make("thread:terminal-storage-failure") }, {})
          .pipe(Effect.flip);
        assert.equal(callerLoadFailure.code, "operation_failed");
        const missingCaller = yield* service
          .list({ ...scope, threadId: typedMissingCallerId }, {})
          .pipe(Effect.flip);
        assert.equal(missingCaller.code, "thread_not_found");
        const missingProject = yield* service
          .list({ ...scope, threadId: missingProjectThreadId }, {})
          .pipe(Effect.flip);
        assert.equal(missingProject.code, "project_not_found");

        const denied = yield* service
          .open(scope, { threadId: restrictedThreadId, terminalId: "term-denied" })
          .pipe(Effect.flip);
        assert.equal(denied.code, "execution_policy_denied");
        assert.equal(ptyAdapter.spawnInputs.length, 0);

        const opened = yield* service.open(scope, {
          threadId: targetThreadId,
          terminalId: "term-managed",
          cols: 90,
          rows: 25,
        });
        assert.equal(opened.outcome, "opened");
        expect(ptyAdapter.spawnInputs[0]).toMatchObject({
          cwd: nestedExecutionCwd,
          cols: 90,
          rows: 25,
          env: {
            T3CODE_PROJECT_ROOT: workspaceRoot,
            T3CODE_WORKTREE_PATH: worktreePath,
          },
        });

        const reopened = yield* service.open(scope, {
          threadId: targetThreadId,
          terminalId: "term-managed",
        });
        assert.equal(reopened.outcome, "already_running");
        assert.equal(ptyAdapter.spawnInputs.length, 1);

        const write = yield* service.write(scope, {
          threadId: targetThreadId,
          terminalId: "term-managed",
          data: "printf terminal-mcp\\r",
        });
        assert.isTrue(write.accepted);
        assert.equal(write.statusAtAcceptance, "running");
        expect(ptyAdapter.processes[0]?.writes).toEqual(["printf terminal-mcp\\r"]);

        const outputSeen = yield* Deferred.make<void>();
        const unsubscribe = yield* manager.subscribe((event) =>
          event.type === "output" && event.terminalId === "term-managed"
            ? Deferred.succeed(outputSeen, undefined)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribe));
        ptyAdapter.processes[0]?.emitData("0123456789");
        yield* Deferred.await(outputSeen);
        const read = yield* service.read(scope, {
          threadId: targetThreadId,
          terminalId: "term-managed",
          maxChars: 4,
        });
        assert.equal(read.output.text, "6789");
        assert.equal(read.output.startOffset, 6);
        assert.equal(read.output.endOffset, 10);
        assert.isTrue(read.output.truncated);
        assert.isAbove(read.sequence, 0);

        yield* service.resize(scope, {
          threadId: targetThreadId,
          terminalId: "term-managed",
          cols: 100,
          rows: 30,
        });
        expect(ptyAdapter.processes[0]?.resizeCalls).toEqual([{ cols: 100, rows: 30 }]);
        assert.equal(
          (yield* service.clear(scope, {
            threadId: targetThreadId,
            terminalId: "term-managed",
          })).terminal.output.text,
          "",
        );

        const duplicateFresh = yield* service
          .openFresh(scope, { threadId: targetThreadId, terminalId: "term-managed" })
          .pipe(Effect.flip);
        assert.equal(duplicateFresh.code, "terminal_already_exists");
        assert.equal(ptyAdapter.spawnInputs.length, 1);

        yield* service.restart(scope, {
          threadId: targetThreadId,
          terminalId: "term-managed",
        });
        assert.equal(ptyAdapter.spawnInputs.length, 2);
        expect(ptyAdapter.spawnInputs[1]).toMatchObject({ cols: 100, rows: 30 });
        const exited = yield* Deferred.make<void>();
        const unsubscribeExit = yield* manager.subscribe((event) =>
          event.type === "exited" && event.terminalId === "term-managed"
            ? Deferred.succeed(exited, undefined)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeExit));
        ptyAdapter.processes[1]?.emitExit({ exitCode: 0, signal: null });
        yield* Deferred.await(exited);
        const writeAfterExit = yield* service
          .write(scope, {
            threadId: targetThreadId,
            terminalId: "term-managed",
            data: "pwd\r",
          })
          .pipe(Effect.flip);
        assert.equal(writeAfterExit.code, "terminal_not_running");
        yield* service.close(scope, {
          threadId: targetThreadId,
          terminalId: "term-managed",
        });
        const afterClose = yield* service
          .read(scope, { threadId: targetThreadId, terminalId: "term-managed" })
          .pipe(Effect.flip);
        assert.equal(afterClose.code, "terminal_not_found");

        yield* service.open(scope, {
          threadId: targetThreadId,
          terminalId: "term-restart-race",
        });
        const restartEntered = yield* Deferred.make<void>();
        const allowRestartAdmission = yield* Deferred.make<void>();
        const gatedManager = TerminalManager.TerminalManager.of({
          ...manager,
          restartExisting: (input) =>
            Deferred.succeed(restartEntered, undefined).pipe(
              Effect.andThen(Deferred.await(allowRestartAdmission)),
              Effect.andThen(manager.restartExisting(input)),
            ),
        });
        const gatedService = yield* TerminalMcpService.make.pipe(
          Effect.provideService(ThreadManagementService, threads),
          Effect.provideService(ProjectService.ProjectService, projects),
          Effect.provideService(TerminalManager.TerminalManager, gatedManager),
          Effect.provideService(ThreadCommandExecutor, threadDispatch),
        );
        const spawnCountBeforeRace = ptyAdapter.spawnInputs.length;
        const racingRestart = yield* gatedService
          .restart(scope, {
            threadId: targetThreadId,
            terminalId: "term-restart-race",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(restartEntered);
        yield* manager.close({
          threadId: targetThreadId,
          terminalId: "term-restart-race",
          deleteHistory: false,
        });
        yield* Deferred.succeed(allowRestartAdmission, undefined);
        const restartAfterClose = yield* Fiber.join(racingRestart).pipe(Effect.flip);
        assert.equal(restartAfterClose.code, "terminal_not_found");
        assert.equal(ptyAdapter.spawnInputs.length, spawnCountBeforeRace);
        assert.isNull(
          yield* manager.inspectSession({
            threadId: targetThreadId,
            terminalId: "term-restart-race",
          }),
        );

        yield* service.open(scope, {
          threadId: targetThreadId,
          terminalId: "term-write-race",
        });
        const writeEntered = yield* Deferred.make<void>();
        const allowWriteAdmission = yield* Deferred.make<void>();
        const gatedWriteManager = TerminalManager.TerminalManager.of({
          ...manager,
          writeStrict: (input) =>
            Deferred.succeed(writeEntered, undefined).pipe(
              Effect.andThen(Deferred.await(allowWriteAdmission)),
              Effect.andThen(manager.writeStrict(input)),
            ),
        });
        const gatedWriteService = yield* TerminalMcpService.make.pipe(
          Effect.provideService(ThreadManagementService, threads),
          Effect.provideService(ProjectService.ProjectService, projects),
          Effect.provideService(TerminalManager.TerminalManager, gatedWriteManager),
          Effect.provideService(ThreadCommandExecutor, threadDispatch),
        );
        const racingWrite = yield* gatedWriteService
          .write(scope, {
            threadId: targetThreadId,
            terminalId: "term-write-race",
            data: "echo should-not-run\r",
          })
          .pipe(Effect.forkScoped);
        yield* Deferred.await(writeEntered);
        const writeProcess = ptyAdapter.processes.at(-1);
        assert.isDefined(writeProcess);
        const writeExitSeen = yield* Deferred.make<void>();
        const unsubscribeWriteExit = yield* manager.subscribe((event) =>
          event.type === "exited" && event.terminalId === "term-write-race"
            ? Deferred.succeed(writeExitSeen, undefined)
            : Effect.void,
        );
        yield* Effect.addFinalizer(() => Effect.sync(unsubscribeWriteExit));
        writeProcess?.emitExit({ exitCode: 0, signal: null });
        yield* Deferred.await(writeExitSeen);
        yield* Deferred.succeed(allowWriteAdmission, undefined);
        const writeAfterExitRace = yield* Fiber.join(racingWrite).pipe(Effect.flip);
        assert.equal(writeAfterExitRace.code, "terminal_not_running");
        assert.deepEqual(writeProcess?.writes, []);

        ptyAdapter.failNextSpawn = true;
        const spawnFailure = yield* service
          .open(scope, { threadId: targetThreadId, terminalId: "term-spawn-failure" })
          .pipe(Effect.flip);
        assert.equal(spawnFailure.code, "operation_failed");
        assert.equal(
          (yield* manager.inspectSession({
            threadId: targetThreadId,
            terminalId: "term-spawn-failure",
          }))?.status,
          "error",
        );
        yield* manager.close({ threadId: targetThreadId, terminalId: "term-spawn-failure" });
      }),
    ).pipe(
      Effect.provide(
        Layer.merge(
          NodeServices.layer,
          ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
        ),
      ),
    ),
  );
});

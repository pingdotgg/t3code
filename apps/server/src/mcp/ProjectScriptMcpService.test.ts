import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
  type Project,
  type ProjectScript,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import { expect } from "vite-plus/test";

import * as ProcessRunner from "../processRunner.ts";
import { makeKeyedSerialExecutor } from "../orchestration-v2/KeyedSerialExecutor.ts";
import { ThreadCommandExecutor } from "../orchestration-v2/ThreadCommandExecutor.ts";
import {
  ThreadManagementService,
  ThreadManagementThreadNotFoundError,
} from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as PtyAdapter from "../terminal/PtyAdapter.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as ProjectScriptMcpService from "./ProjectScriptMcpService.ts";
import * as TerminalMcpService from "./TerminalMcpService.ts";

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  readonly pid: number;
  readonly failWrite: boolean;
  killCalls = 0;
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  constructor(pid: number, failWrite: boolean) {
    this.pid = pid;
    this.failWrite = failWrite;
  }

  write(data: string): void {
    if (this.failWrite) throw new Error("script PTY write failed");
    this.writes.push(data);
  }

  resize(): void {}

  kill(): void {
    this.killCalls += 1;
    this.emitExit({ exitCode: 0, signal: null });
  }

  onData(listener: (data: string) => void): () => void {
    this.dataListeners.add(listener);
    return () => this.dataListeners.delete(listener);
  }

  onExit(listener: (event: PtyAdapter.PtyExitEvent) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  emitExit(event: PtyAdapter.PtyExitEvent): void {
    for (const listener of this.exitListeners) listener(event);
  }
}

class FakePtyAdapter {
  readonly spawnInputs: PtyAdapter.PtySpawnInput[] = [];
  readonly processes: FakePtyProcess[] = [];
  failNextWrite = false;

  spawn(input: PtyAdapter.PtySpawnInput): Effect.Effect<PtyAdapter.PtyProcess> {
    this.spawnInputs.push(input);
    const process = new FakePtyProcess(14_000 + this.processes.length, this.failNextWrite);
    this.failNextWrite = false;
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
  const providerSessionId = `provider-session:${input.threadId}`;
  const providerThreadId = `provider-thread:${input.threadId}`;
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

function project(input: {
  readonly projectId: ProjectId;
  readonly workspaceRoot: string;
  readonly scripts: ReadonlyArray<ProjectScript>;
}): Project {
  return {
    id: input.projectId,
    title: "Script project",
    workspaceRoot: input.workspaceRoot,
    repositoryIdentity: null,
    faviconPath: null,
    defaultModelSelection: null,
    scripts: [...input.scripts],
    createdAt: "2026-08-29T00:00:00.000Z",
    updatedAt: "2026-08-29T00:00:00.000Z",
    deletedAt: null,
  };
}

describe("ProjectScriptMcpService", () => {
  it.effect("runs only saved scripts in dedicated managed terminals", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-project-script-mcp-" });
        const workspaceRoot = path.join(baseDir, "workspace");
        const worktreePath = path.join(baseDir, "worktree");
        const nestedExecutionCwd = path.join(worktreePath, "packages", "app");
        yield* fs.makeDirectory(workspaceRoot, { recursive: true });
        yield* fs.makeDirectory(nestedExecutionCwd, { recursive: true });

        const projectId = ProjectId.make("project:script-mcp");
        const missingProjectId = ProjectId.make("project:script-mcp-missing");
        const callerThreadId = ThreadId.make("thread:script-mcp-caller");
        const targetThreadId = ThreadId.make("thread:script-mcp-target");
        const restrictedThreadId = ThreadId.make("thread:script-mcp-restricted");
        const missingProjectThreadId = ThreadId.make("thread:script-mcp-missing-project");
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
        let savedScripts: ReadonlyArray<ProjectScript> = [
          {
            id: "dev",
            name: "Development server",
            command: "pnpm run dev",
            icon: "play",
            runOnWorktreeCreate: false,
            previewUrl: "http://localhost:3000",
            autoOpenPreview: true,
          },
          {
            id: "test",
            name: "Tests",
            command: "pnpm test",
            icon: "test",
            runOnWorktreeCreate: false,
          },
        ];
        const ptyAdapter = new FakePtyAdapter();
        const manager = yield* TerminalManager.makeWithOptions({
          logsDir: path.join(baseDir, "terminal-history"),
          ptyAdapter,
          processKillGraceMs: 1,
        });
        const replacementAdmissionEntered = yield* Deferred.make<void>();
        const replacementAdmissionRelease = yield* Deferred.make<void>();
        const exitAdmissionEntered = yield* Deferred.make<void>();
        const exitAdmissionRelease = yield* Deferred.make<void>();
        let replacementAdmissionAttempts = 0;
        const gatedManager = TerminalManager.TerminalManager.of({
          ...manager,
          admitRunningSessionHandle: (input, onAdmitted) => {
            if (
              input.terminalId === "term-script-registration-replacement" &&
              replacementAdmissionAttempts++ === 0
            ) {
              return Deferred.succeed(replacementAdmissionEntered, undefined).pipe(
                Effect.andThen(Deferred.await(replacementAdmissionRelease)),
                Effect.andThen(manager.admitRunningSessionHandle(input, onAdmitted)),
              );
            }
            if (input.terminalId === "term-script-registration-exit") {
              return Deferred.succeed(exitAdmissionEntered, undefined).pipe(
                Effect.andThen(Deferred.await(exitAdmissionRelease)),
                Effect.andThen(manager.admitRunningSessionHandle(input, onAdmitted)),
              );
            }
            return manager.admitRunningSessionHandle(input, onAdmitted);
          },
        });
        const threadDispatch = yield* makeKeyedSerialExecutor<ThreadId>();
        const threads = ThreadManagementService.of({
          getThreadProjection: (threadId: ThreadId) =>
            projections.has(threadId)
              ? Effect.succeed(projections.get(threadId)!)
              : Effect.fail(new Error("missing projection") as never),
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
                  new ThreadManagementThreadNotFoundError({
                    projectId: expectedProjectId,
                    threadId,
                  }),
                );
          },
        } as unknown as ThreadManagementService["Service"]);
        const projects = ProjectService.ProjectService.of({
          getById: (requestedProjectId: ProjectId) =>
            Effect.succeed(
              requestedProjectId === projectId
                ? Option.some(project({ projectId, workspaceRoot, scripts: savedScripts }))
                : Option.none(),
            ),
        } as unknown as ProjectService.ProjectService["Service"]);
        const terminalService = yield* TerminalMcpService.make.pipe(
          Effect.provideService(ThreadManagementService, threads),
          Effect.provideService(ProjectService.ProjectService, projects),
          Effect.provideService(TerminalManager.TerminalManager, gatedManager),
          Effect.provideService(ThreadCommandExecutor, threadDispatch),
        );
        let afterCloseOwned: (() => Effect.Effect<void>) | null = null;
        const terminalServiceWithCloseGate = TerminalMcpService.TerminalMcpService.of({
          ...terminalService,
          closeOwned: (scope, input) =>
            terminalService.closeOwned(scope, input).pipe(
              Effect.tap((closed) => {
                const action = afterCloseOwned;
                afterCloseOwned = null;
                return closed && action !== null ? action() : Effect.void;
              }),
            ),
        });
        const service = yield* ProjectScriptMcpService.make.pipe(
          Effect.provideService(
            TerminalMcpService.TerminalMcpService,
            terminalServiceWithCloseGate,
          ),
          Effect.provideService(TerminalManager.TerminalManager, gatedManager),
        );
        const scope: McpInvocationScope = {
          environmentId: EnvironmentId.make("environment:script-mcp"),
          threadId: callerThreadId,
          providerSessionId: "provider-session:script-mcp",
          providerInstanceId: ProviderInstanceId.make("codex"),
          capabilities: new Set(["orchestration"]),
          issuedAt: 1,
        };
        const page = yield* service.list(scope, {
          threadId: targetThreadId,
          limit: 1,
          commandPreviewChars: 5,
        });
        expect(page).toMatchObject({
          threadId: targetThreadId,
          projectId,
          total: 2,
          nextCursor: 1,
          scripts: [
            {
              scriptId: "dev",
              commandPreview: "pnpm ",
              commandCharacters: 12,
              commandTruncated: true,
              previewUrl: "http://localhost:3000",
              autoOpenPreview: true,
            },
          ],
        });
        assert.equal(ptyAdapter.spawnInputs.length, 0);

        const unknownScript = yield* service
          .run(scope, {
            threadId: targetThreadId,
            scriptId: "missing",
            terminalId: "term-script-missing",
          })
          .pipe(Effect.flip);
        assert.equal(unknownScript.code, "script_not_found");
        const unknownThread = yield* service
          .list(scope, { threadId: ThreadId.make("thread:script-mcp-unknown") })
          .pipe(Effect.flip);
        assert.equal(unknownThread.code, "thread_not_found");
        const missingProject = yield* service
          .list({ ...scope, threadId: missingProjectThreadId }, {})
          .pipe(Effect.flip);
        assert.equal(missingProject.code, "project_not_found");
        const denied = yield* service
          .run(scope, {
            threadId: restrictedThreadId,
            scriptId: "dev",
            terminalId: "term-script-denied",
          })
          .pipe(Effect.flip);
        assert.equal(denied.code, "execution_policy_denied");
        assert.equal(ptyAdapter.spawnInputs.length, 0);

        const first = yield* service.run(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: "term-script-first",
        });
        assert.equal(first.outcome, "input_accepted");
        assert.equal(first.terminalId, "term-script-first");
        assert.equal(first.previewAutoOpened, false);
        assert.equal(first.terminal.worktreePath, worktreePath);
        assert.equal(ptyAdapter.spawnInputs[0]?.cwd, nestedExecutionCwd);
        assert.equal(ptyAdapter.spawnInputs[0]?.env?.T3CODE_PROJECT_ROOT, workspaceRoot);
        assert.equal(ptyAdapter.spawnInputs[0]?.env?.T3CODE_WORKTREE_PATH, worktreePath);
        expect(ptyAdapter.processes[0]?.writes).toEqual(["pnpm run dev\r"]);

        const duplicate = yield* service
          .run(scope, {
            threadId: targetThreadId,
            scriptId: "dev",
            terminalId: first.terminalId,
          })
          .pipe(Effect.flip);
        assert.equal(duplicate.code, "terminal_already_exists");
        assert.equal(ptyAdapter.spawnInputs.length, 1);

        const second = yield* service.run(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: "term-script-second",
        });
        assert.notEqual(second.terminalId, first.terminalId);
        assert.equal(ptyAdapter.spawnInputs.length, 2);
        expect(ptyAdapter.processes[1]?.writes).toEqual(["pnpm run dev\r"]);

        const unrelatedStop = yield* service
          .stop(scope, {
            threadId: targetThreadId,
            scriptId: "test",
            terminalId: second.terminalId,
          })
          .pipe(Effect.flip);
        assert.equal(unrelatedStop.code, "script_run_not_found");
        const stopped = yield* service.stop(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: first.terminalId,
        });
        assert.isTrue(stopped.stopped);
        assert.equal(
          yield* manager.inspectSession({ threadId: targetThreadId, terminalId: first.terminalId }),
          null,
        );

        const stopRaceA = yield* service.run(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: "term-script-stop-reopen-race",
        });
        afterCloseOwned = () =>
          service
            .run(scope, {
              threadId: targetThreadId,
              scriptId: "dev",
              terminalId: stopRaceA.terminalId,
            })
            .pipe(Effect.orDie, Effect.asVoid);
        assert.isTrue(
          (yield* service.stop(scope, {
            threadId: targetThreadId,
            scriptId: "dev",
            terminalId: stopRaceA.terminalId,
          })).stopped,
        );
        assert.isTrue(
          (yield* service.stop(scope, {
            threadId: targetThreadId,
            scriptId: "dev",
            terminalId: stopRaceA.terminalId,
          })).stopped,
        );

        savedScripts = savedScripts.filter((script) => script.id !== "dev");
        const stoppedAfterDefinitionRemoval = yield* service.stop(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: second.terminalId,
        });
        assert.isTrue(stoppedAfterDefinitionRemoval.stopped);
        savedScripts = [
          {
            id: "dev",
            name: "Development server",
            command: "pnpm run dev",
            icon: "play",
            runOnWorktreeCreate: false,
            previewUrl: "http://localhost:3000",
            autoOpenPreview: true,
          },
          ...savedScripts,
        ];

        const externallyClosed = yield* service.run(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: "term-script-external-close",
        });
        yield* manager.close({
          threadId: targetThreadId,
          terminalId: externallyClosed.terminalId,
        });
        yield* manager.openFresh({
          threadId: targetThreadId,
          terminalId: externallyClosed.terminalId,
          cwd: nestedExecutionCwd,
          worktreePath,
          cols: 120,
          rows: 30,
        });
        const staleClose = yield* service
          .stop(scope, {
            threadId: targetThreadId,
            scriptId: "dev",
            terminalId: externallyClosed.terminalId,
          })
          .pipe(Effect.flip);
        assert.equal(staleClose.code, "script_run_not_found");
        assert.equal(
          (yield* manager.inspectSession({
            threadId: targetThreadId,
            terminalId: externallyClosed.terminalId,
          }))?.status,
          "running",
        );
        yield* manager.close({
          threadId: targetThreadId,
          terminalId: externallyClosed.terminalId,
        });

        const externallyRestarted = yield* service.run(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: "term-script-external-restart",
        });
        yield* manager.restart({
          threadId: targetThreadId,
          terminalId: externallyRestarted.terminalId,
          cwd: nestedExecutionCwd,
          worktreePath,
          cols: 120,
          rows: 30,
        });
        const staleRestart = yield* service
          .stop(scope, {
            threadId: targetThreadId,
            scriptId: "dev",
            terminalId: externallyRestarted.terminalId,
          })
          .pipe(Effect.flip);
        assert.equal(staleRestart.code, "script_run_not_found");
        assert.equal(
          (yield* manager.inspectSession({
            threadId: targetThreadId,
            terminalId: externallyRestarted.terminalId,
          }))?.status,
          "running",
        );
        yield* manager.close({
          threadId: targetThreadId,
          terminalId: externallyRestarted.terminalId,
        });

        const staleRegistration = yield* service
          .run(scope, {
            threadId: targetThreadId,
            scriptId: "dev",
            terminalId: "term-script-registration-replacement",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(replacementAdmissionEntered);
        yield* manager.close({
          threadId: targetThreadId,
          terminalId: "term-script-registration-replacement",
        });
        const replacementRegistration = yield* service.run(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: "term-script-registration-replacement",
        });
        assert.equal(replacementRegistration.outcome, "input_accepted");
        yield* Deferred.succeed(replacementAdmissionRelease, undefined);
        const changedBeforeRegistration = yield* Fiber.join(staleRegistration).pipe(Effect.flip);
        assert.equal(changedBeforeRegistration.code, "terminal_not_found");
        assert.isTrue(
          (yield* service.stop(scope, {
            threadId: targetThreadId,
            scriptId: "dev",
            terminalId: "term-script-registration-replacement",
          })).stopped,
        );

        const registrationExitObserved = yield* Deferred.make<void>();
        const unsubscribeRegistrationExit = yield* manager.subscribe((event) =>
          event.type === "exited" && event.terminalId === "term-script-registration-exit"
            ? Deferred.succeed(registrationExitObserved, undefined)
            : Effect.void,
        );
        const exitedBeforeRegistration = yield* service
          .run(scope, {
            threadId: targetThreadId,
            scriptId: "dev",
            terminalId: "term-script-registration-exit",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(exitAdmissionEntered);
        const exitingProcess = ptyAdapter.processes.at(-1);
        expect(exitingProcess).toBeDefined();
        exitingProcess?.kill();
        yield* Deferred.await(registrationExitObserved);
        yield* Deferred.succeed(exitAdmissionRelease, undefined);
        const exitedRegistration = yield* Fiber.join(exitedBeforeRegistration).pipe(Effect.flip);
        assert.equal(exitedRegistration.code, "terminal_not_found");
        const exitedRegistrationStop = yield* service
          .stop(scope, {
            threadId: targetThreadId,
            scriptId: "dev",
            terminalId: "term-script-registration-exit",
          })
          .pipe(Effect.flip);
        assert.equal(exitedRegistrationStop.code, "script_run_not_found");
        assert.equal(
          (yield* manager.inspectSession({
            threadId: targetThreadId,
            terminalId: "term-script-registration-exit",
          }))?.status,
          "exited",
        );
        unsubscribeRegistrationExit();
        yield* manager.close({
          threadId: targetThreadId,
          terminalId: "term-script-registration-exit",
        });

        const scriptStarted = yield* Deferred.make<void>();
        const releaseStarted = yield* Deferred.make<void>();
        const unsubscribeStarted = yield* manager.subscribe((event) =>
          event.type === "started" && event.terminalId === "term-script-interrupted"
            ? Deferred.succeed(scriptStarted, undefined).pipe(
                Effect.andThen(Deferred.await(releaseStarted)),
              )
            : Effect.void,
        );
        const interruptedRun = yield* service
          .run(scope, {
            threadId: targetThreadId,
            scriptId: "dev",
            terminalId: "term-script-interrupted",
          })
          .pipe(Effect.forkChild);
        yield* Deferred.await(scriptStarted);
        const interruption = yield* Fiber.interrupt(interruptedRun).pipe(Effect.forkChild);
        yield* Deferred.succeed(releaseStarted, undefined);
        yield* Fiber.join(interruption);
        unsubscribeStarted();
        const stoppedInterruptedRun = yield* service.stop(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: "term-script-interrupted",
        });
        assert.isTrue(stoppedInterruptedRun.stopped);

        ptyAdapter.failNextWrite = true;
        const partial = yield* service.run(scope, {
          threadId: targetThreadId,
          scriptId: "test",
          terminalId: "term-script-partial",
        });
        assert.equal(partial.outcome, "terminal_opened_input_failed");
        assert.equal(partial.inputAcceptance, null);
        assert.equal(
          partial.error,
          "The terminal was opened, but its saved script input was not accepted.",
        );
        assert.notInclude(partial.error ?? "", "script PTY write failed");
        assert.isNotNull(
          yield* manager.inspectSession({
            threadId: targetThreadId,
            terminalId: partial.terminalId,
          }),
        );
        yield* service.stop(scope, {
          threadId: targetThreadId,
          scriptId: "test",
          terminalId: partial.terminalId,
        });

        const queuedDrains: Array<Effect.Effect<void>> = [];
        const queuedPtyAdapter = new FakePtyAdapter();
        const queuedManager = yield* TerminalManager.makeWithOptions({
          logsDir: path.join(baseDir, "queued-terminal-history"),
          ptyAdapter: queuedPtyAdapter,
          processKillGraceMs: 1,
          processEventDrainRunner: (effect) => {
            queuedDrains.push(effect);
          },
        });
        const queuedTerminalService = yield* TerminalMcpService.make.pipe(
          Effect.provideService(ThreadManagementService, threads),
          Effect.provideService(ProjectService.ProjectService, projects),
          Effect.provideService(TerminalManager.TerminalManager, queuedManager),
          Effect.provideService(ThreadDispatchLockV2, threadDispatch),
        );
        const queuedScriptService = yield* ProjectScriptMcpService.make.pipe(
          Effect.provideService(TerminalMcpService.TerminalMcpService, queuedTerminalService),
          Effect.provideService(TerminalManager.TerminalManager, queuedManager),
        );
        const queuedExitRun = yield* queuedScriptService.run(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: "term-script-clear-queued-exit",
        });
        assert.equal(queuedExitRun.outcome, "input_accepted");
        const queuedExitProcess = queuedPtyAdapter.processes[0];
        expect(queuedExitProcess).toBeDefined();
        if (!queuedExitProcess) return;
        queuedExitProcess.emitExit({ exitCode: 23, signal: null });
        expect(queuedDrains).toHaveLength(1);

        yield* queuedManager.clear({
          threadId: targetThreadId,
          terminalId: queuedExitRun.terminalId,
        });
        yield* queuedDrains[0]!;
        expect(
          yield* queuedManager.inspectSession({
            threadId: targetThreadId,
            terminalId: queuedExitRun.terminalId,
          }),
        ).toMatchObject({ status: "exited", exitCode: 23 });
        const clearedOwnership = yield* queuedScriptService
          .stop(scope, {
            threadId: targetThreadId,
            scriptId: "dev",
            terminalId: queuedExitRun.terminalId,
          })
          .pipe(Effect.flip);
        assert.equal(clearedOwnership.code, "script_run_not_found");

        yield* queuedManager.close({
          threadId: targetThreadId,
          terminalId: queuedExitRun.terminalId,
        });
        const replacementAfterExit = yield* queuedScriptService.run(scope, {
          threadId: targetThreadId,
          scriptId: "dev",
          terminalId: queuedExitRun.terminalId,
        });
        assert.equal(replacementAfterExit.outcome, "input_accepted");
        assert.isTrue(
          (yield* queuedScriptService.stop(scope, {
            threadId: targetThreadId,
            scriptId: "dev",
            terminalId: replacementAfterExit.terminalId,
          })).stopped,
        );

        savedScripts = [
          ...savedScripts,
          {
            id: "too-large",
            name: "Too large",
            command: "x".repeat(65_536),
            icon: "build",
            runOnWorktreeCreate: false,
          },
        ];
        const spawnsBeforeTooLarge = ptyAdapter.spawnInputs.length;
        const tooLarge = yield* service
          .run(scope, {
            threadId: targetThreadId,
            scriptId: "too-large",
            terminalId: "term-script-too-large",
          })
          .pipe(Effect.flip);
        assert.equal(tooLarge.code, "script_command_too_large");
        assert.equal(ptyAdapter.spawnInputs.length, spawnsBeforeTooLarge);
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

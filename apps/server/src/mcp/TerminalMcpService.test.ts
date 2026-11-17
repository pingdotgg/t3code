import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  type OrchestrationV2ThreadShell,
  type Project,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  TerminalMcpReadInput,
  ThreadId,
} from "@t3tools/contracts";
import type * as PtyAdapter from "@t3tools/shared/PtyAdapter";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import type * as McpInvocationContext from "./McpInvocationContext.ts";
import * as TerminalMcpService from "./TerminalMcpService.ts";

const threadId = ThreadId.make("thread-terminal-test");
const otherThreadId = ThreadId.make("thread-terminal-other");
const projectId = ProjectId.make("project-terminal-test");

const scopeFor = (id: ThreadId): McpInvocationContext.McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("environment-terminal-test"),
  requestNamespace: "provider-session-terminal-test",
  thread: {
    threadId: id,
    providerSessionId: "provider-session-terminal-test",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 1,
});
const scope = scopeFor(threadId);

class FakePtyProcess implements PtyAdapter.PtyProcess {
  readonly writes: string[] = [];
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(event: PtyAdapter.PtyExitEvent) => void>();

  readonly pid: number;
  private readonly prompt: string;

  constructor(pid: number, prompt: string) {
    this.pid = pid;
    this.prompt = prompt;
  }

  write(data: string) {
    this.writes.push(data);
  }
  resize() {}
  kill() {
    this.emitExit({ exitCode: 0, signal: null });
  }
  onData(callback: (data: string) => void) {
    this.dataListeners.add(callback);
    if (this.prompt) callback(this.prompt);
    return () => this.dataListeners.delete(callback);
  }
  onExit(callback: (event: PtyAdapter.PtyExitEvent) => void) {
    this.exitListeners.add(callback);
    return () => this.exitListeners.delete(callback);
  }
  emitData(data: string) {
    for (const listener of this.dataListeners) listener(data);
  }
  emitExit(event: PtyAdapter.PtyExitEvent) {
    for (const listener of this.exitListeners) listener(event);
  }
}

const makeFixture = (options: { readonly runtimeMode?: RuntimeMode } = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-terminal-mcp-" });
    const worktreePath = `${baseDir}/worktree`;
    yield* fs.makeDirectory(worktreePath);
    const processes: FakePtyProcess[] = [];
    const spawns: PtyAdapter.PtySpawnInput[] = [];
    const manager = yield* TerminalManager.makeWithOptions({
      logsDir: `${baseDir}/logs`,
      ptyAdapter: {
        spawn: (input) =>
          Effect.sync(() => {
            spawns.push(input);
            const process = new FakePtyProcess(7000 + processes.length, "\x1b[?2004h$ ");
            processes.push(process);
            return process;
          }),
      },
      subprocessInspector: () =>
        Effect.succeed({ hasRunningSubprocess: false, childCommand: null, processIds: [] }),
      processKillGraceMs: 0,
    });
    const shell = {
      id: threadId,
      projectId,
      worktreePath,
      runtimeMode: options.runtimeMode ?? "full-access",
      interactionMode: "default",
      deletedAt: null,
    } as unknown as OrchestrationV2ThreadShell;
    const service = yield* TerminalMcpService.make.pipe(
      Effect.provide(
        Layer.mergeAll(
          Layer.succeed(TerminalManager.TerminalManager, manager),
          Layer.mock(ThreadManagementService.ThreadManagementService)({
            getThreadShell: (id) => Effect.succeed(id === threadId ? shell : null),
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () => Effect.succeedSome({ workspaceRoot: baseDir } as Project),
          }),
        ),
      ),
    );
    return { manager, service, processes, spawns, worktreePath };
  });

const readInput = Schema.decodeUnknownSync(TerminalMcpReadInput);

const layer = Layer.mergeAll(
  NodeServices.layer,
  NodeCrypto.layer,
  ProcessRunner.layer.pipe(Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))),
);

it.layer(layer)("TerminalMcpService", (it) => {
  it.effect("starts a terminal in the worktree, runs the command, and reads plain text", () =>
    Effect.gen(function* () {
      const { service, manager, processes, spawns, worktreePath } = yield* makeFixture();
      const started = yield* service.start(scope, { command: "make", title: "Build" });

      expect(started.terminalId).toMatch(/^agent-[\da-f]{8}$/);
      expect(spawns[0]?.cwd).toBe(worktreePath);
      expect(spawns[0]?.env.T3CODE_WORKTREE_PATH).toBe(worktreePath);
      expect(processes[0]?.writes).toEqual(["make\r"]);
      const [summary] = yield* manager.listThread(threadId);
      expect([summary?.controller, summary?.label]).toEqual(["agent", "Build"]);

      processes[0]?.emitData("make\r\n\x1b[32mbuilding\x1b[0m 10%\r\x1b[Kbuilt 100%\r\n$ ");
      const read = yield* service.read(
        scope,
        readInput({
          terminalId: started.terminalId,
          cursor: started.cursor,
          waitFor: "match",
          pattern: "100%",
        }),
      );
      assert.deepStrictEqual(read, {
        text: "$ make\nbuilt 100%\n$",
        cursor: read.cursor,
        truncated: false,
        status: "running",
        exitCode: null,
        controller: "agent",
        waited: "matched",
      });

      const tail = yield* service.read(
        scope,
        readInput({ terminalId: started.terminalId, cursor: 0, maxBytes: 256 }),
      );
      expect(tail.text).toBe("$ make\nbuilt 100%\n$");
    }),
  );

  it.effect("refuses agent input while the user has control and allows it again once given", () =>
    Effect.gen(function* () {
      const { service, manager, processes } = yield* makeFixture();
      const { terminalId } = yield* service.start(scope, {});
      const target = { threadId, terminalId };

      yield* manager.write({ ...target, data: "q" }, undefined, "user");
      const refused = yield* service.send(scope, { terminalId, data: "ls\r" }).pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "TerminalMcpFailure", code: "user_has_control" });
      const closeRefused = yield* service.close(scope, { terminalId }).pipe(Effect.flip);
      expect(closeRefused).toMatchObject({ code: "user_has_control" });
      const read = yield* service.read(scope, readInput({ terminalId }));
      expect(read.controller).toBe("user");

      yield* manager.setController({ ...target, controller: "agent" });
      yield* service.send(scope, { terminalId, data: "ls\r" });
      expect(processes[0]?.writes).toEqual(["q", "ls\r"]);
      yield* service.close(scope, { terminalId });
      expect(yield* manager.listThread(threadId)).toEqual([]);
    }),
  );

  it.effect("reads user terminals and stays within the calling thread", () =>
    Effect.gen(function* () {
      const { service, manager, worktreePath } = yield* makeFixture();
      yield* manager.open({ threadId, terminalId: "term-1", cwd: worktreePath });
      yield* manager.open({ threadId: otherThreadId, terminalId: "term-1", cwd: worktreePath });

      const { terminals } = yield* service.list(scope);
      expect(terminals.map((terminal) => [terminal.terminalId, terminal.controller])).toEqual([
        ["term-1", "user"],
      ]);
      expect((yield* service.read(scope, readInput({ terminalId: "term-1" }))).text).toBe("$");
      const sent = yield* service
        .send(scope, { terminalId: "term-1", data: "ls\r" })
        .pipe(Effect.flip);
      expect(sent).toMatchObject({ code: "user_has_control" });
      const other = yield* service
        .read(scopeFor(otherThreadId), readInput({ terminalId: "agent-missing" }))
        .pipe(Effect.flip);
      expect(other).toMatchObject({ code: "terminal_not_found" });
    }),
  );

  it.effect("needs Full access to start, send, or close", () =>
    Effect.gen(function* () {
      const { service } = yield* makeFixture({ runtimeMode: "approval-required" });
      const refused = yield* service.start(scope, { command: "make" }).pipe(Effect.flip);
      expect(refused).toMatchObject({ _tag: "OrchestratorMcpFailure", code: "capability_denied" });
      expect((yield* service.list(scope)).terminals).toEqual([]);
    }),
  );

  it.effect("ends waits on exit, on quiet, and at the timeout", () =>
    Effect.gen(function* () {
      const { service, processes } = yield* makeFixture();
      const { terminalId, cursor } = yield* service.start(scope, {});

      const quiet = yield* service
        .read(scope, readInput({ terminalId, cursor, waitFor: "quiet", quietMs: 500 }))
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("500 millis");
      expect((yield* Fiber.join(quiet)).waited).toBe("quiet");

      const timedOut = yield* service
        .read(
          scope,
          readInput({ terminalId, cursor, waitFor: "match", pattern: "never", timeoutMs: 1_000 }),
        )
        .pipe(Effect.forkChild({ startImmediately: true }));
      yield* TestClock.adjust("1 second");
      expect((yield* Fiber.join(timedOut)).waited).toBe("timeout");

      const exited = yield* service
        .read(scope, readInput({ terminalId, cursor, waitFor: "exit" }))
        .pipe(Effect.forkChild({ startImmediately: true }));
      processes[0]?.emitExit({ exitCode: 2, signal: null });
      const result = yield* Fiber.join(exited);
      expect([result.waited, result.status, result.exitCode]).toEqual(["exited", "exited", 2]);
    }),
  );
});

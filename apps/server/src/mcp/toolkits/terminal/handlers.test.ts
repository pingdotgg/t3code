import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  type RuntimeMode,
  type TerminalOpenInput,
  TerminalNotRunningError,
  type TerminalSessionSnapshot,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadTerminalLauncher from "../../../terminal/ThreadTerminalLauncher.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as TerminalHandlers from "./handlers.ts";
import { TerminalToolkit } from "./tools.ts";

const callerId = ThreadId.make("terminal-caller");
const worktreeThreadId = ThreadId.make("terminal-worktree-thread");
const projectId = ProjectId.make("project:mcp-test");
const worktreePath = "/workspace/worktrees/feature";

interface TerminalToolInput {
  readonly threadId?: ThreadId;
  readonly cwd?: string;
  readonly env?: TerminalOpenInput["env"];
  readonly command?: string;
  readonly terminalId?: string;
}

interface Options {
  readonly error?: ThreadTerminalLauncher.ThreadTerminalLaunchError;
  readonly callerMode?: RuntimeMode;
  readonly capabilities?: ReadonlyArray<McpInvocationContext.McpCapability>;
}

const openTerminal = (input: TerminalToolInput, options: Options = {}) =>
  Effect.gen(function* () {
    const calls: Array<ThreadTerminalLauncher.ThreadTerminalLaunchInput> = [];
    const snapshot: TerminalSessionSnapshot = {
      threadId: worktreeThreadId,
      terminalId: "session-terminal",
      cwd: "/session/cwd",
      worktreePath,
      status: "running",
      pid: 4242,
      history: "",
      exitCode: null,
      exitSignal: null,
      label: "session-terminal",
      updatedAt: "2026-01-01T00:00:00.000Z",
    };
    const shells = new Map([
      [callerId, liveThreadShell(callerId, { runtimeMode: options.callerMode ?? "full-access" })],
      [worktreeThreadId, { ...liveThreadShell(worktreeThreadId), worktreePath }],
    ]);
    const scope: McpInvocationContext.McpInvocationScope = {
      environmentId: EnvironmentId.make("terminal-environment"),
      requestNamespace: "terminal-provider-session",
      thread: {
        threadId: callerId,
        providerSessionId: "terminal-provider-session",
        providerInstanceId: ProviderInstanceId.make("codex"),
      },
      client: undefined,
      capabilities: new Set(options.capabilities ?? ["orchestration"]),
      issuedAt: 0,
    };
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, scope),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (threadId) => Effect.succeed(shells.get(threadId) ?? null),
        getProjectThreadRecords: ({ threadId }) =>
          Effect.succeed({ thread: shells.get(threadId) } as never),
      }),
      Layer.mock(ThreadTerminalLauncher.ThreadTerminalLauncher)({
        open: (input) => {
          calls.push(input);
          return options.error ? Effect.fail(options.error) : Effect.succeed(snapshot);
        },
      }),
    );
    const toolkit = yield* TerminalToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(TerminalHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const result = yield* toolkit
      .handle("t3_terminal_open", input)
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return { result: result.at(-1)?.result, calls, snapshot };
  });

it.effect("maps the session snapshot and passes the thread and input to the launcher", () =>
  Effect.gen(function* () {
    const input = {
      threadId: worktreeThreadId,
      cwd: "packages/app",
      env: { FOO: "bar" },
      command: "echo hello",
      terminalId: "login",
    };
    const { result, calls, snapshot } = yield* openTerminal(input);
    expect(calls).toEqual([
      {
        thread: { id: worktreeThreadId, projectId, worktreePath },
        cwd: input.cwd,
        env: input.env,
        command: input.command,
        terminalId: input.terminalId,
      },
    ]);
    expect(result).toEqual({
      threadId: snapshot.threadId,
      terminalId: snapshot.terminalId,
      cwd: snapshot.cwd,
      pid: snapshot.pid,
      status: snapshot.status,
    });
  }),
);

it.effect("maps a cwd outside the workspace to invalid_request", () =>
  Effect.gen(function* () {
    const error = new ThreadTerminalLauncher.ThreadTerminalCwdOutsideWorkspaceError({
      threadId: callerId,
    });
    const { result, calls } = yield* openTerminal({}, { error });
    expect(result).toMatchObject({ code: "invalid_request", message: error.message });
    expect(calls).toHaveLength(1);
  }),
);

it.effect("maps other terminal errors to orchestration_error", () =>
  Effect.gen(function* () {
    const error = new TerminalNotRunningError({ threadId: callerId, terminalId: "login" });
    const { result, calls } = yield* openTerminal({}, { error });
    expect(result).toMatchObject({ code: "orchestration_error" });
    expect(calls).toHaveLength(1);
  }),
);

it.effect("rejects an unknown thread", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* openTerminal({ threadId: ThreadId.make("missing-thread") });
    expect(result).toMatchObject({ code: "thread_not_found" });
    expect(calls).toEqual([]);
  }),
);

it.effect("rejects callers that are not full-access", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* openTerminal({}, { callerMode: "approval-required" });
    expect(result).toMatchObject({ code: "capability_denied" });
    expect(calls).toEqual([]);
  }),
);

it.effect("rejects credentials without orchestration capability", () =>
  Effect.gen(function* () {
    const { result, calls } = yield* openTerminal({}, { capabilities: [] });
    expect(result).toMatchObject({ code: "capability_denied" });
    expect(calls).toEqual([]);
  }),
);

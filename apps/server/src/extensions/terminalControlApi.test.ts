import {
  AuthTerminalOperateScope,
  ProjectId,
  ThreadId,
  extensionWorkspaceRevision,
  type TerminalSessionSnapshot,
  type TerminalSummary,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, expect } from "@effect/vitest";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as ProcessRunner from "../processRunner.ts";
import * as TerminalManager from "../terminal/Manager.ts";
import * as NodePtyAdapter from "../terminal/NodePtyAdapter.ts";
import { createTerminalControlApiProvider } from "./terminalControlApi.ts";

class MarkerPending extends Data.TaggedError("MarkerPending")<{}> {}

const context = {
  resource: {
    namespace: "test.extension",
    id: "surface",
    environmentId: "env",
    projectId: "project",
    threadId: "thread",
  },
  client: "test",
  workspaceRevision: extensionWorkspaceRevision("/workspace", null),
} as const;
const authority = {
  kind: "environment-session" as const,
  id: "session",
  environmentId: "env",
  scopes: [AuthTerminalOperateScope],
};
const signal = new AbortController().signal;

const snapshotOf = (terminalId: string, extra: Partial<TerminalSessionSnapshot> = {}) =>
  ({
    threadId: "thread",
    terminalId,
    cwd: "/workspace",
    worktreePath: null,
    status: "running",
    pid: 11,
    history: "",
    exitCode: null,
    exitSignal: null,
    label: "zsh",
    updatedAt: "2026-09-12T00:00:00Z",
    ...extra,
  }) satisfies TerminalSessionSnapshot;

type TerminalStub = Pick<
  TerminalManager.TerminalManager["Service"],
  | "open"
  | "openOrAttach"
  | "inspect"
  | "write"
  | "resize"
  | "clear"
  | "restart"
  | "close"
  | "subscribeMetadata"
>;
type Deps = Parameters<typeof createTerminalControlApiProvider>[0];

interface RecordedCall {
  readonly method: string;
  readonly input: unknown;
}
const makeDeps = (overrides: Partial<TerminalStub> = {}) => {
  const calls: RecordedCall[] = [];
  const record =
    <I, O>(method: string, result: O) =>
    (input: I) => {
      calls.push({ method, input });
      return Effect.succeed(result);
    };
  const summaryOf = (terminalId: string) => ({
    ...snapshotOf(terminalId),
    hasRunningSubprocess: false,
  });
  const terminal = {
    open: overrides.open ?? record("open", snapshotOf("term-1")),
    openOrAttach: overrides.openOrAttach ?? record("attach", snapshotOf("term-1")),
    inspect: overrides.inspect ?? record("inspect", summaryOf("term-1")),
    write: overrides.write ?? record("write", undefined),
    resize: overrides.resize ?? record("resize", undefined),
    clear: overrides.clear ?? record("clear", undefined),
    restart: overrides.restart ?? record("restart", snapshotOf("term-1")),
    close: overrides.close ?? record("close", undefined),
    subscribeMetadata: overrides.subscribeMetadata ?? ((_listener) => Effect.succeed(() => {})),
  } as TerminalStub;
  const deps: Deps = {
    environmentId: "env",
    projects: {
      getById: (input: { projectId: ProjectId }) =>
        Effect.succeed(
          Option.some({
            projectId: input.projectId,
            workspaceRoot: "/workspace",
            deletedAt: null,
          }),
        ),
    },
    threads: {
      getById: (_input: { threadId: ThreadId }) =>
        Effect.succeed(
          Option.some({
            projectId: ProjectId.make("project"),
            worktreePath: null,
            deletedAt: null,
          }),
        ),
    },
    terminal,
  };
  return { calls, deps };
};
const meta = (
  provider: { providerId: string },
  scopes: readonly string[] = [AuthTerminalOperateScope],
) => ({
  callId: "call",
  rootCallerId: "root",
  callerId: "caller",
  providerId: provider.providerId,
  providerGeneration: 1,
  callerGenerations: [],
  principal: { ...authority, scopes },
});
const invoke = (
  provider: ReturnType<typeof createTerminalControlApiProvider>,
  method: string,
  input: Parameters<ReturnType<typeof createTerminalControlApiProvider>["invoke"]>[1],
  scopes?: readonly string[],
) => provider.invoke(method, input, context, signal, meta(provider, scopes));

it("denies control without the operate grant while read remains available elsewhere", async () => {
  const { calls, deps } = makeDeps();
  const provider = createTerminalControlApiProvider(deps);
  await expect(
    invoke(provider, "write", { terminalId: "t", data: "x" }, ["t3.terminal/read"]),
  ).rejects.toThrow("authority");
  await expect(
    provider.invoke("write", { terminalId: "t", data: "x" }, context, signal, {
      callId: "call",
      rootCallerId: "root",
      callerId: "caller",
      providerId: provider.providerId,
      providerGeneration: 1,
      callerGenerations: [],
    }),
  ).rejects.toThrow("authority");
  expect(calls).toHaveLength(0);
});

it("rejects unknown methods, injected threadId, and malformed input", async () => {
  const { calls, deps } = makeDeps();
  const provider = createTerminalControlApiProvider(deps);
  await expect(invoke(provider, "spawn", {})).rejects.toThrow("unavailable");
  await expect(
    invoke(provider, "write", { terminalId: "t", threadId: "other", data: "x" }),
  ).rejects.toThrow("thread");
  await expect(invoke(provider, "write", { terminalId: "t" })).rejects.toThrow("Invalid");
  await expect(
    invoke(provider, "write", { terminalId: "t", data: "x".repeat(65_537) }),
  ).rejects.toThrow("Invalid");
  await expect(invoke(provider, "resize", { terminalId: "t", cols: 0, rows: 24 })).rejects.toThrow(
    "Invalid",
  );
  await expect(
    invoke(provider, "resize", { terminalId: "t", cols: 80, rows: 501 }),
  ).rejects.toThrow("Invalid");
  expect(calls).toHaveLength(0);
});

it("injects the view thread and forwards every control op to the manager", async () => {
  const { calls, deps } = makeDeps();
  const provider = createTerminalControlApiProvider(deps);
  const opened = await invoke(provider, "open", { terminalId: "term-1", cwd: "/workspace" });
  expect(opened).toMatchObject({ terminalId: "term-1", status: "running" });
  await invoke(provider, "attach", { terminalId: "term-1", restartIfNotRunning: true });
  await invoke(provider, "write", { terminalId: "term-1", data: "echo hi\n" });
  await invoke(provider, "resize", { terminalId: "term-1", cols: 100, rows: 40 });
  await invoke(provider, "clear", { terminalId: "term-1" });
  await invoke(provider, "restart", {
    terminalId: "term-1",
    cwd: "/workspace",
    cols: 120,
    rows: 30,
  });
  await invoke(provider, "close", { terminalId: "term-1", deleteHistory: true });
  expect(calls.map((c) => c.method)).toEqual([
    "inspect", // open: pre-mutation scope check
    "open",
    "inspect", // open: result projection
    "inspect", // attach: pre-mutation scope check
    "attach",
    "inspect", // attach: result projection
    "inspect",
    "write",
    "inspect",
    "resize",
    "inspect",
    "clear",
    "inspect", // restart: pre-mutation scope check
    "restart",
    "inspect", // restart: result projection
    "inspect",
    "close",
  ]);
  for (const call of calls) expect(call.input).toMatchObject({ threadId: "thread" });
  expect(calls.at(-1)!.input).toMatchObject({ deleteHistory: true });
});

it("rejects launch cwd/worktree outside the resolved workspace scope", async () => {
  const { calls, deps } = makeDeps();
  const provider = createTerminalControlApiProvider(deps);
  await expect(invoke(provider, "open", { terminalId: "t", cwd: "/elsewhere" })).rejects.toThrow(
    "workspace",
  );
  await expect(
    invoke(provider, "restart", { terminalId: "t", cwd: "/elsewhere", cols: 80, rows: 24 }),
  ).rejects.toThrow("workspace");
  await expect(
    invoke(provider, "attach", { terminalId: "t", cwd: "/workspace", worktreePath: "/wt" }),
  ).rejects.toThrow("workspace");
  expect(calls).toHaveLength(0);
});

it("rejects results whose native identity leaves the scope", async () => {
  const { deps } = makeDeps({
    inspect: () =>
      Effect.succeed({
        threadId: "other",
        terminalId: "term-1",
        cwd: "/workspace",
        worktreePath: null,
        status: "running",
        pid: 1,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: false,
        label: "x",
        updatedAt: "ok",
      }),
  });
  const provider = createTerminalControlApiProvider(deps);
  await expect(
    invoke(provider, "open", { terminalId: "term-1", cwd: "/workspace" }),
  ).rejects.toThrow("unavailable");
});

it("denies mutation of sessions outside the resolved workspace scope", async () => {
  const { calls, deps } = makeDeps({
    inspect: () =>
      Effect.succeed({
        threadId: "thread",
        terminalId: "t",
        cwd: "/other-workspace",
        worktreePath: null,
        status: "running",
        pid: 1,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: false,
        label: "x",
        updatedAt: "ok",
      }),
  });
  const provider = createTerminalControlApiProvider(deps);
  for (const [method, input] of [
    ["write", { terminalId: "t", data: "x" }],
    ["resize", { terminalId: "t", cols: 80, rows: 24 }],
    ["clear", { terminalId: "t" }],
    ["close", { terminalId: "t" }],
    ["open", { terminalId: "t", cwd: "/workspace" }],
  ] as const) {
    await expect(invoke(provider, method, input)).rejects.toThrow("unavailable");
  }
  expect(calls.filter((call) => call.method !== "inspect")).toHaveLength(0);
});

it("scopes close-all to sessions visible in the resolved workspace", async () => {
  const inScope = {
    threadId: "thread",
    terminalId: "term-1",
    cwd: "/workspace",
    worktreePath: null,
    status: "running",
    pid: 1,
    exitCode: null,
    exitSignal: null,
    hasRunningSubprocess: false,
    label: "a",
    updatedAt: "ok",
  };
  const outOfScope = { ...inScope, terminalId: "term-2", cwd: "/other-workspace" };
  const { calls, deps } = makeDeps({
    subscribeMetadata: (listener) =>
      Effect.gen(function* () {
        yield* listener({
          type: "snapshot",
          terminals: [inScope, outOfScope] as TerminalSummary[],
        });
        return () => {};
      }),
  });
  const provider = createTerminalControlApiProvider(deps);
  await invoke(provider, "close", { deleteHistory: true });
  const closed = calls.filter((call) => call.method === "close").map((call) => call.input);
  expect(closed).toEqual([{ threadId: "thread", terminalId: "term-1", deleteHistory: true }]);
});

it("requires the worktree identity in a worktree-scoped view", async () => {
  const wtContext = {
    ...context,
    workspaceRevision: extensionWorkspaceRevision("/workspace", "/wt"),
  };
  const { calls, deps: baseDeps } = makeDeps({
    inspect: () =>
      Effect.succeed({
        threadId: "thread",
        terminalId: "term-1",
        cwd: "/wt",
        worktreePath: "/wt",
        status: "running",
        pid: 1,
        exitCode: null,
        exitSignal: null,
        hasRunningSubprocess: false,
        label: "x",
        updatedAt: "ok",
      }),
  });
  const deps: Deps = {
    ...baseDeps,
    threads: {
      getById: () =>
        Effect.succeed(
          Option.some({
            projectId: ProjectId.make("project"),
            worktreePath: "/wt",
            deletedAt: null,
          }),
        ),
    },
  };
  const provider = createTerminalControlApiProvider(deps);
  const wtInvoke = (method: string, input: Record<string, unknown>) =>
    provider.invoke(method, input as never, wtContext, signal, meta(provider));
  // An omitted worktreePath would spawn a session recorded with null identity —
  // invisible to this scope. Only the exact scoped identity may launch.
  await expect(wtInvoke("open", { terminalId: "t", cwd: "/wt" })).rejects.toThrow("workspace");
  await expect(
    wtInvoke("open", { terminalId: "t", cwd: "/wt", worktreePath: null }),
  ).rejects.toThrow("workspace");
  expect(calls.filter((call) => call.method !== "inspect")).toHaveLength(0);
  const opened = await wtInvoke("open", {
    terminalId: "term-1",
    cwd: "/wt",
    worktreePath: "/wt",
  });
  expect(opened).toMatchObject({ terminalId: "term-1" });
});

it("bounds native failures to a public error", async () => {
  const { deps } = makeDeps({ close: () => Effect.die("/private/pty/path") });
  const provider = createTerminalControlApiProvider(deps);
  await expect(invoke(provider, "close", { terminalId: "t" })).rejects.toThrow(
    "control operation failed",
  );
});

// HostProcessPlatform/Architecture are Context.References with host defaults.
const realPtyLayer = Layer.mergeAll(
  NodeServices.layer,
  ProcessRunner.layer.pipe(Layer.provide(NodeServices.layer)),
);

it.live("drives the full lifecycle against a real PTY", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-p07b-pty-" });
    const logsDir = path.join(baseDir, "logs");
    yield* fs.makeDirectory(logsDir, { recursive: true });
    const ptyAdapter = yield* NodePtyAdapter.make();
    const manager = yield* TerminalManager.makeWithOptions({
      logsDir,
      ptyAdapter,
      processKillGraceMs: 200,
    });

    const revision = extensionWorkspaceRevision(baseDir, null);
    const scoped = {
      ...context,
      workspaceRevision: revision,
    };
    const deps = {
      environmentId: "env",
      projects: {
        getById: (input: { projectId: ProjectId }) =>
          Effect.succeed(
            Option.some({
              projectId: input.projectId,
              workspaceRoot: baseDir,
              deletedAt: null,
            }),
          ),
      },
      threads: {
        getById: (_input: { threadId: ThreadId }) =>
          Effect.succeed(
            Option.some({
              projectId: ProjectId.make("project"),
              worktreePath: null,
              deletedAt: null,
            }),
          ),
      },
      terminal: manager,
    };
    const provider = createTerminalControlApiProvider(deps);
    const call = (method: string, input: Record<string, unknown>) =>
      Effect.promise(() =>
        Promise.resolve(
          provider.invoke(
            method,
            input as never,
            scoped,
            new AbortController().signal,
            meta(provider),
          ),
        ),
      );

    const opened = yield* call("open", {
      terminalId: "term-1",
      cwd: baseDir,
      cols: 80,
      rows: 24,
    });
    expect(opened).toMatchObject({ terminalId: "term-1" });

    yield* call("write", { terminalId: "term-1", data: "echo p07b-marker\n" });
    const seen = yield* manager.readOutput({ threadId: "thread", terminalId: "term-1" }).pipe(
      Effect.filterOrFail(
        (out) => out !== null && out.contents.includes("p07b-marker"),
        () => new MarkerPending(),
      ),
      Effect.retry(Schedule.spaced("100 millis")),
      Effect.timeoutOption("15 seconds"),
    );
    if (seen._tag === "Some" && seen.value !== null)
      expect(seen.value.contents).toContain("p07b-marker");
    else expect.unreachable("marker never appeared in terminal output");

    yield* call("resize", { terminalId: "term-1", cols: 100, rows: 40 });

    const restarted = yield* call("restart", {
      terminalId: "term-1",
      cwd: baseDir,
      cols: 100,
      rows: 40,
    });
    expect(restarted).toMatchObject({ terminalId: "term-1" });
    expect(["starting", "running"]).toContain((restarted as { status: string }).status);

    yield* call("close", { terminalId: "term-1", deleteHistory: true });
    const gone = yield* manager
      .inspect({ threadId: "thread", terminalId: "term-1" })
      .pipe(Effect.catch(() => Effect.succeed(null as TerminalSummary | null)));
    expect(gone).toBeNull();
  }).pipe(Effect.provide(realPtyLayer), Effect.scoped),
);

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId, ProjectId, RunId, ThreadId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import {
  readLatestMessages,
  resolveProject,
  threadCommand,
  type ThreadTools,
  titleFromMessage,
  waitForRun,
} from "./thread.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: () =>
        Effect.map(DateTime.now, (expiresAt) => ({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          expiresAt,
        })),
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");

it.effect(
  "start resolves home-relative project paths while preserving ids and relative paths",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs
        .makeTempDirectoryScoped({ prefix: "t3-thread-project-path-" })
        .pipe(Effect.flatMap((directory) => fs.realPath(directory)));
      const home = path.join(root, "home");
      const cwd = path.join(root, "current");
      const workspaceRoot = path.join(home, "My Project");
      const nestedRoot = path.join(workspaceRoot, "nested");
      const baseDir = path.join(root, "state");
      yield* fs.makeDirectory(nestedRoot, { recursive: true });
      yield* fs.makeDirectory(cwd);
      const projects = [
        { id: ProjectId.make("current-project"), title: "Current", workspaceRoot: cwd },
        { id: ProjectId.make("home-project"), title: "Home", workspaceRoot: home },
        { id: ProjectId.make("intended-project"), title: "Intended", workspaceRoot },
        { id: ProjectId.make("nested-project"), title: "Nested", workspaceRoot: nestedRoot },
        { id: ProjectId.make("~/literal-id"), title: "Exact id", workspaceRoot: cwd },
      ];
      yield* persistServerRuntimeState({
        path: path.join(baseDir, "userdata", "server-runtime.json"),
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 3_773,
        }),
      });
      using _session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
        Effect.succeed({
          call: (tool, args) => {
            switch (tool) {
              case "t3_project_list":
                return Effect.succeed({ structuredContent: { projects, nextCursor: null } });
              case "t3_thread_launch":
                return Effect.succeed({
                  structuredContent: { threadId, projectId: args.projectId, runId: null },
                });
              default:
                return Effect.die(`unexpected ${tool} call`);
            }
          },
        }),
      );

      for (const [identifier, expectedProjectId] of [
        ["intended-project", "intended-project"],
        ["~/literal-id", "~/literal-id"],
        [workspaceRoot, "intended-project"],
        [path.relative(cwd, workspaceRoot), "intended-project"],
        [".", "current-project"],
        ["~/My Project", "intended-project"],
        ["~", "home-project"],
        ["~/My Project/nested", "nested-project"],
        ["~/My Project/missing", "intended-project"],
      ] as const) {
        yield* Command.runWith(threadCommand, { version: "0.0.0" })([
          "start",
          identifier,
          "Inspect this project",
          "--json",
          "--base-dir",
          baseDir,
        ]).pipe(
          Effect.provideService(HostProcess.HomeDirectory, home),
          Effect.provideService(HostProcess.WorkingDirectory, cwd),
        );
        assert.strictEqual(
          (yield* TestConsole.logLines).at(-1),
          JSON.stringify({ threadId, projectId: expectedProjectId, runId: null }),
          identifier,
        );
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          NetService.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
        ),
      ),
    ),
);

it.effect("does not sign in to whatever took over a dead server's port", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-thread-dead-server-" });
    const state = yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3_773,
    });
    yield* persistServerRuntimeState({
      path: path.join(baseDir, "userdata", "server-runtime.json"),
      // Above Linux's PID ceiling, as in pair.test.ts: no process can hold it.
      state: { ...state, pid: 4_194_305 },
    });
    using session = vi
      .spyOn(McpBridge, "mcpToolSession")
      .mockReturnValue(Effect.die("no session should open"));

    const error = yield* Command.runWith(threadCommand, { version: "0.0.0" })([
      "list",
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);

    assert.strictEqual(error._tag, "ThreadServerNotRunningError");
    assert.strictEqual(session.mock.calls.length, 0);
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: { T3CODE_PORT: "3773" } })),
      ),
    ),
  ),
);

/** Answers each tool call with the next scripted response for that tool. */
const scriptedTools = (script: Record<string, Array<unknown>>) => {
  const calls: Array<{ readonly tool: string; readonly args: unknown }> = [];
  const call = ((tool: string, args: unknown) => {
    calls.push({ tool, args });
    const next = script[tool]?.shift();
    return next === undefined ? Effect.die(`unscripted ${tool} call`) : Effect.succeed(next);
  }) as ThreadTools["call"];
  return { tools: { call } satisfies ThreadTools, calls };
};

it.effect("--wait follows the sent run to its continuation's terminal status", () =>
  Effect.gen(function* () {
    const continuation = RunId.make("run-2");
    const { tools, calls } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId: continuation, status: "failed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 0 } }],
    });

    const outcome = yield* waitForRun(tools, threadId, runId);

    assert.deepStrictEqual(outcome, { type: "ended", runId: continuation, status: "failed" });
    assert.deepStrictEqual(
      calls.filter((entry) => entry.tool === "t3_thread_wait").map((entry) => entry.args),
      [
        { threadId, runId, timeoutMs: 15_000 },
        { threadId, runId, timeoutMs: 15_000 },
      ],
    );
  }),
);

it.effect("--wait stops when the thread waits for an answer instead of polling forever", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "queued", timedOut: true },
        { threadId, runId, status: "queued", timedOut: true },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), { type: "needs_input" });
  }),
);

it.effect("--wait reports its run's result when a later run is the one waiting", () =>
  Effect.gen(function* () {
    const { tools } = scriptedTools({
      t3_thread_wait: [
        { threadId, runId, status: "running", timedOut: true },
        { threadId, runId, status: "completed", timedOut: false },
      ],
      t3_thread_read: [{ thread: { pendingRequestCount: 1 } }],
    });

    assert.deepStrictEqual(yield* waitForRun(tools, threadId, runId), {
      type: "ended",
      runId,
      status: "completed",
    });
  }),
);

/** Serves t3_thread_read pages the way the server does: positions count every item. */
const timelineTools = (types: ReadonlyArray<string>) => {
  const items = types.map((type, position) => ({ position, itemId: `item-${position}`, type }));
  const served: Array<number> = [];
  const call = ((_tool: string, input: unknown) => {
    const args = input as { readonly afterPosition?: number; readonly limit: number };
    // Scanning one match past the page keeps reads of huge fixtures linear.
    const matching: typeof items = [];
    for (let position = (args.afterPosition ?? -1) + 1; position < items.length; position++) {
      const item = items[position]!;
      if (["user_message", "assistant_message", "proposed_plan"].includes(item.type)) {
        matching.push(item);
        if (matching.length > args.limit) break;
      }
    }
    const page = matching.slice(0, args.limit);
    served.push(page.length);
    return Effect.succeed({
      thread: { itemCount: items.length },
      items: page,
      nextPosition: page.at(-1)?.position ?? null,
      hasMore: matching.length > page.length,
    });
  }) as ThreadTools["call"];
  const latest = (count: number) =>
    items
      .filter((item) => item.type === "user_message" || item.type === "assistant_message")
      .slice(-count)
      .map((item) => item.itemId);
  return { tools: { call } satisfies ThreadTools, served, latest };
};

const tail = (tools: number) => [...Array<string>(tools).fill("tool_call"), "assistant_message"];

it.effect("show reads the end of a long thread, not its whole history", () =>
  Effect.gen(function* () {
    const { tools, served, latest } = timelineTools([
      ...Array.from({ length: 1000 }, (_, index) =>
        index % 2 === 0 ? "user_message" : "assistant_message",
      ),
      ...Array.from({ length: 10 }, () => tail(30)).flat(),
      "proposed_plan",
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.isBelow(
      served.reduce((sum, count) => sum + count, 0),
      100,
    );
  }),
);

it.effect("show widens back to the first item when the thread has fewer messages", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools([
      "user_message",
      ...Array.from({ length: 4 }, () => tail(150)).flat(),
    ]);

    const { messages } = yield* readLatestMessages(tools, threadId, 10);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(10),
    );
    assert.lengthOf(messages, 5);
  }),
);

it.effect("show returns a --messages count larger than one call can spread", () =>
  Effect.gen(function* () {
    const { tools, latest } = timelineTools(Array<string>(200_000).fill("assistant_message"));

    const { messages } = yield* readLatestMessages(tools, threadId, 200_000);

    assert.deepStrictEqual(
      messages.map((item) => item.itemId),
      latest(200_000),
    );
  }),
);

it("titles from a long first line without splitting an emoji", () => {
  const title = titleFromMessage(`${"a".repeat(78)}😀 and the rest of a long first line`);
  assert.strictEqual(title, `${"a".repeat(78)}…`);
});

const git = Effect.fn("test.git")(function* (cwd: string, args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const exitCode = yield* spawner.exitCode(ChildProcess.make("git", args, { cwd }));
  assert.strictEqual(Number(exitCode), 0, `git ${args.join(" ")}`);
});

const commitAll = (cwd: string) =>
  Effect.andThen(
    git(cwd, ["add", "."]),
    git(cwd, [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.test",
      "commit",
      "--quiet",
      "-m",
      "initial",
    ]),
  );

it.live("resolves a path inside a git worktree of the project's repository to that project", () =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const root = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-thread-worktree-" });
    const repo = path.join(root, "sample");
    const worktree = path.join(root, "worktrees", "sample", "t3-8ff64c24");
    const feature = path.join(root, "wt", "feature");
    const featureWorktree = path.join(root, "worktrees", "feature", "t3-1a2b3c4d");
    yield* fileSystem.makeDirectory(path.join(repo, "pkg"), { recursive: true });
    yield* fileSystem.writeFileString(path.join(repo, "pkg", "index.ts"), "export {};\n");
    yield* git(repo, ["init", "--quiet", "-b", "main"]);
    yield* commitAll(repo);
    yield* git(repo, ["worktree", "add", "--quiet", "-b", "t3/8ff64c24", worktree]);
    yield* git(repo, ["worktree", "add", "--quiet", "-b", "feature", feature]);
    yield* git(feature, ["worktree", "add", "--quiet", "-b", "t3/1a2b3c4d", featureWorktree]);

    const project = (id: string, workspaceRoot: string) => ({
      id: ProjectId.make(id),
      title: path.basename(workspaceRoot),
      workspaceRoot,
    });
    const sample = project("project-sample", repo);
    const featureProject = project("project-feature", feature);
    const resolveFrom = (
      projects: ReadonlyArray<ReturnType<typeof project>>,
      workingDirectory: string,
      identifier = ".",
    ) =>
      resolveProject(
        scriptedTools({ t3_project_list: [{ projects, nextCursor: null }] }).tools,
        identifier,
      ).pipe(Effect.provideService(HostProcess.WorkingDirectory, workingDirectory));

    assert.deepStrictEqual(yield* resolveFrom([sample], worktree), sample);
    assert.deepStrictEqual(yield* resolveFrom([sample], path.join(worktree, "pkg")), sample);
    assert.deepStrictEqual(yield* resolveFrom([sample], worktree, "pkg/index.ts"), sample);
    assert.deepStrictEqual(yield* resolveFrom([featureProject], featureWorktree), featureProject);
    const ambiguous = yield* Effect.flip(resolveFrom([sample, featureProject], featureWorktree));
    assert.strictEqual(ambiguous._tag, "ThreadUsageError");
    assert.include(ambiguous.message, "sample (project-sample)");
    assert.include(ambiguous.message, "feature (project-feature)");
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);

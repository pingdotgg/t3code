import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as Schema from "effect/Schema";
import * as Runtime from "effect/Runtime";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { listAllThreads, type ThreadTools, withThreadTools } from "./discovery.ts";
import * as Option from "effect/Option";
import { projectCommand } from "./project.ts";
import { threadCommand } from "./thread.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  return {
    ...actual,
    layerRuntime: Layer.mock(actual.EnvironmentAuth)({
      issueMcpClientSession: (input) => {
        assert.equal(input.access, "read-only");
        return Effect.map(DateTime.now, (expiresAt) => ({
          sessionId: AuthSessionId.make("test-session"),
          token: "synthetic-token",
          expiresAt,
        }));
      },
      revokeSession: () => Effect.succeed(true),
    }),
  };
});

const timestamp = "2026-11-01T12:00:00.000Z";
const project = (id: string) => ({
  id,
  title: id,
  workspaceRoot: `/work/${id}`,
  defaultModelSelection: id === "alpha" ? { instanceId: "codex", model: "gpt-test" } : null,
});
const thread = (threadId: string, projectId: string, status: string) => ({
  threadId,
  projectId,
  title: threadId,
  status,
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: "codex",
  model: "gpt-test",
  runtimeMode: "full-access",
  interactionMode: "default",
  latestRunId: null,
  linkedPullRequest: null,
  settled: false,
  settledAt: null,
  snoozed: false,
  snoozedUntil: null,
  parentThreadId: null,
  relationshipToParent: null,
  itemCount: 0,
  createdAt: timestamp,
  updatedAt: timestamp,
});

it.effect("discovery paginates existing MCP tools and preserves current-project defaults", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-" });
    yield* persistServerRuntimeState({
      path: `${baseDir}/userdata/server-runtime.json`,
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: 3773,
      }),
    });
    const projects = [project("alpha"), project("beta"), project("empty")];
    const threads = [
      thread("beta-running", "beta", "running"),
      thread("alpha-completed", "alpha", "completed"),
      {
        ...thread("child-running", "alpha", "running"),
        parentThreadId: "alpha-completed",
        relationshipToParent: "subagent",
      },
    ];
    const calls: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    using session = vi.spyOn(McpBridge, "mcpToolSession").mockReturnValue(
      Effect.succeed({
        call: (tool, args) => {
          calls.push({ tool, args });
          const cursor = Number(args.cursor);
          if (tool === "t3_project_list") {
            return Effect.succeed({
              structuredContent: {
                projects: projects.slice(cursor, cursor + 1),
                nextCursor: cursor + 1 < projects.length ? cursor + 1 : null,
              },
            });
          }
          assert.equal(tool, "t3_thread_list");

          assert.equal(args.includeSubagents, true);
          const statuses = args.statuses as ReadonlyArray<string> | undefined;
          const visible = threads.filter(
            (item) =>
              (args.includeSubagents === true || item.relationshipToParent !== "subagent") &&
              (args.allProjects === true || item.projectId === args.projectId) &&
              (statuses === undefined || statuses.includes(item.status)),
          );
          return Effect.succeed({
            structuredContent: {
              projectId: args.projectId ?? null,
              currentThreadId: null,
              threads: visible.slice(cursor, cursor + 1),
              nextCursor: cursor + 1 < visible.length ? cursor + 1 : null,
              total: visible.length,
            },
          });
        },
      }),
    );
    const logs: string[] = [];
    const logger = Logger.layer([Logger.make(({ message }) => logs.push(String(message)))], {
      mergeWithExisting: false,
    });
    const runProject = (args: string[]) =>
      Command.runWith(projectCommand, { version: "0.0.0" })(args).pipe(Effect.provide(logger));
    const runThread = (args: string[]) =>
      Command.runWith(threadCommand, { version: "0.0.0" })(args).pipe(Effect.provide(logger));
    const flags = ["--base-dir", baseDir, "--json"];
    yield* fs.makeDirectory(`${baseDir}/userdata/attachments`, { recursive: true });
    const expiredUpload = `${baseDir}/userdata/attachments/stale.part`;
    yield* fs.writeFileString(expiredUpload, "partial");
    yield* fs.utimes(
      expiredUpload,
      DateTime.toDateUtc(DateTime.makeUnsafe(-172800000)),
      DateTime.toDateUtc(DateTime.makeUnsafe(-172800000)),
    );
    const beforeJson = (yield* TestConsole.logLines).length;
    yield* runProject(["list", ...flags]);
    assert.isFalse(yield* fs.exists(expiredUpload));
    assert.deepStrictEqual(logs, []);
    const stdout = (yield* TestConsole.logLines).slice(beforeJson).join("\n");
    assert(Array.isArray(JSON.parse(stdout)));
    assert.deepStrictEqual(JSON.parse(String((yield* TestConsole.logLines).at(-1))), [
      { ...projects[0], threadCounts: { completed: 1 } },
      { ...projects[1], threadCounts: { running: 1 } },
      { ...projects[2], threadCounts: {} },
    ]);
    assert.deepStrictEqual(
      calls.map(({ tool, args }) => [tool, args.cursor]),
      [
        ["t3_project_list", 0],
        ["t3_project_list", 1],
        ["t3_project_list", 2],
        ["t3_thread_list", 0],
        ["t3_thread_list", 1],
        ["t3_thread_list", 2],
        ["t3_thread_list", 0],
        ["t3_thread_list", 1],
        ["t3_thread_list", 2],
      ],
    );
    for (const [extra, expected] of [
      [[], ["alpha-completed"]],
      [["--all-projects"], ["beta-running", "alpha-completed"]],
      [["--project", "beta"], ["beta-running"]],
      [["--project", "/work/alpha/nested"], ["alpha-completed"]],
      [["--status", "running"], []],
      [["--include-subagents"], ["alpha-completed", "child-running"]],
      [["--include-subagents", "--project", "alpha", "--status", "running"], ["child-running"]],
      [
        ["--include-subagents", "--all-projects", "--status", "running"],
        ["beta-running", "child-running"],
      ],
      [["--all-projects", "--status", "running"], ["beta-running"]],
    ] as const) {
      yield* fs.writeFileString(expiredUpload, "partial");
      yield* fs.utimes(
        expiredUpload,
        DateTime.toDateUtc(DateTime.makeUnsafe(-172800000)),
        DateTime.toDateUtc(DateTime.makeUnsafe(-172800000)),
      );
      const beforeJson = (yield* TestConsole.logLines).length;
      yield* runThread(["list", ...extra, ...flags]);
      assert.isFalse(yield* fs.exists(expiredUpload));
      assert.deepStrictEqual(logs, []);
      const rows = JSON.parse((yield* TestConsole.logLines).slice(beforeJson).join("\n")) as Array<{
        threadId: string;
        parentThreadId: string | null;
        relationshipToParent: string | null;
      }>;
      const child = rows.find((row) => row.threadId === "child-running");
      if (child) {
        assert.equal(child.parentThreadId, "alpha-completed");
        assert.equal(child.relationshipToParent, "subagent");
      }
      assert.deepStrictEqual(
        rows.map((row) => row.threadId),
        [...expected],
      );
    }
    const unknownId = yield* runThread(["list", "--project", "unknown-id", ...flags]).pipe(
      Effect.result,
    );
    assert(unknownId._tag === "Failure");
    const sessionsBefore = session.mock.calls.length;
    const conflicting = yield* runThread([
      "list",
      "--all-projects",
      "--project",
      "alpha",
      ...flags,
    ]).pipe(Effect.result);
    assert(conflicting._tag === "Failure");
    assert.equal(session.mock.calls.length, sessionsBefore);
    assert.equal(
      (yield* TestConsole.errorLines).at(-1),
      "--all-projects and --project cannot be used together.",
    );
    yield* fs.writeFileString(expiredUpload, "partial");
    yield* fs.utimes(
      expiredUpload,
      DateTime.toDateUtc(DateTime.makeUnsafe(-172800000)),
      DateTime.toDateUtc(DateTime.makeUnsafe(-172800000)),
    );
    yield* runThread(["list", "--base-dir", baseDir]);
    assert.include(logs.join("\n"), "Removed expired attachment uploads.");
    assert.equal(
      (yield* TestConsole.logLines).at(-1),
      "alpha-completed  completed    alpha-completed",
    );
    yield* runProject(["list", "--base-dir", baseDir]);
    assert.include((yield* TestConsole.logLines).join("\n"), "codex/gpt-test");
    const unknown = yield* runThread(["list", "--project", "/unknown-project", ...flags]).pipe(
      Effect.result,
    );
    assert(unknown._tag === "Failure");
    assert.isFalse(Runtime.getErrorReported(unknown.failure));
    assert.equal(
      (yield* TestConsole.errorLines).at(-1),
      "No T3 Code project matches '/unknown-project'. Pass an exact project id or an explicit path (such as ./name) inside a project.",
    );
    session.mockReturnValue(
      Effect.fail(new McpBridge.AcpMcpBridgeError({ message: "synthetic connection refused" })),
    );
    for (const run of [runProject, runThread]) {
      const failed = yield* run(["list", ...flags]).pipe(Effect.result);
      assert(failed._tag === "Failure");
      assert.isFalse(Runtime.getErrorReported(failed.failure));
      assert.include(
        String((yield* TestConsole.errorLines).at(-1)),
        "Could not reach the T3 Code server",
      );
    }
    for (const run of [runProject, runThread]) {
      const failed = yield* run(["list", "--base-dir", `${baseDir}/offline`]).pipe(Effect.result);
      assert(failed._tag === "Failure");
      assert.isFalse(Runtime.getErrorReported(failed.failure));
      assert.equal(
        (yield* TestConsole.errorLines).at(-1),
        `No running T3 Code server uses ${baseDir}/offline. Start T3 Code, then retry.`,
      );
    }
  }).pipe(
    Effect.scoped,
    Effect.provideService(HostProcess.WorkingDirectory, "/work/alpha"),
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
      ),
    ),
  ),
);

it.effect("thread pagination retries reordering without duplicate identities", () =>
  Effect.gen(function* () {
    let scan = 0;
    const a = thread("a", "alpha", "running");
    const b = thread("b", "alpha", "running");
    const c = thread("c", "alpha", "running");
    const call = ((tool: string, args: Readonly<Record<string, unknown>>) => {
      assert.equal(tool, "t3_thread_list");
      if (args.cursor === 0) scan++;
      const rows =
        scan === 1 ? (args.cursor === 0 ? [a, b] : [b]) : args.cursor === 0 ? [c, a] : [b];
      return Effect.succeed({ threads: rows, total: 3, nextCursor: args.cursor === 0 ? 2 : null });
    }) as ThreadTools["call"];
    const result = yield* listAllThreads({ call }, { allProjects: true });
    assert.deepStrictEqual(
      result.map((row) => row.threadId),
      ["c", "a", "b"],
    );
    assert.equal(scan, 3);
  }),
);

it.effect(
  "discovery deadlines cover initialization and listing without limiting the callback",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-timeout-" });
      yield* persistServerRuntimeState({
        path: `${baseDir}/userdata/server-runtime.json`,
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 3773,
        }),
      });
      for (const phase of ["initialize", "list", "callback"] as const) {
        const started = yield* Deferred.make<void>();
        const stalled = Deferred.succeed(started, undefined).pipe(Effect.andThen(Effect.never));
        using _session = vi
          .spyOn(McpBridge, "mcpToolSession")
          .mockReturnValue(
            phase === "initialize" ? stalled : Effect.succeed({ call: () => stalled }),
          );
        const program = withThreadTools(
          { baseDir: Option.some(baseDir) },
          (tools) =>
            phase === "callback" ? stalled : listAllThreads(tools, { allProjects: true }),
          { access: "read-only", quietLogs: true },
        );
        const fiber = yield* Command.runWith(
          Command.make("probe").pipe(Command.withHandler(() => program)),
          { version: "0.0.0" },
        )([]).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("10 seconds");
        if (phase === "callback") {
          assert.isUndefined(fiber.pollUnsafe());
          yield* Fiber.interrupt(fiber);
        } else {
          const result = yield* Fiber.join(fiber);
          assert(result._tag === "Failure");
          assert.include(String(result.failure), "Could not reach");
          assert.include(String(result.failure), "timed out");
        }
      }
    }).pipe(
      Effect.scoped,
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          NodeCrypto.layer,
          NetService.layer,
          ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
        ),
      ),
    ),
);

it.effect("discovery aborts stalled HTTP headers and bodies and closes MCP sessions", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-http-" });
    yield* persistServerRuntimeState({
      path: `${baseDir}/userdata/server-runtime.json`,
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: 3773,
      }),
    });
    for (const phase of ["initialize", "t3_project_list", "t3_thread_list", "DELETE"]) {
      for (const stall of phase === "DELETE" ? ["headers"] : ["headers", "body"]) {
        const started = yield* Deferred.make<void>();
        let deleted = false;
        let aborted = false;
        using _fetch = vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
          if (init?.method === "DELETE") {
            deleted = true;
            if (phase !== "DELETE") return new Response(null, { status: 204 });
          }
          const message = (
            init?.method === "DELETE"
              ? { id: "cleanup", method: "DELETE" }
              : JSON.parse(String(init?.body))
          ) as {
            id: string;
            method: string;
            params?: { name?: string };
          };
          const method = message.params?.name ?? message.method;
          if (method === phase) {
            if (stall === "headers") {
              return new Promise<Response>((_resolve, reject) => {
                init?.signal?.addEventListener("abort", () => {
                  aborted = true;
                  reject(new Error("aborted"));
                });
                Deferred.doneUnsafe(started, Effect.void);
              });
            }
            return new Response(
              new ReadableStream({
                start(controller) {
                  init?.signal?.addEventListener("abort", () => {
                    aborted = true;
                    controller.error(new Error("aborted"));
                  });
                  Deferred.doneUnsafe(started, Effect.void);
                },
                cancel() {
                  aborted = true;
                },
              }),
              {
                headers: {
                  "content-type": "text/event-stream",
                  "mcp-session-id": "timeout-session",
                },
              },
            );
          }
          if (method === "initialize")
            return Response.json(
              { id: message.id, result: { protocolVersion: "2025-06-18" } },
              { headers: { "mcp-session-id": "timeout-session" } },
            );
          if (message.method === "tools/call") return Response.json({ id: message.id, result: {} });
          return new Response(null, { status: 202 });
        });
        const program = withThreadTools(
          { baseDir: Option.some(baseDir) },
          (tools) => tools.call(phase === "DELETE" ? "t3_project_list" : phase, {}, Schema.Unknown),
          { access: "read-only", quietLogs: true },
        );
        const fiber = yield* Command.runWith(
          Command.make("probe").pipe(Command.withHandler(() => program)),
          { version: "0.0.0" },
        )([]).pipe(Effect.result, Effect.forkChild);
        yield* Deferred.await(started);
        yield* TestClock.adjust("10 seconds");
        const result = yield* Fiber.join(fiber);
        if (phase === "DELETE") assert(result._tag === "Success");
        else {
          assert(result._tag === "Failure");
          assert.include(String(result.failure), "Could not reach");
        }
        assert.isTrue(aborted, `${phase} ${stall}`);
        assert.equal(deleted, phase !== "initialize" || stall === "body");
      }
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
      ),
    ),
  ),
);

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
import * as Layer from "effect/Layer";
import * as Runtime from "effect/Runtime";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
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
          assert.equal(args.includeSubagents, false);
          const statuses = args.statuses as ReadonlyArray<string> | undefined;
          const visible = threads.filter(
            (item) =>
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
    const runProject = Command.runWith(projectCommand, { version: "0.0.0" });
    const runThread = Command.runWith(threadCommand, { version: "0.0.0" });
    const flags = ["--base-dir", baseDir, "--json"];
    yield* runProject(["list", ...flags]);
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
      ],
    );
    for (const [extra, expected] of [
      [[], ["alpha-completed"]],
      [["--all-projects"], ["beta-running", "alpha-completed"]],
      [["--project", "beta"], ["beta-running"]],
      [["--project", "/work/alpha/nested"], ["alpha-completed"]],
      [["--status", "running"], []],
      [["--all-projects", "--status", "running"], ["beta-running"]],
    ] as const) {
      yield* runThread(["list", ...extra, ...flags]);
      const rows = JSON.parse(String((yield* TestConsole.logLines).at(-1))) as Array<{
        threadId: string;
      }>;
      assert.deepStrictEqual(
        rows.map((row) => row.threadId),
        [...expected],
      );
    }
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
    yield* runThread(["list", "--base-dir", baseDir]);
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
      "No T3 Code project matches '/unknown-project'. Pass a project id or a path inside a project.",
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

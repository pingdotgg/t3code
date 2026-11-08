// @effect-diagnostics nodeBuiltinImport:off - CLI integration exercises the Node HTTP boundary.
import * as NodeHttp from "node:http";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { AuthOrchestrationReadScope, AuthSessionId, EnvironmentId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Runtime from "effect/Runtime";
import * as Layer from "effect/Layer";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { projectCommand } from "./project.ts";
import { threadCommand } from "./thread.ts";

vi.mock("../auth/EnvironmentAuth.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../auth/EnvironmentAuth.ts")>();
  const environment = await import("../environment/ServerEnvironment.ts");
  return {
    ...actual,
    layerRuntime: Layer.merge(
      Layer.succeed(environment.ServerEnvironmentIdentity, {
        getEnvironmentId: Effect.succeed(EnvironmentId.make("this-host")),
      }),
      Layer.mock(actual.EnvironmentAuth)({
        issueSession: (input) => {
          assert.deepStrictEqual(input?.scopes, [AuthOrchestrationReadScope]);
          return Effect.map(DateTime.now, (expiresAt) => ({
            sessionId: AuthSessionId.make("test-session"),
            token: "synthetic-token",
            method: "bearer-access-token" as const,
            scopes: [AuthOrchestrationReadScope],
            subject: "test",
            client: { deviceType: "bot" as const },
            expiresAt,
          }));
        },
        revokeSession: () => Effect.succeed(true),
      }),
    ),
  };
});

const timestamp = "2026-11-01T12:00:00.000Z";
const project = (id: string) => ({
  id,
  title: id,
  workspaceRoot: `/work/${id}`,
  defaultModelSelection: id === "alpha" ? { instanceId: "codex", model: "gpt-test" } : null,
  scripts: [],
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
});
const thread = (id: string, projectId: string, status: string, updatedAt = timestamp) => ({
  id,
  projectId,
  title: id,
  status,
  updatedAt,
  createdAt: timestamp,
  createdBy: "user",
  creationSource: "web",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-test" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: null,
  activeRunId: null,
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: null,
  hasActionableProposedPlan: false,
  itemCount: 0,
  visibleItemCount: 0,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
});

it.live("lists projects and all threads through HTTP, with project and status filters", () =>
  Effect.gen(function* () {
    const requests: Array<string> = [];
    const child = {
      ...thread("child", "alpha", "running"),
      lineage: {
        parentThreadId: "older",
        relationshipToParent: "subagent",
        rootThreadId: "older",
      },
    };
    const sideChat = {
      ...thread("side", "alpha", "running"),
      lineage: {
        parentThreadId: null,
        relationshipToParent: null,
        rootThreadId: "side",
        sideChat: true,
      },
    };
    const server = yield* Effect.acquireRelease(
      Effect.callback<NodeHttp.Server>((resume) => {
        const server = NodeHttp.createServer((request, response) => {
          requests.push(`${request.method} ${request.url}`);
          assert.equal(request.headers.authorization, "Bearer synthetic-token");
          response.setHeader("content-type", "application/json");
          if (request.url === "/api/projects") {
            response.end(
              JSON.stringify({
                projects: [
                  project("alpha"),
                  project("beta"),
                  project("empty"),
                  { ...project("deleted"), deletedAt: timestamp },
                ],
                updatedAt: timestamp,
              }),
            );
          } else if (request.url === "/api/orchestration/shell") {
            assert.equal(request.headers["x-t3-orchestration-protocol"], "2");
            response.end(
              JSON.stringify({
                schemaVersion: 1,
                snapshotSequence: 0,
                projects: [],
                threads: [
                  thread("older", "alpha", "completed"),
                  {
                    ...thread("newer", "beta", "completed", "2026-11-02T12:00:00.000Z"),
                    activityRunStatus: "running",
                  },
                  child,
                  sideChat,
                ],
                archivedThreads: [thread("archived", "alpha", "completed")],
              }),
            );
          } else {
            response.writeHead(404).end();
          }
        });
        server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
      }),
      (server) =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          server.closeAllConnections();
        }),
    );
    const address = server.address();
    assert(address !== null && typeof address !== "string");
    const fs = yield* FileSystem.FileSystem;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-discovery-" });
    yield* persistServerRuntimeState({
      path: `${baseDir}/userdata/server-runtime.json`,
      state: yield* makePersistedServerRuntimeState({
        config: { host: "127.0.0.1", devUrl: undefined },
        port: address.port,
      }),
    });
    const runProject = Command.runWith(projectCommand, { version: "0.0.0" });
    const runThread = Command.runWith(threadCommand, { version: "0.0.0" });
    const flags = ["--base-dir", baseDir, "--json"];
    yield* runProject(["list", ...flags]);
    assert.deepStrictEqual(JSON.parse(String((yield* TestConsole.logLines).at(-1) ?? "")), [
      {
        id: "alpha",
        title: "alpha",
        workspaceRoot: "/work/alpha",
        defaultModelSelection: { instanceId: "codex", model: "gpt-test" },
        threadCounts: { completed: 1 },
      },
      {
        id: "beta",
        title: "beta",
        workspaceRoot: "/work/beta",
        defaultModelSelection: null,
        threadCounts: { running: 1 },
      },
      {
        id: "empty",
        title: "empty",
        workspaceRoot: "/work/empty",
        defaultModelSelection: null,
        threadCounts: {},
      },
    ]);
    for (const [extra, expected] of [
      [[], ["newer", "older"]],
      [["--project", "alpha"], ["older"]],
      [["--project", "/work/alpha/subdir"], ["older"]],
      [["--status", "running"], ["newer"]],
      [["--project", "alpha", "--status", "running"], []],
    ] as const) {
      yield* runThread(["list", ...extra, ...flags]);
      const rows = JSON.parse(String((yield* TestConsole.logLines).at(-1) ?? "")) as Array<{
        threadId: string;
      }>;
      assert.deepStrictEqual(
        rows.map((row) => row.threadId),
        [...expected],
      );
    }
    yield* runProject(["list", "--base-dir", baseDir]);
    assert.include((yield* TestConsole.logLines).join("\n"), "codex/gpt-test");
    yield* runThread(["list", "--base-dir", baseDir]);
    assert.include(String((yield* TestConsole.logLines).at(-1) ?? ""), "older  alpha  completed");
    assert.equal(requests.length, 16);
    assert.isTrue(requests.every((request) => request.startsWith("GET /api/")));
    const unknownProject = yield* runThread([
      "list",
      "--project",
      "missing-project",
      ...flags,
    ]).pipe(Effect.result);
    assert(unknownProject._tag === "Failure");
    assert.isFalse(Runtime.getErrorReported(unknownProject.failure));
    assert.deepStrictEqual(yield* TestConsole.errorLines, [
      "No T3 Code project matches 'missing-project'. Pass a project id or a path inside a project.",
    ]);
    yield* Effect.callback<void>((resume) => {
      server.close(() => resume(Effect.void));
      server.closeAllConnections();
    });
    for (const run of [runProject, runThread]) {
      const errorsBefore = (yield* TestConsole.errorLines).length;
      const unreachable = yield* run(["list", ...flags]).pipe(Effect.result);
      assert(unreachable._tag === "Failure");
      assert.isFalse(Runtime.getErrorReported(unreachable.failure));
      assert.deepStrictEqual((yield* TestConsole.errorLines).slice(errorsBefore), [
        `Could not read projects and threads from the T3 Code server using ${baseDir}. Check that the server is running, then retry.`,
      ]);
    }
    const offlineBaseDir = `${baseDir}/offline`;
    for (const run of [runProject, runThread]) {
      const errorsBefore = (yield* TestConsole.errorLines).length;
      const stopped = yield* run(["list", "--base-dir", offlineBaseDir]).pipe(Effect.result);
      assert(stopped._tag === "Failure");
      assert.isFalse(Runtime.getErrorReported(stopped.failure));
      assert.deepStrictEqual((yield* TestConsole.errorLines).slice(errorsBefore), [
        `No running T3 Code server uses ${offlineBaseDir}. Start T3 Code, then retry.`,
      ]);
    }
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(
        NodeServices.layer,
        Layer.fresh(TestConsole.layer),
        NodeCrypto.layer,
        NetService.layer,
        ConfigProvider.layer(ConfigProvider.fromEnv({ env: {} })),
      ),
    ),
  ),
);

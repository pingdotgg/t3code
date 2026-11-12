// @effect-diagnostics nodeBuiltinImport:off - CLI integration uses temporary Node paths.
import * as NodePath from "node:path";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import { Command } from "effect/cli";
import { FetchHttpClient } from "effect/http";
import { vi } from "vite-plus/test";

import { cli } from "../binCli.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";

const hooks = vi.hoisted(() => ({
  importsAttempted: [] as string[],
  historyImportStarted: Promise.withResolvers<void>(),
  releaseHistoryImport: Promise.withResolvers<void>(),
  runClaudeHistoryWorker: vi.fn(async () => {}),
}));

vi.mock("../server.ts", () => {
  hooks.importsAttempted.push("server");
  throw new Error("server import failed");
});
vi.mock("../orchestration-v2/runtimeLayer.ts", () => {
  hooks.importsAttempted.push("runtimeLayer");
  throw new Error("runtime import failed");
});
vi.mock("../claudeHistoryWorker.ts", async () => {
  hooks.importsAttempted.push("claudeHistoryWorker");
  hooks.historyImportStarted.resolve();
  await hooks.releaseHistoryImport.promise;
  return { runClaudeHistoryWorker: hooks.runClaudeHistoryWorker };
});

const layerCliRuntime = Layer.mergeAll(NodeServices.layer, NetService.layer);
const runCli = (args: ReadonlyArray<string>) =>
  Command.runWith(cli, { version: "0.0.0" })(args).pipe(Effect.provide(layerCliRuntime));

it.layer(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer))("CLI deferred imports", (it) => {
  it.effect("runs commands that do not need them without loading them", () =>
    Effect.gen(function* () {
      hooks.importsAttempted.length = 0;
      for (const args of [["--version"], ["--help"], ["project", "--help"], ["thread", "--help"]]) {
        yield* runCli(args);
      }
      assert.deepEqual(hooks.importsAttempted, []);
    }),
  );

  it.effect("fails a server start on a broken import before resolving config", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-deferred-server-" });
      const baseDir = NodePath.join(root, "state");

      for (const command of ["serve", "start"]) {
        const exit = yield* runCli([command, "--base-dir", baseDir]).pipe(Effect.exit);
        assert.isTrue(Exit.hasDies(exit));
      }

      assert.isFalse(yield* fs.exists(baseDir));
    }),
  );

  it.effect("keeps server state when the offline project runtime fails to import", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-deferred-project-" });
      const baseDir = NodePath.join(root, "state");
      const runtimeStatePath = NodePath.join(baseDir, "userdata", "server-runtime.json");
      yield* persistServerRuntimeState({
        path: runtimeStatePath,
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 3_773,
        }),
      });
      const unreachable: typeof globalThis.fetch = () =>
        Promise.reject(new Error("connection refused"));

      const exit = yield* runCli(["project", "add", root, "--base-dir", baseDir]).pipe(
        Effect.provideService(FetchHttpClient.Fetch, unreachable),
        Effect.exit,
      );

      assert.isTrue(Exit.hasDies(exit));
      assert.isTrue(yield* fs.exists(runtimeStatePath));
    }),
  );

  it.effect("forwards live project mutations without importing the offline runtime", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "t3-deferred-live-project-" });
      const baseDir = NodePath.join(root, "state");
      const workspaceRoot = NodePath.join(root, "workspace");
      yield* fs.makeDirectory(workspaceRoot);
      yield* persistServerRuntimeState({
        path: NodePath.join(baseDir, "userdata", "server-runtime.json"),
        state: yield* makePersistedServerRuntimeState({
          config: { host: "127.0.0.1", devUrl: undefined },
          port: 3_773,
        }),
      });

      hooks.importsAttempted.length = 0;
      let mutations = 0;
      const fetch: typeof globalThis.fetch = async (_input, init) => {
        const isMutation = init?.method === "POST";
        if (isMutation) mutations++;
        return Response.json(
          isMutation
            ? {
                id: "live-project",
                title: NodePath.basename(workspaceRoot),
                workspaceRoot,
                defaultModelSelection: null,
                scripts: [],
                createdAt: "2026-01-01T00:00:00.000Z",
                updatedAt: "2026-01-01T00:00:00.000Z",
                deletedAt: null,
              }
            : { projects: [], updatedAt: "2026-01-01T00:00:00.000Z" },
        );
      };

      const exit = yield* runCli(["project", "add", workspaceRoot, "--base-dir", baseDir]).pipe(
        Effect.provideService(FetchHttpClient.Fetch, fetch),
        Effect.exit,
      );

      assert.isTrue(Exit.isSuccess(exit));
      assert.equal(mutations, 1);
      assert.deepEqual(hooks.importsAttempted, []);
    }),
  );

  it.effect("never starts the history worker after an interrupted import", () =>
    Effect.gen(function* () {
      const history = yield* runCli(["__claude-history", "getSessionMessages", "session"]).pipe(
        Effect.forkChild,
      );
      yield* Effect.promise(() => hooks.historyImportStarted.promise);
      yield* Fiber.interrupt(history);
      hooks.releaseHistoryImport.resolve();
      yield* Effect.promise(() => import("../claudeHistoryWorker.ts"));
      assert.equal(hooks.runClaudeHistoryWorker.mock.calls.length, 0);

      yield* runCli(["__claude-history", "getSessionMessages", "session"]);
      yield* runCli(["__claude-history", "forkSession", "session", '{"dir":"/repo"}']);
      assert.deepEqual(hooks.runClaudeHistoryWorker.mock.calls, [
        ["getSessionMessages", "session", undefined],
        ["forkSession", "session", '{"dir":"/repo"}'],
      ]);
    }),
  );
});

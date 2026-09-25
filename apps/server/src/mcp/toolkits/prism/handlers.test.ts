import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

import { findRouterBin, parseRouterOutput, routerStateDir, submitArgs } from "./handlers.ts";

it("submits with the calling thread as the T3 planner and starts the job", () => {
  const args = submitArgs({
    requestId: "prism-1",
    task: "Fix #80",
    workspace: "/repo",
    plannerThreadId: "thread-1",
    serverUrl: "http://127.0.0.1:3999",
    lane: "easy",
  });
  assert.deepStrictEqual(args, [
    "submit",
    "--request-id",
    "prism-1",
    "--task",
    "Fix #80",
    "--workspace",
    "/repo",
    "--planner-session",
    "thread-1",
    "--planner-harness",
    "t3",
    "--planner-t3-thread",
    "thread-1",
    "--t3-server-url",
    "http://127.0.0.1:3999",
    "--lane",
    "small",
    "--start",
  ]);
});

it("passes router JSON through and turns its errors into refusals", () => {
  assert.deepStrictEqual(parseRouterOutput('{"status":"running"}', "", 0), {
    ok: { status: "running" },
  });
  assert.deepStrictEqual(parseRouterOutput('{"error":"not found: x"}', "", 1), {
    error: "Prism router refused: not found: x",
  });
  assert.deepStrictEqual(parseRouterOutput("", "Traceback", 1), {
    error: "Prism router exited 1: Traceback",
  });
});

it("defaults the router state directory like the router does", () => {
  assert.strictEqual(routerStateDir({}, "/home/u"), "/home/u/.local/share/durable-runner");
  assert.strictEqual(routerStateDir({ DURABLE_RUNNER_STATE_DIR: "/tmp/s" }, "/home/u"), "/tmp/s");
});

it.layer(NodeServices.layer)("router discovery", (it) => {
  it.effect("picks the newest installed version that ships the CLI", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const root = `${home}/.codex/plugins/cache/toolboxmd/model-router`;
      for (const version of ["0.9.0", "0.34.0", "0.35.0"]) {
        yield* fs.makeDirectory(`${root}/${version}/bin`, { recursive: true });
      }
      yield* fs.writeFileString(`${root}/0.9.0/bin/model-router`, "");
      yield* fs.writeFileString(`${root}/0.34.0/bin/model-router`, "");
      // 0.35.0 is a partial install without the CLI.
      assert.strictEqual(yield* findRouterBin({}, home), `${root}/0.34.0/bin/model-router`);
      assert.strictEqual(
        yield* findRouterBin({ PRISM_ROUTER_BIN: "/x/router" }, home),
        "/x/router",
      );
      assert.strictEqual(yield* findRouterBin({}, `${home}/nobody`), null);
    }).pipe(Effect.scoped),
  );
});

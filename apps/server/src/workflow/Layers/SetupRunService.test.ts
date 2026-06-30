import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { TerminalManager } from "../../terminal/Manager.ts";
import { SetupRunService, SetupTerminalPort } from "../Services/SetupRunService.ts";
import { SetupRunServiceLive, SetupTerminalPortLive } from "./SetupRunService.ts";
import { ProjectSetupScriptRunner } from "../../project/ProjectSetupScriptRunner.ts";

const stubTerminal = (exitCode: number) =>
  Layer.succeed(SetupTerminalPort, {
    launch: () => Effect.succeed({ threadId: "workflow-setup:/tmp/wt-1", terminalId: "term-1" }),
    awaitExit: () => Effect.succeed({ exitCode }),
  });

const layerForExit = (exitCode: number) =>
  it.layer(
    SetupRunServiceLive.pipe(
      Layer.provideMerge(stubTerminal(exitCode)),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    ),
  );

layerForExit(0)("SetupRunService success", (it) => {
  it.effect("completes on exit 0", () =>
    Effect.gen(function* () {
      const setup = yield* SetupRunService;
      const sql = yield* SqlClient.SqlClient;
      const result = yield* setup.runSetup("t-1" as never, "wt-1", "/tmp/wt-1", "setup-1" as never);

      assert.equal(result.status, "completed");
      const rows = yield* sql<{ readonly status: string }>`
        SELECT status FROM workflow_setup_run WHERE ticket_id = 't-1'
      `;
      assert.equal(rows[0]?.status, "completed");
    }),
  );
});

layerForExit(1)("SetupRunService failure", (it) => {
  it.effect("fails on non-zero exit", () =>
    Effect.gen(function* () {
      const setup = yield* SetupRunService;
      const result = yield* setup.runSetup("t-2" as never, "wt-2", "/tmp/wt-2", "setup-2" as never);

      assert.equal(result.status, "failed");
      assert.equal(result.exitCode, 1);
    }),
  );
});

// ---------------------------------------------------------------------------
// SetupTerminalPortLive — subscribe-then-check race (Fix 2)
// ---------------------------------------------------------------------------

// Test that awaitExit resolves immediately when the terminal is already exited
// at the time the listener is installed (no live event required).
const preExitedTerminalLayer = (exitCode: number) =>
  Layer.succeed(TerminalManager, {
    open: () => Effect.die("unused"),
    attachStream: () => Effect.die("unused"),
    attachHistoryStream: () => Effect.die("unused"),
    write: () => Effect.die("unused"),
    resize: () => Effect.die("unused"),
    clear: () => Effect.die("unused"),
    restart: () => Effect.die("unused"),
    close: () => Effect.void,
    getSnapshot: () =>
      Effect.succeed({
        threadId: "workflow-setup:/tmp/pre-exited",
        terminalId: "term-pre-exited",
        cwd: "/tmp/pre-exited",
        worktreePath: null,
        status: "exited" as const,
        pid: null,
        history: "",
        exitCode,
        exitSignal: null,
        label: "pre-exited",
        updatedAt: "2026-01-01T00:00:00.000Z",
        sequence: 0,
      }),
    subscribe: () => Effect.succeed(() => undefined),
    subscribeMetadata: () => Effect.succeed(() => undefined),
  });

const stubSetupRunner = Layer.succeed(ProjectSetupScriptRunner, {
  runForThread: () =>
    Effect.succeed({
      status: "started",
      scriptId: "script-1",
      scriptName: "setup",
      terminalId: "term-pre-exited",
      cwd: "/tmp/pre-exited",
    }),
});

it.layer(
  SetupTerminalPortLive.pipe(
    Layer.provideMerge(preExitedTerminalLayer(0)),
    Layer.provideMerge(stubSetupRunner),
  ),
)("SetupTerminalPortLive pre-exited terminal", (it) => {
  it.effect("resolves immediately when terminal already exited before listener installed", () =>
    Effect.gen(function* () {
      const port = yield* SetupTerminalPort;
      // The terminal manager stub never fires any events — if the subscribe-
      // then-check race fix is working, awaitExit must resolve via the
      // getSnapshot check rather than waiting for a live event.
      // We use a short timeout: without the fix this would time out (returning
      // exitCode -1 via orElseSucceed), with the fix it resolves immediately.
      const result = yield* port.awaitExit({
        threadId: "workflow-setup:/tmp/pre-exited",
        terminalId: "term-pre-exited",
        timeoutMs: 50,
      });
      assert.equal(
        result.exitCode,
        0,
        "awaitExit should return the recorded exitCode for a pre-exited terminal",
      );
    }),
  );
});

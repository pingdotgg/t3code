import * as NodeSqlite from "node:sqlite";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { AuthSessionId } from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Runtime from "effect/Runtime";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/cli";
import { vi } from "vite-plus/test";

import { makeCli } from "../binCli.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { FEEDBACK_OFF_MESSAGE, T3_CLI_COMMANDS } from "../feedback/FeedbackReport.ts";
import * as McpBridge from "../mcp/AcpMcpStdioBridge.ts";
import {
  makePersistedServerRuntimeState,
  persistServerRuntimeState,
} from "../serverRuntimeState.ts";
import { feedbackCommand } from "./feedback.ts";

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

const listedPaths = (command: Command.Command.Any, path: string): ReadonlyArray<string> => [
  path,
  ...command.subcommands.flatMap((group) =>
    group.commands
      .filter((child) => !child.unlisted)
      .flatMap((child) => listedPaths(child, `${path} ${child.name}`)),
  ),
];

it("feedback subjects name every listed t3 command", () => {
  expect([...T3_CLI_COMMANDS].sort()).toEqual(
    [...listedPaths(makeCli({ cloudEnabled: true }), "t3")].sort(),
  );
});

const hidden = (tool: string) =>
  new McpBridge.AcpMcpBridgeError({
    message: "T3 Code MCP tools/call failed.",
    rpcError: { code: -32602, message: `Tool '${tool}' not found` },
  });

/** Runs a failing command: stderr gets exactly one line, and the runtime logs nothing more. */
const expectOneLine = (args: ReadonlyArray<string>, baseDir: string, stderr: string) =>
  Effect.gen(function* () {
    const before = (yield* TestConsole.errorLines).length;
    const error = yield* Command.runWith(feedbackCommand, { version: "0.0.0" })([
      ...args,
      "--base-dir",
      baseDir,
    ]).pipe(Effect.flip);
    const lines = (yield* TestConsole.errorLines).slice(before);
    expect(lines, args.join(" ")).toHaveLength(1);
    expect(String(lines[0]), args.join(" ")).toContain(stderr);
    if (stderr === FEEDBACK_OFF_MESSAGE) expect(lines).toEqual([FEEDBACK_OFF_MESSAGE]);
    expect((error as { readonly [Runtime.errorReported]?: boolean })[Runtime.errorReported]).toBe(
      false,
    );
  });

it.effect("points to Labs only when the server hides the feedback tool", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const baseDir = yield* fs.makeTempDirectoryScoped({ prefix: "t3-feedback-cli-" });
    const runtimeStatePath = path.join(baseDir, "userdata", "server-runtime.json");
    const runtimeState = yield* makePersistedServerRuntimeState({
      config: { host: "127.0.0.1", devUrl: undefined },
      port: 3_773,
    });
    const submit = ["--kind", "bug", "--subject", "general", "--expected", "a", "--actual", "b"];
    const cases: ReadonlyArray<{
      readonly args: ReadonlyArray<string>;
      readonly running?: false;
      readonly call?: McpBridge.McpToolSession["call"];
      readonly stderr: string;
    }> = [
      { args: submit, call: (tool) => Effect.fail(hidden(tool)), stderr: FEEDBACK_OFF_MESSAGE },
      // The list reads this machine's database, never the agent tools.
      { args: ["list"], stderr: FEEDBACK_OFF_MESSAGE },
      {
        args: submit,
        call: () =>
          Effect.succeed({ isError: true, content: [{ type: "text", text: "Rate limited." }] }),
        stderr: "Rate limited.",
      },
      {
        args: submit,
        call: () =>
          Effect.fail(
            new McpBridge.AcpMcpBridgeError({ message: "fetch failed: connection refused" }),
          ),
        stderr: `Could not reach the T3 Code server at ${runtimeState.origin}.`,
      },
      { args: submit, running: false, stderr: "No running T3 Code server uses" },
    ];
    for (const { args, running, call, stderr } of cases) {
      yield* running === false
        ? fs.remove(runtimeStatePath, { force: true })
        : persistServerRuntimeState({ path: runtimeStatePath, state: runtimeState });
      using _session = vi
        .spyOn(McpBridge, "mcpToolSession")
        .mockReturnValue(Effect.succeed({ call: call ?? (() => Effect.die("no call expected")) }));

      yield* expectOneLine(args, baseDir, stderr);
    }
    // Off is read from the settings file alone: listing opened no database, so none exists.
    const dbPath = path.join(baseDir, "userdata", "statev2.sqlite");
    expect(yield* fs.exists(dbPath)).toBe(false);
    const turnOn = (dir: string) =>
      fs.writeFileString(
        path.join(dir, "userdata", "settings.json"),
        JSON.stringify({ agentFeedback: { mode: "auto" } }),
      );
    const listJson = (dir: string) =>
      Command.runWith(feedbackCommand, { version: "0.0.0" })([
        "list",
        "--json",
        "--base-dir",
        dir,
      ]).pipe(
        Effect.andThen(TestConsole.logLines),
        Effect.map((lines) => JSON.parse(String(lines.at(-1)))),
      );

    // A file the server rejects reads as the defaults, so Off, as the server would read it.
    const rejected = yield* fs.makeTempDirectoryScoped({ prefix: "t3-feedback-cli-" });
    yield* fs.makeDirectory(path.join(rejected, "userdata"), { recursive: true });
    yield* fs.writeFileString(
      path.join(rejected, "userdata", "settings.json"),
      '{"agentFeedback":{"mode":"auto"},"providers":1}',
    );
    yield* expectOneLine(["list"], rejected, FEEDBACK_OFF_MESSAGE);

    // On, a damaged database is one line too.
    const damaged = yield* fs.makeTempDirectoryScoped({ prefix: "t3-feedback-cli-" });
    yield* fs.makeDirectory(path.join(damaged, "userdata"), { recursive: true });
    yield* turnOn(damaged);
    yield* fs.writeFileString(path.join(damaged, "userdata", "statev2.sqlite"), "not a database");
    yield* expectOneLine(["list"], damaged, "Could not read this machine's feedback reports: ");

    // A database from before agent feedback, with no table for it, lists nothing.
    const older = yield* fs.makeTempDirectoryScoped({ prefix: "t3-feedback-cli-" });
    yield* fs.makeDirectory(path.join(older, "userdata"), { recursive: true });
    yield* turnOn(older);
    const olderDatabase = new NodeSqlite.DatabaseSync(
      path.join(older, "userdata", "statev2.sqlite"),
    );
    olderDatabase.exec("CREATE TABLE projection_projects (project_id TEXT)");
    olderDatabase.close();
    expect(yield* listJson(older)).toEqual([]);

    // On, the list prints each stored report whole, trace included, with no server running.
    yield* turnOn(baseDir);
    yield* Effect.scoped(Layer.build(SqlitePersistence.layerFromPath(dbPath)));
    const trace = {
      turns: 1,
      textTurns: 0,
      truncated: false,
      entries: [{ turn: 1, type: "user", length: 4 }],
    };
    const database = new NodeSqlite.DatabaseSync(dbPath);
    database
      .prepare(
        `INSERT INTO agent_feedback (id, thread_id, run_id, created_at, kind, subject, expected,
          actual, workaround, user_requested, trace, source, sent)
        VALUES ('r1', 't1', 'run1', '2026-11-17T00:00:00.000Z', 'bug', 't3_thread_read', 'a', 'b',
          '', 1, ?, 'mcp', 1)`,
      )
      .run(JSON.stringify(trace));
    database.close();
    expect(yield* listJson(baseDir)).toEqual([
      {
        id: "r1",
        threadId: "t1",
        createdAt: "2026-11-17T00:00:00.000Z",
        kind: "bug",
        subject: "t3_thread_read",
        expected: "a",
        actual: "b",
        workaround: "",
        userRequested: true,
        trace,
        source: "mcp",
        sent: true,
      },
    ]);
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

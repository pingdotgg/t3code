// @effect-diagnostics nodeBuiltinImport:off -- fixtures write a native session database.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import type { AcpToolCallState } from "@t3tools/provider-acp/server/runtimeModel";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import { readAntigravityRunningCommands } from "./AntigravityBackgroundCommands.ts";
import { normalizeAntigravityToolCall } from "./AntigravityProtocol.ts";

const SESSION_ID = "bd48a7d6-ee8d-4386-91ae-4c4b53248b72";
const RUN_COMMAND_STEP_TYPE = 21;
const STATUS_RUNNING = 2;
const STATUS_DONE = 3;
const STATUS_CANCELED = 6;

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 0x80);
  }
  return [...bytes, value];
};
const field = (number: number, value: string | Uint8Array) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
};
const proto = (...parts: number[][]) => Uint8Array.from(parts.flat());

const commandStepMetadata = (input: {
  readonly callId: string;
  readonly args: Record<string, unknown>;
}) =>
  proto(
    field(
      4,
      proto(field(1, input.callId), field(2, "run_command"), field(3, JSON.stringify(input.args))),
    ),
  );

const commandStepPayload = (input: {
  readonly metadata: Uint8Array;
  readonly commandLine: string;
  readonly cwd?: string;
}) =>
  proto(
    field(5, input.metadata),
    field(
      28,
      proto(
        ...(input.cwd === undefined ? [] : [field(2, input.cwd)]),
        field(23, input.commandLine),
      ),
    ),
  );

const makeToolCall = (input: {
  readonly toolCallId: string;
  readonly commandLine: string;
  readonly cwd?: string;
}): AcpToolCallState =>
  normalizeAntigravityToolCall({
    toolCallId: input.toolCallId,
    kind: "execute",
    title: "Ran command",
    status: "inProgress",
    data: {
      rawInput: {
        CommandLine: input.commandLine,
        ...(input.cwd === undefined ? {} : { Cwd: input.cwd }),
        WaitMsBeforeAsync: 10000,
      },
    },
  });

const writeSessionDb = Effect.fn("writeSessionDb")(function* (input: {
  readonly profileDirectory: string;
  readonly sessionId?: string;
  readonly rows: ReadonlyArray<{
    readonly idx: number;
    readonly stepType: number;
    readonly status: number;
    readonly metadata: Uint8Array | null;
    readonly payload: Uint8Array | null;
  }>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const conversations = path.join(input.profileDirectory, "antigravity-acp", "conversations");
  yield* fs.makeDirectory(conversations, { recursive: true });
  const dbPath = path.join(conversations, `${input.sessionId ?? SESSION_ID}.db`);
  const database = new NodeSqlite.DatabaseSync(dbPath);
  try {
    database.exec(
      "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB, step_payload BLOB)",
    );
    const insert = database.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?)");
    for (const row of input.rows) {
      insert.run(row.idx, row.stepType, row.status, row.metadata, row.payload);
    }
  } finally {
    database.close();
  }
  return dbPath;
});

describe("readAntigravityRunningCommands", () => {
  it.effect("returns empty when all RUN_COMMAND steps were canceled or finished", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const meta = commandStepMetadata({
        callId: "call_4689361663381181880",
        args: { CommandLine: "pytest -q tests/", Cwd: "/repo" },
      });
      yield* writeSessionDb({
        profileDirectory,
        rows: [
          {
            idx: 14,
            stepType: RUN_COMMAND_STEP_TYPE,
            status: STATUS_CANCELED,
            metadata: meta,
            payload: commandStepPayload({
              metadata: meta,
              commandLine: "pytest -q tests/",
              cwd: "/repo",
            }),
          },
          {
            idx: 18,
            stepType: RUN_COMMAND_STEP_TYPE,
            status: STATUS_DONE,
            metadata: meta,
            payload: commandStepPayload({
              metadata: meta,
              commandLine: "echo done",
              cwd: "/repo",
            }),
          },
        ],
      });
      const result = yield* readAntigravityRunningCommands({
        profileDirectory,
        sessionId: SESSION_ID,
        tools: [
          makeToolCall({
            toolCallId: `${SESSION_ID}:13`,
            commandLine: "pytest -q tests/",
            cwd: "/repo",
          }),
        ],
      });
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("keeps only tools that still have an active RUN_COMMAND step in the database", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const canceledMeta = commandStepMetadata({
        callId: "call_canceled",
        args: { CommandLine: "pytest -q tests/", Cwd: "/repo" },
      });
      const runningMeta = commandStepMetadata({
        callId: "call_running",
        args: { CommandLine: "node fetch_throughput.mjs", Cwd: "/repo" },
      });
      yield* writeSessionDb({
        profileDirectory,
        rows: [
          {
            idx: 14,
            stepType: RUN_COMMAND_STEP_TYPE,
            status: STATUS_CANCELED,
            metadata: canceledMeta,
            payload: commandStepPayload({
              metadata: canceledMeta,
              commandLine: "pytest -q tests/",
              cwd: "/repo",
            }),
          },
          {
            idx: 22,
            stepType: RUN_COMMAND_STEP_TYPE,
            status: STATUS_RUNNING,
            metadata: runningMeta,
            payload: commandStepPayload({
              metadata: runningMeta,
              commandLine: "node fetch_throughput.mjs",
              cwd: "/repo",
            }),
          },
        ],
      });
      const result = yield* readAntigravityRunningCommands({
        profileDirectory,
        sessionId: SESSION_ID,
        tools: [
          makeToolCall({
            toolCallId: `${SESSION_ID}:13`,
            commandLine: "pytest -q tests/",
            cwd: "/repo",
          }),
          makeToolCall({
            toolCallId: `${SESSION_ID}:19`,
            commandLine: "node fetch_throughput.mjs",
            cwd: "/repo",
          }),
        ],
      });
      assert.deepEqual(result, [`${SESSION_ID}:19`]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "preserves long truncated commands and distinguishes duplicates by cwd or exact callId",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();
        const longCommand = `python3 -c "${"x".repeat(9_000)}"`;
        const meta = commandStepMetadata({
          callId: "call_native_20",
          args: { CommandLine: longCommand, Cwd: "/repo-b" },
        });
        yield* writeSessionDb({
          profileDirectory,
          rows: [
            {
              idx: 10,
              stepType: RUN_COMMAND_STEP_TYPE,
              status: STATUS_CANCELED,
              metadata: commandStepMetadata({
                callId: "call_native_10",
                args: { CommandLine: longCommand, Cwd: "/repo-a" },
              }),
              payload: null,
            },
            {
              idx: 20,
              stepType: RUN_COMMAND_STEP_TYPE,
              status: STATUS_RUNNING,
              metadata: meta,
              payload: commandStepPayload({
                metadata: meta,
                commandLine: longCommand,
                cwd: "/repo-b",
              }),
            },
          ],
        });
        const result = yield* readAntigravityRunningCommands({
          profileDirectory,
          sessionId: SESSION_ID,
          tools: [
            makeToolCall({
              toolCallId: `${SESSION_ID}:10`,
              commandLine: longCommand,
              cwd: "/repo-a",
            }),
            makeToolCall({
              toolCallId: `${SESSION_ID}:20`,
              commandLine: longCommand,
              cwd: "/repo-b",
            }),
          ],
        });
        assert.deepEqual(result, [`${SESSION_ID}:20`]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "returns undefined instead of guessing when identical commands cannot be distinguished",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();
        const runningMeta = commandStepMetadata({
          callId: "call_native_older",
          args: { CommandLine: "pytest -q tests/", Cwd: "/repo" },
        });
        yield* writeSessionDb({
          profileDirectory,
          rows: [
            {
              idx: 10,
              stepType: RUN_COMMAND_STEP_TYPE,
              status: STATUS_RUNNING,
              metadata: runningMeta,
              payload: commandStepPayload({
                metadata: runningMeta,
                commandLine: "pytest -q tests/",
                cwd: "/repo",
              }),
            },
            {
              idx: 20,
              stepType: RUN_COMMAND_STEP_TYPE,
              status: STATUS_CANCELED,
              metadata: commandStepMetadata({
                callId: "call_native_newer",
                args: { CommandLine: "pytest -q tests/", Cwd: "/repo" },
              }),
              payload: null,
            },
          ],
        });
        const result = yield* readAntigravityRunningCommands({
          profileDirectory,
          sessionId: SESSION_ID,
          tools: [
            makeToolCall({
              toolCallId: `${SESSION_ID}:10`,
              commandLine: "pytest -q tests/",
              cwd: "/repo",
            }),
            makeToolCall({
              toolCallId: `${SESSION_ID}:20`,
              commandLine: "pytest -q tests/",
              cwd: "/repo",
            }),
          ],
        });
        assert.isUndefined(result);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "returns undefined for an active row lacking command text unless callId matches exactly",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();
        const idOnlyMeta = proto(
          field(4, proto(field(1, "call_native_only"), field(2, "run_command"))),
        );
        yield* writeSessionDb({
          profileDirectory,
          rows: [
            {
              idx: 10,
              stepType: RUN_COMMAND_STEP_TYPE,
              status: STATUS_RUNNING,
              metadata: idOnlyMeta,
              payload: null,
            },
          ],
        });
        // Different ACP id + active row without command text -> inconclusive (do not kill live tool).
        assert.isUndefined(
          yield* readAntigravityRunningCommands({
            profileDirectory,
            sessionId: SESSION_ID,
            tools: [
              makeToolCall({
                toolCallId: `${SESSION_ID}:10`,
                commandLine: "node fetch_throughput.mjs",
                cwd: "/repo",
              }),
            ],
          }),
        );
        // Exact callId match still succeeds even without command text on the DB row.
        assert.deepEqual(
          yield* readAntigravityRunningCommands({
            profileDirectory,
            sessionId: SESSION_ID,
            tools: [
              makeToolCall({
                toolCallId: "call_native_only",
                commandLine: "node fetch_throughput.mjs",
                cwd: "/repo",
              }),
            ],
          }),
          ["call_native_only"],
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("ignores active daemon commands when reconciling non-daemon commands", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const daemonMeta = commandStepMetadata({
        callId: "call_daemon",
        args: { CommandLine: "vite dev", Cwd: "/repo", IsDaemon: true },
      });
      yield* writeSessionDb({
        profileDirectory,
        rows: [
          {
            idx: 10,
            stepType: RUN_COMMAND_STEP_TYPE,
            status: STATUS_CANCELED,
            metadata: commandStepMetadata({
              callId: "call_short",
              args: { CommandLine: "vite dev", Cwd: "/repo" },
            }),
            payload: null,
          },
          {
            idx: 12,
            stepType: RUN_COMMAND_STEP_TYPE,
            status: STATUS_RUNNING,
            metadata: daemonMeta,
            payload: commandStepPayload({
              metadata: daemonMeta,
              commandLine: "vite dev",
              cwd: "/repo",
            }),
          },
        ],
      });
      const result = yield* readAntigravityRunningCommands({
        profileDirectory,
        sessionId: SESSION_ID,
        tools: [
          makeToolCall({ toolCallId: `${SESSION_ID}:9`, commandLine: "vite dev", cwd: "/repo" }),
        ],
      });
      assert.deepEqual(result, []);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns undefined when the session database is missing, empty, or symlinked", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      const tool = makeToolCall({
        toolCallId: `${SESSION_ID}:1`,
        commandLine: "node fetch_throughput.mjs",
      });

      // Missing database
      assert.isUndefined(
        yield* readAntigravityRunningCommands({
          profileDirectory,
          sessionId: SESSION_ID,
          tools: [tool],
        }),
      );

      // Database with no RUN_COMMAND rows yet
      const emptySessionId = "11111111-1111-1111-1111-111111111111";
      const realDb = yield* writeSessionDb({
        profileDirectory,
        sessionId: emptySessionId,
        rows: [],
      });
      assert.isUndefined(
        yield* readAntigravityRunningCommands({
          profileDirectory,
          sessionId: emptySessionId,
          tools: [tool],
        }),
      );

      // Symlinked database must be refused by antigravityManagedPath
      const linkSessionId = "22222222-2222-2222-2222-222222222222";
      const linkPath = path.join(
        profileDirectory,
        "antigravity-acp",
        "conversations",
        `${linkSessionId}.db`,
      );
      yield* fs.symlink(realDb, linkPath);
      assert.isUndefined(
        yield* readAntigravityRunningCommands({
          profileDirectory,
          sessionId: linkSessionId,
          tools: [tool],
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "preserves non-execute outliving tools such as schedule alongside canceled commands",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();
        yield* writeSessionDb({
          profileDirectory,
          rows: [
            {
              idx: 14,
              stepType: RUN_COMMAND_STEP_TYPE,
              status: STATUS_CANCELED,
              metadata: commandStepMetadata({
                callId: "call_canceled",
                args: { CommandLine: "pytest -q tests/", Cwd: "/repo" },
              }),
              payload: null,
            },
          ],
        });
        const scheduleTool: AcpToolCallState = {
          toolCallId: `${SESSION_ID}:20`,
          kind: "other",
          title: "Running schedule",
          status: "inProgress",
          data: { rawInput: { DurationSeconds: 300, Prompt: "Check status" } },
        };
        const result = yield* readAntigravityRunningCommands({
          profileDirectory,
          sessionId: SESSION_ID,
          tools: [
            makeToolCall({
              toolCallId: `${SESSION_ID}:13`,
              commandLine: "pytest -q tests/",
              cwd: "/repo",
            }),
            scheduleTool,
          ],
        });
        assert.deepEqual(result, [scheduleTool.toolCallId]);
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns undefined when an active row has oversized metadata", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      // Valid, matching metadata padded past MAX_METADATA_BYTES so removing the size guard would match.
      const validMatchingMeta = commandStepMetadata({
        callId: `${SESSION_ID}:13`,
        args: { CommandLine: "pytest -q tests/", Cwd: "/repo" },
      });
      const oversizedValidMeta = Uint8Array.from([
        ...validMatchingMeta,
        ...field(30, "x".repeat(256 * 1024)),
      ]);
      yield* writeSessionDb({
        profileDirectory,
        rows: [
          {
            idx: 14,
            stepType: RUN_COMMAND_STEP_TYPE,
            status: STATUS_RUNNING,
            metadata: oversizedValidMeta,
            payload: null,
          },
        ],
      });
      assert.isUndefined(
        yield* readAntigravityRunningCommands({
          profileDirectory,
          sessionId: SESSION_ID,
          tools: [
            makeToolCall({
              toolCallId: `${SESSION_ID}:13`,
              commandLine: "pytest -q tests/",
              cwd: "/repo",
            }),
          ],
        }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

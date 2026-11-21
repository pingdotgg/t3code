// @effect-diagnostics nodeBuiltinImport:off -- fixtures write a native session database.
import * as NodeSqlite from "node:sqlite";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { hasLiveAntigravityScheduleTimer } from "./AntigravityScheduleWait.ts";

const SESSION_ID = "781904db-61aa-4a9c-b105-a7a195f7cf2e";
const GENERIC_STEP_TYPE = 132;
const STATUS_RUNNING = 2;
const STATUS_DONE = 3;
const STATUS_CANCELED = 6;
const BASE_EPOCH_MS = Date.UTC(2026, 10, 19, 23, 14, 34);

const varint = (value: number): number[] => {
  const bytes: number[] = [];
  while (value >= 0x80) {
    bytes.push((value & 0x7f) | 0x80);
    value = Math.floor(value / 0x80);
  }
  return [...bytes, value];
};
const varintField = (number: number, value: number) => [...varint(number * 8), ...varint(value)];
const bytesField = (number: number, value: string | Uint8Array) => {
  const bytes = typeof value === "string" ? new TextEncoder().encode(value) : value;
  return [...varint(number * 8 + 2), ...varint(bytes.length), ...bytes];
};
const proto = (...parts: number[][]) => Uint8Array.from(parts.flat());
const protoTimestamp = (epochMs: number) =>
  proto(varintField(1, Math.floor(epochMs / 1_000)), varintField(2, (epochMs % 1_000) * 1_000_000));

const scheduleMetadata = (input: {
  readonly createdAtMs?: number;
  readonly toolName?: string;
  readonly args: Record<string, unknown>;
}) =>
  proto(
    ...(input.createdAtMs === undefined ? [] : [bytesField(1, protoTimestamp(input.createdAtMs))]),
    bytesField(
      4,
      proto(
        bytesField(1, "call_schedule_1"),
        bytesField(2, input.toolName ?? "schedule"),
        bytesField(3, JSON.stringify(input.args)),
      ),
    ),
  );

const writeSessionDb = Effect.fn("writeSessionDb")(function* (input: {
  readonly profileDirectory: string;
  readonly sessionId?: string;
  readonly rows: ReadonlyArray<{
    readonly idx: number;
    readonly stepType: number;
    readonly status: number;
    readonly metadata: Uint8Array | null;
    readonly taskDetails?: Uint8Array | null;
    readonly payload?: Uint8Array | null;
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
      "CREATE TABLE IF NOT EXISTS steps (idx INTEGER PRIMARY KEY, step_type INTEGER NOT NULL, status INTEGER NOT NULL, metadata BLOB, task_details BLOB, step_payload BLOB)",
    );
    const insert = database.prepare("INSERT INTO steps VALUES (?, ?, ?, ?, ?, ?)");
    for (const row of input.rows) {
      insert.run(
        row.idx,
        row.stepType,
        row.status,
        row.metadata,
        row.taskDetails ?? null,
        row.payload ?? null,
      );
    }
  } finally {
    database.close();
  }
  return dbPath;
});

describe("hasLiveAntigravityScheduleTimer", () => {
  it.effect(
    "returns true while a one-shot schedule timer is unexpired and false once past grace",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();
        yield* TestClock.setTime(BASE_EPOCH_MS);
        yield* writeSessionDb({
          profileDirectory,
          rows: [
            {
              idx: 138,
              stepType: GENERIC_STEP_TYPE,
              status: STATUS_RUNNING,
              metadata: scheduleMetadata({
                createdAtMs: BASE_EPOCH_MS,
                args: { DurationSeconds: 3000, Prompt: "Check status", TimerCondition: "never" },
              }),
              taskDetails: proto(bytesField(8, protoTimestamp(BASE_EPOCH_MS))),
            },
          ],
        });

        yield* TestClock.adjust("15 minutes");
        assert.isTrue(
          yield* hasLiveAntigravityScheduleTimer({ profileDirectory, sessionId: SESSION_ID }),
        );

        yield* TestClock.adjust("30 minutes");
        assert.isTrue(
          yield* hasLiveAntigravityScheduleTimer({ profileDirectory, sessionId: SESSION_ID }),
        );

        // Past 50m duration + 1m grace -> no longer pauses inactivity watchdog.
        yield* TestClock.adjust("7 minutes");
        assert.isFalse(
          yield* hasLiveAntigravityScheduleTimer({ profileDirectory, sessionId: SESSION_ID }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns false for an expired orphaned schedule timer stuck in RUNNING", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      yield* TestClock.setTime(BASE_EPOCH_MS + 15 * 60_000);
      yield* writeSessionDb({
        profileDirectory,
        rows: [
          {
            idx: 85,
            stepType: GENERIC_STEP_TYPE,
            status: STATUS_RUNNING,
            metadata: scheduleMetadata({
              createdAtMs: BASE_EPOCH_MS,
              args: { DurationSeconds: 120, Prompt: "Check Ghidra" },
            }),
          },
        ],
      });
      assert.isFalse(
        yield* hasLiveAntigravityScheduleTimer({ profileDirectory, sessionId: SESSION_ID }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("returns false for finished, canceled, daemon, or non-schedule generic steps", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const profileDirectory = yield* fs.makeTempDirectoryScoped();
      yield* TestClock.setTime(BASE_EPOCH_MS + 60_000);
      yield* writeSessionDb({
        profileDirectory,
        rows: [
          {
            idx: 1,
            stepType: GENERIC_STEP_TYPE,
            status: STATUS_DONE,
            metadata: scheduleMetadata({
              createdAtMs: BASE_EPOCH_MS,
              args: { DurationSeconds: 3000 },
            }),
          },
          {
            idx: 2,
            stepType: GENERIC_STEP_TYPE,
            status: STATUS_CANCELED,
            metadata: scheduleMetadata({
              createdAtMs: BASE_EPOCH_MS,
              args: { DurationSeconds: 3000 },
            }),
          },
          {
            idx: 3,
            stepType: GENERIC_STEP_TYPE,
            status: STATUS_RUNNING,
            metadata: scheduleMetadata({
              createdAtMs: BASE_EPOCH_MS,
              args: { DurationSeconds: 3000, IsDaemon: true },
            }),
          },
          {
            idx: 4,
            stepType: GENERIC_STEP_TYPE,
            status: STATUS_RUNNING,
            metadata: scheduleMetadata({
              createdAtMs: BASE_EPOCH_MS,
              toolName: "manage_task",
              args: { DurationSeconds: 3000 },
            }),
          },
        ],
      });
      assert.isFalse(
        yield* hasLiveAntigravityScheduleTimer({ profileDirectory, sessionId: SESSION_ID }),
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "returns false when the session database is missing, symlinked, or lacks timestamps",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();
        yield* TestClock.setTime(BASE_EPOCH_MS + 60_000);

        assert.isFalse(
          yield* hasLiveAntigravityScheduleTimer({ profileDirectory, sessionId: SESSION_ID }),
        );

        const noTsId = "11111111-1111-1111-1111-111111111111";
        const realDb = yield* writeSessionDb({
          profileDirectory,
          sessionId: noTsId,
          rows: [
            {
              idx: 1,
              stepType: GENERIC_STEP_TYPE,
              status: STATUS_RUNNING,
              metadata: scheduleMetadata({ args: { DurationSeconds: 3000 } }),
            },
          ],
        });
        assert.isFalse(
          yield* hasLiveAntigravityScheduleTimer({ profileDirectory, sessionId: noTsId }),
        );

        const linkId = "22222222-2222-2222-2222-222222222222";
        yield* fs.symlink(
          realDb,
          path.join(profileDirectory, "antigravity-acp", "conversations", `${linkId}.db`),
        );
        assert.isFalse(
          yield* hasLiveAntigravityScheduleTimer({ profileDirectory, sessionId: linkId }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect(
    "finds a live schedule timer behind more than 32 newer non-schedule and expired RUNNING rows",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const profileDirectory = yield* fs.makeTempDirectoryScoped();
        yield* TestClock.setTime(BASE_EPOCH_MS + 15 * 60_000);
        const rows = [
          {
            idx: 1,
            stepType: GENERIC_STEP_TYPE,
            status: STATUS_RUNNING,
            metadata: scheduleMetadata({
              createdAtMs: BASE_EPOCH_MS,
              args: { DurationSeconds: 3000, Prompt: "Live timer" },
            }),
          },
          // 40 newer expired schedule rows (exceeds one page of 32)
          ...Array.from({ length: 40 }, (_, index) => ({
            idx: 10 + index,
            stepType: GENERIC_STEP_TYPE,
            status: STATUS_RUNNING,
            metadata: scheduleMetadata({
              createdAtMs: BASE_EPOCH_MS,
              args: { DurationSeconds: 120, Prompt: `Expired ${index}` },
            }),
          })),
          // 40 newer non-schedule RUNNING GENERIC rows
          ...Array.from({ length: 40 }, (_, index) => ({
            idx: 100 + index,
            stepType: GENERIC_STEP_TYPE,
            status: STATUS_RUNNING,
            metadata: scheduleMetadata({
              createdAtMs: BASE_EPOCH_MS,
              toolName: "manage_task",
              args: { Action: "list" },
            }),
          })),
        ];
        yield* writeSessionDb({ profileDirectory, rows });
        assert.isTrue(
          yield* hasLiveAntigravityScheduleTimer({ profileDirectory, sessionId: SESSION_ID }),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );
});

// @effect-diagnostics nodeBuiltinImport:off - The ownership lock is a native SQLite handle held for the server's lifetime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "./processRunner.ts";
import {
  clearPersistedServerRuntimeState,
  isProcessAlive,
  persistServerRuntimeState,
  readPersistedServerRuntimeState,
  type PersistedServerRuntimeState,
} from "./serverRuntimeState.ts";

export class ServerAlreadyRunningError extends Schema.TaggedError<ServerAlreadyRunningError>()(
  "ServerAlreadyRunningError",
  { stateDir: Schema.String },
) {
  // Distinct process exit code so a supervisor can tell "owned by another
  // server" apart from a crash and stop restarting.
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_STATE_DIR_OWNED;

  override get message(): string {
    return `A T3 Code server already owns ${this.stateDir}. Stop that server, or use a separate T3 home and pair with it, then retry. No server was stopped.`;
  }
}

export class ServerOwnershipError extends Schema.TaggedError<ServerOwnershipError>()(
  "ServerOwnershipError",
  { stateDir: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not acquire server ownership of ${this.stateDir}.`;
  }
}

const isSqliteBusy = (cause: unknown) =>
  cause instanceof Error &&
  (("errcode" in cause && cause.errcode === 5) ||
    ("code" in cause && cause.code === "SQLITE_BUSY"));

/**
 * Servers from before this lock only publish `server-runtime.json`. Treat
 * their record as stale only when the process start time proves PID reuse.
 */
const legacyOwnerIsLive = Effect.fn("legacyOwnerIsLive")(function* (
  state: PersistedServerRuntimeState,
) {
  if (!isProcessAlive(state.pid)) return false;
  const recordedAt = Date.parse(state.startedAt);
  if (!Number.isFinite(recordedAt)) return true;
  const windows = (yield* HostProcess.Platform) === "win32";
  const runner = yield* ProcessRunner.ProcessRunner;
  const result = yield* runner
    .run({
      command: windows ? "powershell.exe" : "ps",
      args: windows
        ? [
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            `(Get-Process -Id ${state.pid} -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o')`,
          ]
        : ["-p", String(state.pid), "-o", "lstart="],
      env: { LC_ALL: "C", TZ: "UTC" },
      timeout: Duration.seconds(2),
      maxOutputBytes: 16_384,
    })
    .pipe(Effect.option);
  if (Option.isNone(result) || result.value.code !== 0) return true;
  const output = result.value.stdout.trim();
  const startedAt = Date.parse(windows ? output : `${output} UTC`);
  // ps reports whole seconds. Unknown identity stays conservative.
  return !Number.isFinite(startedAt) || startedAt <= recordedAt + 1_000;
});

/**
 * Hold an exclusive lock on the state directory until the scope closes. The
 * lock is an exclusive transaction on `server-owner.sqlite`, which never holds
 * data and must never be unlinked: the OS releases it when the process exits,
 * even on SIGKILL, so a crashed owner never blocks the next start.
 */
export const acquireServerOwnership = Effect.fn("acquireServerOwnership")(function* (
  statePath: string,
) {
  const stateDir = NodePath.dirname(statePath);
  const crypto = yield* Crypto.Crypto;
  const ownerId = yield* crypto.randomUUIDv4.pipe(
    Effect.mapError((cause) => new ServerOwnershipError({ stateDir, cause })),
  );
  yield* Effect.acquireRelease(
    Effect.try({
      try: () => {
        NodeFS.mkdirSync(stateDir, { recursive: true });
        const db = new NodeSqlite.DatabaseSync(NodePath.join(stateDir, "server-owner.sqlite"));
        try {
          db.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE;");
        } catch (cause) {
          db.close();
          throw cause;
        }
        return db;
      },
      catch: (cause) =>
        isSqliteBusy(cause)
          ? new ServerAlreadyRunningError({ stateDir })
          : new ServerOwnershipError({ stateDir, cause }),
    }),
    (db) =>
      readPersistedServerRuntimeState(statePath).pipe(
        // Only remove discovery this owner published.
        Effect.flatMap((state) =>
          Option.isSome(state) && state.value.ownerId === ownerId
            ? clearPersistedServerRuntimeState(statePath)
            : Effect.void,
        ),
        Effect.ignore({ log: true }),
        Effect.ensuring(Effect.sync(() => db.close())),
      ),
  );

  // An unreadable record cannot name a live owner; this server replaces it.
  const previous = yield* readPersistedServerRuntimeState(statePath).pipe(
    Effect.orElseSucceed(() => Option.none<PersistedServerRuntimeState>()),
  );
  if (
    Option.isSome(previous) &&
    previous.value.ownerId === undefined &&
    (yield* legacyOwnerIsLive(previous.value))
  ) {
    return yield* new ServerAlreadyRunningError({ stateDir });
  }

  return {
    publish: (state: PersistedServerRuntimeState) =>
      persistServerRuntimeState({ path: statePath, state: { ...state, ownerId } }),
  };
});

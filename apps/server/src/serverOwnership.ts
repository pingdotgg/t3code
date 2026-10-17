// @effect-diagnostics nodeBuiltinImport:off - The ownership lock is a native SQLite handle held for the server's lifetime.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import { SERVER_EXIT_CODE_STATE_DIR_OWNED } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Crypto from "effect/Crypto";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Runtime from "effect/Runtime";
import * as Schema from "effect/Schema";

import {
  BOOT_SERVICE_LAUNCHD_LABEL,
  BOOT_SERVICE_PLIST_FILE,
  BOOT_SERVICE_UNIT_FILE,
  bootServiceBaseDirOf,
} from "./cloud/bootService.ts";
import { decodeServicePreflightResult } from "./cloud/servicePreflight.ts";
import {
  SERVICE_LAUNCHER_CONTEXT_ENV,
  SERVICE_LAUNCHER_PROTOCOL,
  SERVICE_RESTART_PENDING_FILE,
  SERVICE_STATE_FILE,
  serviceStateActiveVersion,
} from "./cloud/serviceProtocol.ts";
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

export class OlderBootServiceError extends Schema.TaggedError<OlderBootServiceError>()(
  "OlderBootServiceError",
  { baseDir: Schema.String },
) {
  override readonly [Runtime.errorExitCode] = SERVER_EXIT_CODE_STATE_DIR_OWNED;

  override get message(): string {
    return `A T3 Code background service set up for ${this.baseDir} runs an older release or has not restarted into its update, so it cannot share that home safely. On the machine that hosts it, update it with \`t3 update\` and let it restart (or run \`t3 service restart\` if the update is already installed), or remove it with \`t3 service uninstall\`. Pass \`--base-dir ${this.baseDir}\` to each command, and use \`npx t3\` if \`t3\` is not installed. Then retry. No server was stopped.`;
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

const decodeJson = Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown));

/**
 * Background services from before this lock never take it, and once another
 * server replaces their runtime record nothing names them. Returns the T3 home
 * of the boot service installed for this user when it serves this state
 * directory, runs now or at next login, and runs a release without the lock.
 * Best effort: anything that cannot be read or probed allows startup.
 */
const olderBootServiceHome = Effect.fn("olderBootServiceHome")(
  function* (stateDir: string) {
    if ((yield* HostProcess.Environment)[SERVICE_LAUNCHER_CONTEXT_ENV] !== undefined) {
      return undefined;
    }
    const platform = yield* HostProcess.Platform;
    const uid = yield* HostProcess.UserId;
    const homeDir = yield* HostProcess.HomeDirectory;
    const fs = yield* FileSystem.FileSystem;
    const runner = yield* ProcessRunner.ProcessRunner;
    const run = (command: string, args: ReadonlyArray<string>) =>
      runner.run({ command, args, timeout: Duration.seconds(5) });
    const manager =
      platform === "darwin" && uid !== undefined
        ? {
            unitPath: NodePath.join(homeDir, "Library", "LaunchAgents", BOOT_SERVICE_PLIST_FILE),
            loaded: run("launchctl", ["print", `gui/${uid}/${BOOT_SERVICE_LAUNCHD_LABEL}`]).pipe(
              Effect.map((result) => result.code === 0),
            ),
            // macOS 12 and earlier print `true` for a disabled label instead of `disabled`.
            scheduled: run("launchctl", ["print-disabled", `gui/${uid}`]).pipe(
              Effect.map(
                (result) =>
                  result.code === 0 &&
                  !result.stdout.includes(`"${BOOT_SERVICE_LAUNCHD_LABEL}" => disabled`) &&
                  !result.stdout.includes(`"${BOOT_SERVICE_LAUNCHD_LABEL}" => true`),
              ),
            ),
          }
        : platform === "linux"
          ? {
              unitPath: NodePath.join(
                homeDir,
                ".config",
                "systemd",
                "user",
                BOOT_SERVICE_UNIT_FILE,
              ),
              // A unit waiting out its `Restart=` delay is `activating`, with exit code 3.
              loaded: run("systemctl", ["--user", "is-active", BOOT_SERVICE_UNIT_FILE]).pipe(
                Effect.map((result) => result.code === 0 || result.stdout.trim() === "activating"),
              ),
              scheduled: run("systemctl", ["--user", "is-enabled", BOOT_SERVICE_UNIT_FILE]).pipe(
                Effect.map((result) => result.stdout.trim() === "enabled"),
              ),
            }
          : undefined;
    if (manager === undefined) return undefined;

    const baseDir = bootServiceBaseDirOf(yield* fs.readFileString(manager.unitPath));
    if (
      baseDir === undefined ||
      (yield* fs.realPath(NodePath.join(baseDir, "userdata"))) !== (yield* fs.realPath(stateDir))
    ) {
      return undefined;
    }
    const runtimeDir = NodePath.join(baseDir, "runtime");
    const version = serviceStateActiveVersion(
      yield* fs.readFileString(NodePath.join(runtimeDir, SERVICE_STATE_FILE)),
    );
    if (version === undefined) return undefined;
    if (yield* manager.loaded) {
      // `t3 update` with the restart declined names the new release in
      // service-state.json while the loaded service keeps running the old
      // one, so probing that release would prove nothing.
      if (yield* fs.exists(NodePath.join(runtimeDir, SERVICE_RESTART_PENDING_FILE))) return baseDir;
    } else if (!(yield* manager.scheduled)) {
      return undefined;
    }
    const preflight = yield* runner.run({
      command: NodePath.join(runtimeDir, "versions", version, "t3"),
      args: [
        "__service-preflight",
        "--database-path",
        NodePath.join(stateDir, "statev2.sqlite"),
        "--launcher-protocol",
        String(SERVICE_LAUNCHER_PROTOCOL),
      ],
      timeout: Duration.seconds(15),
    });
    if (preflight.code !== 0) return undefined;
    const answer = decodeServicePreflightResult(yield* decodeJson(preflight.stdout));
    return answer !== undefined && answer.ownershipProtocol === undefined ? baseDir : undefined;
  },
  Effect.orElseSucceed(() => undefined),
);

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
  const ownerId = yield* crypto
    .randomUUIDv4()
    .pipe(Effect.mapError((cause) => new ServerOwnershipError({ stateDir, cause })));
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
        Effect.flatMap((state) =>
          Option.isSome(state) && state.value.ownerId === ownerId
            ? clearPersistedServerRuntimeState(statePath)
            : Effect.void,
        ),
        Effect.ignore({ log: true }),
        Effect.ensuring(Effect.sync(() => db.close())),
      ),
  );

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
  const olderServiceHome = yield* olderBootServiceHome(stateDir);
  if (olderServiceHome !== undefined) {
    return yield* new OlderBootServiceError({ baseDir: olderServiceHome });
  }

  return {
    publish: (state: PersistedServerRuntimeState) =>
      persistServerRuntimeState({ path: statePath, state: { ...state, ownerId } }),
  };
});

// @effect-diagnostics nodeBuiltinImport:off - Probes the server's native SQLite ownership lock and an SSH-launched server's command line.
import * as NodeChildProcess from "node:child_process";
import * as NodeSqlite from "node:sqlite";
import * as NodeUtil from "node:util";

import { compareSemverVersions } from "@t3tools/shared/semver";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import { msg } from "gt-i18n";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import { m } from "../i18n/messages.ts";
import { BACKEND_QUIT_STOP_TIMEOUT } from "./DesktopBackendManager.ts";

// The fields of the server's `server-runtime.json` that identify the owner of a T3 home.
const HomeOwnerRuntimeState = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
});
export type HomeOwner = typeof HomeOwnerRuntimeState.Type;

const execFile = NodeUtil.promisify(NodeChildProcess.execFile);

const decodeHomeOwner = Schema.decodeUnknownOption(Schema.fromJsonString(HomeOwnerRuntimeState));

/** Signal 0 only probes existence; EPERM still means alive. */
const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

/**
 * Whether a server holds the T3 home's ownership lock (an exclusive transaction on
 * `server-owner.sqlite`). A read-only read is refused with SQLITE_BUSY only while it is held.
 */
const isHomeOwnershipLocked = Effect.fn("DesktopHomeOwner.isHomeOwnershipLocked")(function* () {
  const path = yield* Path.Path;
  const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
  const lockPath = path.join(stateDir, "server-owner.sqlite");
  return yield* Effect.sync(() => {
    try {
      const db = new NodeSqlite.DatabaseSync(lockPath, { readOnly: true });
      try {
        db.exec("PRAGMA busy_timeout = 0");
        db.prepare("SELECT count(*) FROM sqlite_master").get();
        return false;
      } finally {
        db.close();
      }
    } catch (cause) {
      // Anything but SQLITE_BUSY (a missing file included) leaves the decision to the backend.
      return cause instanceof Error && "errcode" in cause && cause.errcode === 5;
    }
  });
});

// A quitting app's backend holds the lock until it exits, which can outlast the relaunch of an update.
const HOME_OWNERSHIP_RELEASE_GRACE = Duration.sum(BACKEND_QUIT_STOP_TIMEOUT, Duration.seconds(3));
const HOME_OWNERSHIP_RELEASE_POLL_INTERVAL = Duration.millis(250);

/** Whether the ownership lock is free, or frees within the grace a shutting-down server needs. */
export const awaitHomeOwnershipRelease = Effect.fn("DesktopHomeOwner.awaitHomeOwnershipRelease")(
  function* () {
    while (yield* isHomeOwnershipLocked()) {
      yield* Effect.sleep(HOME_OWNERSHIP_RELEASE_POLL_INTERVAL);
    }
    return true;
  },
  Effect.timeoutOrElse({
    duration: HOME_OWNERSHIP_RELEASE_GRACE,
    orElse: () => Effect.succeed(false),
  }),
);

/** The live server recorded as owning the desktop's T3 home. Only call once the ownership lock is known held: a live PID alone may be reused. */
export const readLiveHomeOwner = Effect.fn("DesktopHomeOwner.readLiveHomeOwner")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { stateDir } = yield* DesktopEnvironment.DesktopEnvironment;
  const raw = yield* fs
    .readFileString(path.join(stateDir, "server-runtime.json"))
    .pipe(Effect.option);
  return Option.flatMap(raw, decodeHomeOwner).pipe(
    Option.filter((owner) => isProcessAlive(owner.pid)),
  );
});

const SSH_LAUNCH_LOCK_WAIT = Duration.seconds(10);
const SSH_LAUNCH_LOCK_HOLD = Duration.minutes(2);

// The SSH launch script in packages/ssh starts exactly this command line.
const isSshLaunchedServe = (pid: number) =>
  Effect.tryPromise({
    try: () => execFile("ps", ["-ww", "-o", "args=", "-p", String(pid)]),
    catch: () => undefined,
  }).pipe(
    Effect.match({
      onFailure: () => false,
      onSuccess: ({ stdout }) => / serve --host 127\.0\.0\.1 --port \d/u.test(stdout),
    }),
  );

/**
 * A server that a T3 Code app on another machine launched over SSH, recorded as `managed`
 * under `<home>/ssh-launch/<key>/`. A newer one may have migrated the database past this app.
 */
const isYieldingSshServer = Effect.fn("DesktopHomeOwner.isYieldingSshServer")(function* (
  owner: HomeOwner,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const { baseDir, appVersion } = yield* DesktopEnvironment.DesktopEnvironment;
  if (
    owner.serviceManaged === true ||
    owner.serverVersion === undefined ||
    compareSemverVersions(owner.serverVersion, appVersion) > 0
  ) {
    return false;
  }
  const launchDir = path.join(baseDir, "ssh-launch");
  const read = (file: string) =>
    fs.readFileString(path.join(launchDir, file)).pipe(
      Effect.map((text) => text.trim()),
      Effect.orElseSucceed(() => ""),
    );
  for (const key of yield* fs.readDirectory(launchDir).pipe(Effect.orElseSucceed(() => []))) {
    if (
      (yield* read(path.join(key, "managed"))) === "managed" &&
      (yield* read(path.join(key, "pid"))) === String(owner.pid)
    ) {
      return yield* isSshLaunchedServe(owner.pid);
    }
  }
  return false;
});

/**
 * Stops a server that another machine's T3 Code app launched over SSH on this home, so this app
 * can own it. That app restarts its server through the launch script, which waits on the launch
 * lock held here until this app's backend owns the home, and then adopts that backend instead.
 */
export const reclaimHomeFromSshServer = Effect.fn("DesktopHomeOwner.reclaimHomeFromSshServer")(
  function* () {
    if (!(yield* isHomeOwnershipLocked())) return false;
    const owner = yield* readLiveHomeOwner();
    if (Option.isNone(owner) || !(yield* isYieldingSshServer(owner.value))) return false;

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { baseDir } = yield* DesktopEnvironment.DesktopEnvironment;
    const lockPath = path.join(baseDir, "ssh-launch", ".launch.lock");
    const lockContents = `${process.pid}\n`;
    const takeLock = fs
      .writeFileString(lockPath, lockContents, { flag: "wx" })
      .pipe(Effect.retry(Schedule.spaced("250 millis")));
    const releaseLock = fs.readFileString(lockPath).pipe(
      Effect.flatMap((contents) => (contents === lockContents ? fs.remove(lockPath) : Effect.void)),
      Effect.ignore,
    );
    const locked = yield* takeLock.pipe(
      Effect.timeoutOption(SSH_LAUNCH_LOCK_WAIT),
      Effect.map(Option.isSome),
    );
    if (!locked) return false;
    yield* Effect.addFinalizer(() => releaseLock);
    // A launch that held the lock may have replaced that server.
    if (Option.getOrUndefined(yield* readLiveHomeOwner())?.pid !== owner.value.pid) {
      yield* releaseLock;
      return false;
    }

    yield* Effect.logInfo("stopping a server launched over SSH to use this T3 home", owner.value);
    yield* Effect.try({
      try: () => process.kill(owner.value.pid, "SIGTERM"),
      catch: () => undefined,
    }).pipe(Effect.ignore);
    if (!(yield* awaitHomeOwnershipRelease())) {
      yield* releaseLock;
      return false;
    }
    yield* Effect.gen(function* () {
      while (!(yield* isHomeOwnershipLocked())) {
        yield* Effect.sleep(HOME_OWNERSHIP_RELEASE_POLL_INTERVAL);
      }
    }).pipe(
      Effect.timeoutOption(SSH_LAUNCH_LOCK_HOLD),
      Effect.ensuring(releaseLock),
      Effect.forkScoped,
    );
    return true;
  },
);

export const homeOwnedMessage = (owner: Option.Option<HomeOwner>): string =>
  Option.match(owner, {
    onNone: () =>
      m(
        msg(
          "Another T3 Code server, such as the background service, is using this data directory, or an older background service is set up for it. Stop that server or try `t3 update`. If the older launcher cannot update, run `t3 service uninstall` and optionally reinstall with `t3 service install` from a current CLI. Use `npx t3@latest` if `t3` is missing or outdated, and pass `--base-dir` with the service's T3 home to each command. Then reopen T3 Code. You can also set a separate T3CODE_HOME and pair with the running server.",
        ),
      ),
    onSome: (owner) => {
      const variables = {
        pid: String(owner.pid),
        port: String(owner.port),
        version: owner.serverVersion ?? "",
      };
      if (owner.serviceManaged) {
        return owner.serverVersion
          ? m(
              msg(
                "The T3 Code background service is using this T3 home (PID {pid}, port {port}, version {version}). Stop it with `t3 service uninstall`, passing `--base-dir` with this T3 home, and reopen T3 Code. You can also set a separate T3CODE_HOME and pair with the running server.",
              ),
              variables,
            )
          : m(
              msg(
                "The T3 Code background service is using this T3 home (PID {pid}, port {port}). Stop it with `t3 service uninstall`, passing `--base-dir` with this T3 home, and reopen T3 Code. You can also set a separate T3CODE_HOME and pair with the running server.",
              ),
              variables,
            );
      }
      return owner.serverVersion
        ? m(
            msg(
              "Another T3 Code server (for example `t3 serve`, or one started over SSH) is using this T3 home (PID {pid}, port {port}, version {version}). If a T3 Code app on another machine started it over SSH, that app restarts it: remove or disconnect that SSH environment there, or quit that app. Then stop the server, and reopen T3 Code. You can also set a separate T3CODE_HOME and pair with the running server.",
            ),
            variables,
          )
        : m(
            msg(
              "Another T3 Code server (for example `t3 serve`, or one started over SSH) is using this T3 home (PID {pid}, port {port}). If a T3 Code app on another machine started it over SSH, that app restarts it: remove or disconnect that SSH environment there, or quit that app. Then stop the server, and reopen T3 Code. You can also set a separate T3CODE_HOME and pair with the running server.",
            ),
            variables,
          );
    },
  });

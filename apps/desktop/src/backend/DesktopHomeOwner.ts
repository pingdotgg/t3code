// @effect-diagnostics nodeBuiltinImport:off - Probes the server's native SQLite ownership lock.
import * as NodeSqlite from "node:sqlite";

import { verifyLoopbackDiscoveryProof } from "@t3tools/client-runtime/connection";
import { AuthSessionId } from "@t3tools/contracts";
import { CLI_RELEASES_PAGE_URL } from "@t3tools/shared/cliRelease";
import * as Hex from "effect/encoding/Hex";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Exit from "effect/Exit";
import * as Scope from "effect/Scope";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as DesktopManagedPolicy from "../app/DesktopManagedPolicy.ts";
import { BACKEND_QUIT_STOP_TIMEOUT } from "./DesktopBackendManager.ts";

// The fields of the server's `server-runtime.json` that identify the owner of a T3 home.
const HomeOwnerRuntimeState = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
  managedPolicy: Schema.optional(Schema.NullOr(Schema.Unknown)),
});
export type HomeOwner = typeof HomeOwnerRuntimeState.Type;

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

const decodeSession = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ sessionId: AuthSessionId, token: Schema.String })),
);

export type HomeOwnerSession = { readonly port: number; readonly token: string };

export const authenticateHomeOwner = Effect.fn("DesktopHomeOwner.authenticateHomeOwner")(
  function* (owner: HomeOwner) {
    const environment = yield* DesktopEnvironment.DesktopEnvironment;
    if (
      environment.isDevelopment ||
      owner.port < 1 ||
      owner.port > 65535 ||
      owner.managedPolicy !== null
    ) {
      return Option.none<HomeOwnerSession>();
    }
    // Only the server can attest its enforced policy. A separately launched CLI cannot.
    if (yield* (yield* DesktopManagedPolicy.DesktopManagedPolicy).read)
      return Option.none<HomeOwnerSession>();
    const fs = yield* FileSystem.FileSystem;
    const environmentId = (yield* fs.readFileString(
      environment.path.join(environment.stateDir, "environment-id"),
    )).trim();
    if (!environmentId) return Option.none<HomeOwnerSession>();
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const sessionCommand = (args: ReadonlyArray<string>) =>
      spawner
        .string(
          ChildProcess.make(
            process.execPath,
            [
              environment.backendEntryPath,
              "auth",
              "session",
              ...args,
              "--base-dir",
              environment.baseDir,
            ],
            {
              env: { ELECTRON_RUN_AS_NODE: "1" },
              extendEnv: true,
              stdin: "ignore",
              stderr: "ignore",
            },
          ),
        )
        .pipe(Effect.timeout("15 seconds"));
    const nonce = Hex.encode(yield* (yield* SecureRandom.SecureRandom).randomBytes(32));
    const desktopScope = yield* Scope.Scope;
    return yield* Effect.acquireUseRelease(
      sessionCommand(["issue", "--label", "T3 Code Desktop", "--json"]).pipe(
        Effect.flatMap(decodeSession),
      ),
      (session) =>
        Effect.promise((signal) =>
          verifyLoopbackDiscoveryProof({
            token: session.token,
            environmentId,
            port: owner.port,
            nonce,
            fetchProof: fetch,
            signal,
          }),
        ).pipe(
          Effect.timeout("3 seconds"),
          Effect.map((verified) =>
            verified
              ? Option.some({ port: owner.port, token: session.token })
              : Option.none<HomeOwnerSession>(),
          ),
        ),
      ({ sessionId }, exit) => {
        const revoke = sessionCommand(["revoke", sessionId]).pipe(Effect.ignore);
        return Exit.isSuccess(exit) && Option.isSome(exit.value)
          ? Scope.addFinalizer(desktopScope, revoke)
          : revoke;
      },
    );
  },
  Effect.orElseSucceed(() => Option.none<HomeOwnerSession>()),
);

export const homeOwnedMessage = (owner: Option.Option<HomeOwner>): string =>
  Option.match(owner, {
    onNone: () =>
      `Another T3 Code server, such as the background service, is using this data directory, or an older background service is set up for it. Stop that server or try \`t3 update\`. If the older launcher cannot update, run \`t3 service uninstall\` and optionally reinstall with \`t3 service install\` from a current CLI. If \`t3\` is missing or outdated, download a current CLI from ${CLI_RELEASES_PAGE_URL}. Pass \`--base-dir\` with the service's T3 home to each command. Then reopen T3 Code. You can also set a separate T3CODE_HOME and pair with the running server.`,
    onSome: (owner) => {
      const kind = owner.serviceManaged
        ? "The T3 Code background service"
        : "Another T3 Code server (for example `t3 serve`, or one started over SSH)";
      const version = owner.serverVersion ? `, version ${owner.serverVersion}` : "";
      const stop = owner.serviceManaged
        ? "Stop it with `t3 service uninstall`, passing `--base-dir` with this T3 home"
        : "If a T3 Code app on another machine started it over SSH, that app restarts it: remove or disconnect that SSH environment there, or quit that app. Then stop the server";
      return `${kind} is using this T3 home (PID ${owner.pid}, port ${owner.port}${version}). ${stop}, and reopen T3 Code. You can also set a separate T3CODE_HOME and pair with the running server.`;
    },
  });

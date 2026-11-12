// @effect-diagnostics nodeBuiltinImport:off - Probes the server's native SQLite ownership lock.
import * as NodeSqlite from "node:sqlite";

import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import * as DesktopEnvironment from "../app/DesktopEnvironment.ts";
import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as DesktopAppSettings from "../settings/DesktopAppSettings.ts";

// The fields of the server's `server-runtime.json` that identify the owner of a T3 home.
const HomeOwnerRuntimeState = Schema.Struct({
  pid: Schema.Int,
  port: Schema.Int,
  serviceManaged: Schema.optional(Schema.Boolean),
  serverVersion: Schema.optional(Schema.String),
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
export const isHomeOwnershipLocked = Effect.fn("DesktopHomeOwner.isHomeOwnershipLocked")(
  function* () {
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
  },
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

const USE_WITH_OWNER =
  "To keep it running and use this app with it, turn off Local environment and pair with it.";

export const homeOwnedMessage = (owner: Option.Option<HomeOwner>): string =>
  Option.match(owner, {
    onNone: () =>
      `Another T3 Code server, such as the background service, is using this data directory, or an older background service is set up for it. ${USE_WITH_OWNER} Otherwise, stop that server or try \`t3 update\`. If the older launcher cannot update, run \`t3 service uninstall\` and optionally reinstall with \`t3 service install\` from a current CLI. Use \`npx t3@latest\` if \`t3\` is missing or outdated, and pass \`--base-dir\` with the service's T3 home to each command. Then reopen T3 Code. You can also set a separate T3CODE_HOME and pair with the running server.`,
    onSome: (owner) => {
      const version = owner.serverVersion ? `, version ${owner.serverVersion}` : "";
      if (owner.serviceManaged) {
        return `The T3 Code background service is using this T3 home (PID ${owner.pid}, port ${owner.port}${version}). ${USE_WITH_OWNER} You can also set a separate T3CODE_HOME for this app.`;
      }
      return `Another T3 Code server (for example \`t3 serve\`, or one started over SSH) is using this T3 home (PID ${owner.pid}, port ${owner.port}${version}). ${USE_WITH_OWNER} Otherwise, if a T3 Code app on another machine started it over SSH, that app restarts it: remove or disconnect that SSH environment there, or quit that app. Then stop the server, and reopen T3 Code. You can also set a separate T3CODE_HOME and pair with the running server.`;
    },
  });

/**
 * Explains who owns the T3 home and offers the supported setup. True once Local environment is
 * turned off; the caller quits otherwise.
 */
export const offerLocalEnvironmentOff = Effect.fn("DesktopHomeOwner.offerLocalEnvironmentOff")(
  function* (owner: Option.Option<HomeOwner>) {
    const dialog = yield* ElectronDialog.ElectronDialog;
    const appSettings = yield* DesktopAppSettings.DesktopAppSettings;
    const { response } = yield* dialog.showMessageBox({
      type: "warning",
      title: "This T3 home is unavailable",
      message: "This T3 home is unavailable",
      detail: homeOwnedMessage(owner),
      buttons: ["Turn Off Local Environment", "Quit"],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
    });
    if (response !== 0) return false;
    yield* appSettings.setLocalEnvironmentEnabled(false);
    return true;
  },
);

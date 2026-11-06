// @effect-diagnostics nodeBuiltinImport:off -- Startup ownership probing must use the native SQLite lock before Electron is ready.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  T3_LEARN_ELECTRON_USER_DATA,
  T3_LEARN_HOME_DIRECTORY,
  T3_LEARN_LEGACY,
} from "@t3tools/shared/t3LearnIdentity";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

export interface DesktopRenameMigrationInput {
  readonly homeDirectory: string;
  readonly appDataDirectory: string;
  readonly explicitHome: Option.Option<string>;
  readonly isHomeOwned?: (legacyHome: string) => Effect.Effect<boolean>;
}

export interface DesktopRenameMigrationResult {
  readonly homePath: string;
  readonly userDataPath: string;
}

const isProcessAlive = (pid: number): boolean => {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
};

const nativeHomeIsOwned = (legacyHome: string): boolean => {
  const stateDir = NodePath.join(legacyHome, "userdata");
  const runtimePath = NodePath.join(stateDir, "server-runtime.json");
  try {
    const runtime = JSON.parse(NodeFS.readFileSync(runtimePath, "utf8")) as { pid?: unknown };
    if (typeof runtime.pid === "number" && isProcessAlive(runtime.pid)) return true;
  } catch {}

  const lockPath = NodePath.join(stateDir, "server-owner.sqlite");
  if (!NodeFS.existsSync(lockPath)) return false;
  try {
    const database = new NodeSqlite.DatabaseSync(lockPath);
    try {
      database.exec("PRAGMA busy_timeout = 0; BEGIN EXCLUSIVE; ROLLBACK;");
      return false;
    } finally {
      database.close();
    }
  } catch {
    // A malformed or unavailable lock is safer to treat as owned than to rename under a server.
    return true;
  }
};

const lstat = (fs: FileSystem.FileSystem, path: string) => fs.lstat(path).pipe(Effect.option);

const migrateDirectory = Effect.fn("desktop.renameMigration.migrateDirectory")(function* (input: {
  readonly fs: FileSystem.FileSystem;
  readonly legacyPath: string;
  readonly currentPath: string;
  readonly isOwned?: () => Effect.Effect<boolean>;
}) {
  const current = yield* lstat(input.fs, input.currentPath);
  if (Option.isSome(current)) return input.currentPath;

  const legacy = yield* lstat(input.fs, input.legacyPath);
  if (Option.isNone(legacy)) return input.currentPath;
  if (legacy.value.type === "SymbolicLink") return input.legacyPath;
  if (legacy.value.type !== "Directory") return input.currentPath;
  if (input.isOwned !== undefined && (yield* input.isOwned())) {
    yield* Effect.logWarning("leaving the legacy desktop home in place because a server owns it", {
      legacyPath: input.legacyPath,
    });
    return input.legacyPath;
  }

  const move = input.fs
    .rename(input.legacyPath, input.currentPath)
    .pipe(Effect.andThen(input.fs.symlink(input.currentPath, input.legacyPath)));
  return yield* move.pipe(
    Effect.as(input.currentPath),
    Effect.catch((cause) =>
      input.fs.rename(input.currentPath, input.legacyPath).pipe(
        Effect.ignore,
        Effect.andThen(
          Effect.logWarning("could not migrate the legacy desktop home", {
            legacyPath: input.legacyPath,
            currentPath: input.currentPath,
            cause,
          }),
        ),
        Effect.as(input.legacyPath),
      ),
    ),
  );
});

export const migrateDesktopRename = Effect.fn("desktop.renameMigration.migrate")(function* (
  input: DesktopRenameMigrationInput,
) {
  const fs = yield* FileSystem.FileSystem;
  if (Option.isSome(input.explicitHome)) {
    return {
      homePath: input.explicitHome.value,
      userDataPath: NodePath.join(input.appDataDirectory, T3_LEARN_ELECTRON_USER_DATA),
    } satisfies DesktopRenameMigrationResult;
  }

  const legacyHome = NodePath.join(input.homeDirectory, T3_LEARN_LEGACY.homeDirectory);
  const currentHome = NodePath.join(input.homeDirectory, T3_LEARN_HOME_DIRECTORY);
  const homePath = yield* migrateDirectory({
    fs,
    legacyPath: legacyHome,
    currentPath: currentHome,
    isOwned: () =>
      input.isHomeOwned?.(legacyHome) ?? Effect.sync(() => nativeHomeIsOwned(legacyHome)),
  });

  return {
    homePath,
    userDataPath: NodePath.join(input.appDataDirectory, T3_LEARN_ELECTRON_USER_DATA),
  } satisfies DesktopRenameMigrationResult;
});

export const migrateElectronUserData = Effect.fn("desktop.renameMigration.migrateUserData")(
  function* (input: { readonly appDataDirectory: string; readonly platform: NodeJS.Platform }) {
    const fs = yield* FileSystem.FileSystem;
    const legacyPath = NodePath.join(input.appDataDirectory, T3_LEARN_LEGACY.electronUserData);
    const currentPath = NodePath.join(input.appDataDirectory, T3_LEARN_ELECTRON_USER_DATA);
    const current = yield* lstat(fs, currentPath);
    if (Option.isSome(current)) return currentPath;
    const legacy = yield* lstat(fs, legacyPath);
    if (Option.isNone(legacy)) return currentPath;
    if (legacy.value.type === "SymbolicLink") return legacyPath;
    if (legacy.value.type !== "Directory") return currentPath;

    const link = fs.symlink(currentPath, legacyPath).pipe(
      Effect.catch((cause) =>
        input.platform === "win32"
          ? Effect.try({
              try: () => NodeFS.symlinkSync(currentPath, legacyPath, "junction"),
              catch: () => cause,
            })
          : Effect.fail(cause),
      ),
    );
    return yield* fs.rename(legacyPath, currentPath).pipe(
      Effect.andThen(link),
      Effect.as(currentPath),
      Effect.catch((cause) =>
        fs.rename(currentPath, legacyPath).pipe(
          Effect.ignore,
          Effect.andThen(
            Effect.logWarning("could not migrate the legacy Electron user data", {
              legacyPath,
              currentPath,
              cause,
            }),
          ),
          Effect.as(legacyPath),
        ),
      ),
    );
  },
);

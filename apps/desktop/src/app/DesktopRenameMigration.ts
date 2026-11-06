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
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

export interface DesktopRenameMigrationInput {
  readonly homeDirectory: string;
  readonly platform?: NodeJS.Platform;
  readonly explicitHome: Option.Option<string>;
  readonly isHomeOwned?: (legacyHome: string) => Effect.Effect<boolean>;
}

export interface DesktopRenameMigrationResult {
  readonly homePath: string;
}

const nativeHomeIsOwned = (legacyHome: string): boolean => {
  const stateDir = NodePath.join(legacyHome, "userdata");
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
  readonly platform: NodeJS.Platform;
  readonly isOwned?: () => Effect.Effect<boolean>;
}) {
  const current = yield* lstat(input.fs, input.currentPath);
  if (Option.isSome(current)) {
    if (
      current.value.type === "Directory" &&
      Option.isNone(yield* lstat(input.fs, input.legacyPath))
    ) {
      yield* createLegacyLink(input).pipe(Effect.ignore);
    }
    return input.currentPath;
  }

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

  const renamed = yield* Effect.exit(input.fs.rename(input.legacyPath, input.currentPath));
  if (Exit.isFailure(renamed)) {
    yield* Effect.logWarning("could not migrate the legacy desktop home", {
      legacyPath: input.legacyPath,
      currentPath: input.currentPath,
      cause: renamed.cause,
    });
    return input.legacyPath;
  }
  return yield* createLegacyLink(input).pipe(
    Effect.as(input.currentPath),
    Effect.catch((cause) =>
      input.fs.rename(input.currentPath, input.legacyPath).pipe(
        Effect.matchEffect({
          onSuccess: () =>
            Effect.logWarning("could not migrate the legacy desktop home; move rolled back", {
              legacyPath: input.legacyPath,
              currentPath: input.currentPath,
              cause,
            }).pipe(Effect.as(input.legacyPath)),
          onFailure: (rollbackCause) =>
            Effect.logWarning("could not migrate the legacy desktop home or roll back", {
              legacyPath: input.legacyPath,
              currentPath: input.currentPath,
              cause,
              rollbackCause,
            }).pipe(Effect.as(input.currentPath)),
        }),
      ),
    ),
  );
});

const createLegacyLink = (input: {
  readonly fs: FileSystem.FileSystem;
  readonly legacyPath: string;
  readonly currentPath: string;
  readonly platform: NodeJS.Platform;
}) =>
  input.fs.symlink(input.currentPath, input.legacyPath).pipe(
    Effect.catch((cause) =>
      input.platform === "win32"
        ? Effect.try({
            try: () => NodeFS.symlinkSync(input.currentPath, input.legacyPath, "junction"),
            catch: () => cause,
          })
        : Effect.fail(cause),
    ),
  );

export const migrateDesktopRename = Effect.fn("desktop.renameMigration.migrate")(function* (
  input: DesktopRenameMigrationInput,
) {
  const fs = yield* FileSystem.FileSystem;
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Migration runs before Effect services are assembled.
  const platform = input.platform ?? process.platform;
  if (Option.isSome(input.explicitHome)) {
    return {
      homePath: input.explicitHome.value,
    } satisfies DesktopRenameMigrationResult;
  }

  const legacyHome = NodePath.join(input.homeDirectory, T3_LEARN_LEGACY.homeDirectory);
  const currentHome = NodePath.join(input.homeDirectory, T3_LEARN_HOME_DIRECTORY);
  const homePath = yield* migrateDirectory({
    fs,
    legacyPath: legacyHome,
    currentPath: currentHome,
    platform,
    isOwned: () =>
      input.isHomeOwned?.(legacyHome) ?? Effect.sync(() => nativeHomeIsOwned(legacyHome)),
  });

  return {
    homePath,
  } satisfies DesktopRenameMigrationResult;
});

export const migrateElectronUserData = Effect.fn("desktop.renameMigration.migrateUserData")(
  function* (input: { readonly appDataDirectory: string; readonly platform: NodeJS.Platform }) {
    const fs = yield* FileSystem.FileSystem;
    const legacyPath = NodePath.join(input.appDataDirectory, T3_LEARN_LEGACY.electronUserData);
    const currentPath = NodePath.join(input.appDataDirectory, T3_LEARN_ELECTRON_USER_DATA);
    return yield* migrateDirectory({
      fs,
      legacyPath,
      currentPath,
      platform: input.platform,
    });
  },
);

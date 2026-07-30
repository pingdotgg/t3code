// @effect-diagnostics nodeBuiltinImport:off
/**
 * WorkspaceProtectedPaths - shared guard for the Forma "Protected paths"
 * safety setting.
 *
 * Builds a small helper bundle that workspace services use to hide and block
 * OS-sensitive locations (e.g. `~/Documents`, `~/Library/Mail`) from browse,
 * search, and file mutation paths. The setting is read live from
 * `ServerSettingsService` on every check so toggling it in Settings → Safety
 * takes effect immediately. When the settings service is unavailable (tests,
 * partial layer compositions) the guard fails safe: protection stays enabled.
 *
 * @module WorkspaceProtectedPaths
 */
import * as NodeOS from "node:os";

import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { HostProcessPlatform } from "@t3tools/shared/hostProcess";
import {
  getProtectedAbsolutePaths,
  getProtectedDirectoryNames,
  isProtectedPath,
} from "@t3tools/shared/protectedPaths";

import { ServerSettingsService } from "../serverSettings.ts";

export interface ProtectedPathsGuard {
  /** Home directory used to derive protected locations. */
  readonly homeDir: string;
  /** Platform used to derive protected locations. */
  readonly platform: NodeJS.Platform;
  /** Whether the "Protected paths" safety setting is currently enabled. */
  readonly isEnabled: Effect.Effect<boolean>;
  /** Platform-level protection check, ignoring the settings toggle. */
  readonly isPathProtected: (absolutePath: string) => boolean;
  /** `true` when the setting is enabled and the path is protected. */
  readonly isPathBlocked: (absolutePath: string) => Effect.Effect<boolean>;
  /**
   * `true` when at least one protected location is equal to or inside `cwd`,
   * i.e. entry-level filtering of results under `cwd` could matter.
   */
  readonly hasProtectedDescendants: (cwd: string) => boolean;
  /**
   * `true` when the setting is enabled and at least one protected location is
   * equal to or inside `absolutePath`. Guards recursive/destructive operations
   * (delete, rename) on ancestors of protected locations.
   */
  readonly hasBlockedDescendants: (absolutePath: string) => Effect.Effect<boolean>;
  /**
   * Protected child directory names when `parentPath` is the home directory
   * (used to hide entries such as `Documents` from home-directory listings).
   */
  readonly protectedDirectoryNames: (
    parentPath: string,
    resolvePath: (value: string) => string,
  ) => ReadonlySet<string>;
}

const EMPTY_NAME_SET: ReadonlySet<string> = new Set<string>();

export const makeProtectedPathsGuard: Effect.Effect<ProtectedPathsGuard> = Effect.gen(function* () {
  const serverSettingsOption = yield* Effect.serviceOption(ServerSettingsService);
  const platform = yield* HostProcessPlatform;
  const homeDir = NodeOS.homedir();

  const isEnabled: Effect.Effect<boolean> = Option.match(serverSettingsOption, {
    onNone: () => Effect.succeed(true),
    onSome: (serverSettings) =>
      serverSettings.getSettings.pipe(
        Effect.map((settings) => settings.safety.protectedFilesystemPathsEnabled),
        Effect.orElseSucceed(() => true),
      ),
  });

  const isPathProtected = (absolutePath: string): boolean =>
    isProtectedPath({ path: absolutePath, platform, homeDir });

  const isPathBlocked = (absolutePath: string): Effect.Effect<boolean> =>
    Effect.map(isEnabled, (enabled) => enabled && isPathProtected(absolutePath));

  const hasProtectedDescendants = (cwd: string): boolean => {
    const separator = platform === "win32" ? "\\" : "/";
    const prefix = cwd.endsWith(separator) ? cwd : `${cwd}${separator}`;
    return getProtectedAbsolutePaths(platform, homeDir).some(
      (protectedPath) => protectedPath === cwd || protectedPath.startsWith(prefix),
    );
  };

  const hasBlockedDescendants = (absolutePath: string): Effect.Effect<boolean> =>
    Effect.map(isEnabled, (enabled) => enabled && hasProtectedDescendants(absolutePath));

  const protectedDirectoryNames = (
    parentPath: string,
    resolvePath: (value: string) => string,
  ): ReadonlySet<string> =>
    resolvePath(parentPath) === resolvePath(homeDir)
      ? getProtectedDirectoryNames(platform, homeDir)
      : EMPTY_NAME_SET;

  return {
    homeDir,
    platform,
    isEnabled,
    isPathProtected,
    isPathBlocked,
    hasProtectedDescendants,
    hasBlockedDescendants,
    protectedDirectoryNames,
  };
});

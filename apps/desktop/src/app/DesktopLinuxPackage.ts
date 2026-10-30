import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import type * as DesktopEnvironment from "./DesktopEnvironment.ts";

// electron-builder writes resources/package-type into its .deb and .rpm; electron-updater reads
// the same marker to install updates with dpkg, or dnf/zypper.
const SYSTEM_PACKAGE_TYPES: ReadonlyArray<string> = ["deb", "rpm"];

export const isSystemPackageType = (marker: string) => SYSTEM_PACKAGE_TYPES.includes(marker.trim());

// electron-builder installs the .deb and .rpm at /opt/<productName>; the packaged product name is
// the display name, so each channel has its own install.
export const systemPackagePaths = (displayName: string) => {
  const root = `/opt/${displayName}`;
  return {
    marker: `${root}/resources/package-type`,
    executable: `${root}/t3code`,
    serverEntry: `${root}/resources/app.asar/apps/server/dist/bin.mjs`,
  };
};

/**
 * The .deb or .rpm of this channel when an AppImage runs beside one. Shared launch integration
 * points at the package then, so removing the AppImage leaves links and the `t3` command working.
 */
export const findSystemPackageBesideAppImage = Effect.fn(
  "DesktopLinuxPackage.findSystemPackageBesideAppImage",
)(function* (environment: DesktopEnvironment.DesktopEnvironment["Service"]) {
  if (environment.platform !== "linux" || Option.isNone(environment.appImagePath)) {
    return Option.none<ReturnType<typeof systemPackagePaths>>();
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const paths = systemPackagePaths(environment.displayName);
  const marker = yield* fileSystem.readFileString(paths.marker).pipe(Effect.option);
  return Option.filter(marker, isSystemPackageType).pipe(Option.as(paths));
});

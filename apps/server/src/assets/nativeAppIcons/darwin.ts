import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import type { NativeAppIconReference } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as ServerConfig from "../../config.ts";
import { existingFile, type NativeAppIconSource } from "./source.ts";

const ICON_SIZE = 128;
const COMMAND_TIMEOUT = "5 seconds";

const commandOutput = Effect.fn("NativeAppIconResolver.commandOutput")(function* (
  command: string,
  args: ReadonlyArray<string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore" }))
    .pipe(Effect.timeout(COMMAND_TIMEOUT));
});

const plistValue = Effect.fn("NativeAppIconResolver.plistValue")(function* (
  infoPlistPath: string,
  key: string,
) {
  return yield* commandOutput("/usr/bin/plutil", [
    "-extract",
    key,
    "raw",
    "-o",
    "-",
    infoPlistPath,
  ]).pipe(
    Effect.map((value) => value.trim()),
    Effect.orElseSucceed(() => ""),
  );
});

function escapeSpotlightString(value: string): string {
  return value.replace(/([\\'*?])/gu, "\\$1");
}

const resolveApplicationPath = Effect.fn("NativeAppIconResolver.resolveApplicationPath")(function* (
  app: NativeAppIconReference,
) {
  const path = yield* Path.Path;
  if (app._tag === "app-path") {
    const appPath = expandHomePath(app.path, yield* HostProcess.HomeDirectory);
    return path.isAbsolute(appPath) && appPath.endsWith(".app") ? appPath : null;
  }
  const query =
    app._tag === "app-id"
      ? `kMDItemCFBundleIdentifier == '${app.appId}'`
      : `kMDItemContentType == 'com.apple.application-bundle' && kMDItemDisplayName == '${escapeSpotlightString(app.displayName)}'`;
  const spotlightOutput = yield* commandOutput("/usr/bin/mdfind", [query]);
  const candidates = spotlightOutput
    .split(/\r?\n/u)
    .map((value) => value.trim())
    .filter((value) => value.endsWith(".app"));
  const matchingCandidates =
    app._tag === "app-id"
      ? candidates
      : candidates.filter(
          (value) =>
            path.basename(value, ".app").toLocaleLowerCase() ===
            app.displayName.toLocaleLowerCase(),
        );
  const rankedCandidates = matchingCandidates.length > 0 ? matchingCandidates : candidates;
  let mostRecentlyUsed: { readonly path: string; readonly lastUsed: string } | null = null;
  for (const candidate of rankedCandidates) {
    const lastUsed = yield* commandOutput("/usr/bin/mdls", [
      "-raw",
      "-name",
      "kMDItemLastUsedDate",
      candidate,
    ]).pipe(
      Effect.map((value) => value.trim()),
      Effect.orElseSucceed(() => ""),
    );
    if (!mostRecentlyUsed || lastUsed > mostRecentlyUsed.lastUsed) {
      mostRecentlyUsed = { path: candidate, lastUsed };
    }
  }
  return mostRecentlyUsed?.path ?? null;
});

const resolveIcon = Effect.fn("NativeAppIconResolver.darwin.resolve")(function* (
  app: NativeAppIconReference,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const config = yield* ServerConfig.ServerConfig;
  const appPath = yield* resolveApplicationPath(app);
  if (!appPath) return null;

  const canonicalAppPath = yield* fileSystem.realPath(appPath);
  const infoPlistPath = path.join(canonicalAppPath, "Contents", "Info.plist");
  const resourcesDirectory = path.join(canonicalAppPath, "Contents", "Resources");
  const iconName =
    (yield* plistValue(infoPlistPath, "CFBundleIconFile")) ||
    (yield* plistValue(infoPlistPath, "CFBundleIconName"));
  if (iconName && path.basename(iconName) !== iconName) return null;
  const iconFileName = iconName ? (path.extname(iconName) ? iconName : `${iconName}.icns`) : null;
  const resourceEntries = yield* fileSystem
    .readDirectory(resourcesDirectory)
    .pipe(Effect.orElseSucceed(() => []));
  const sourceIconCandidate =
    (iconFileName ? yield* existingFile(path.join(resourcesDirectory, iconFileName)) : null) ??
    (yield* existingFile(path.join(resourcesDirectory, "AppIcon.icns"))) ??
    (resourceEntries.find((entry) => entry.toLowerCase().endsWith(".icns"))
      ? yield* existingFile(
          path.join(
            resourcesDirectory,
            resourceEntries.find((entry) => entry.toLowerCase().endsWith(".icns"))!,
          ),
        )
      : null);
  if (!sourceIconCandidate) return null;
  const sourceIconPath = yield* fileSystem.realPath(sourceIconCandidate);
  const relativeSource = path.relative(resourcesDirectory, sourceIconPath);
  if (
    relativeSource === ".." ||
    relativeSource.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relativeSource)
  ) {
    return null;
  }

  const appVersion =
    (yield* plistValue(infoPlistPath, "CFBundleVersion")) ||
    (yield* plistValue(infoPlistPath, "CFBundleShortVersionString"));
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const cacheKey = yield* digest
    .digest(
      Digest.sha256,
      new TextEncoder().encode(`${canonicalAppPath}\0${appVersion}\0${sourceIconPath}`),
    )
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  const cacheDirectory = path.join(config.providerStatusCacheDir, "native-app-icons");
  const cachePath = path.join(cacheDirectory, `${cacheKey}-${ICON_SIZE}.png`);
  if (yield* existingFile(cachePath)) return cachePath;

  yield* fileSystem.makeDirectory(cacheDirectory, { recursive: true });
  const temporaryPath = path.join(
    cacheDirectory,
    `.${cacheKey}-${process.pid}-${(yield* Clock.currentTimeMillis).toString(36)}-${yield* random.uuidV4()}.png`,
  );
  yield* commandOutput("/usr/bin/sips", [
    "-z",
    String(ICON_SIZE),
    String(ICON_SIZE),
    "-s",
    "format",
    "png",
    sourceIconPath,
    "--out",
    temporaryPath,
  ]).pipe(
    Effect.tap(() => fileSystem.rename(temporaryPath, cachePath)),
    Effect.ensuring(
      fileSystem.remove(temporaryPath).pipe(Effect.catchTags({ PlatformError: () => Effect.void })),
    ),
  );
  return yield* existingFile(cachePath);
});

/**
 * Spotlight finds the bundle for a bundle id or display name; the bundle's
 * `.icns` is rendered to a cached PNG with `sips`. Every path stays on the
 * server, so a display name cannot be used to walk the filesystem.
 */
export const darwinSource: NativeAppIconSource = {
  platform: "darwin",
  resolve: resolveIcon,
};

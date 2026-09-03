import * as NodeCrypto from "node:crypto";
import type { ToolActivityNativeAppReference } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import * as ServerConfig from "../config.ts";

const ICON_SIZE = 64;
const COMMAND_TIMEOUT = "5 seconds";
const RESOLUTION_CACHE_TTL = Duration.hours(1);
const RESOLUTION_CACHE_MAX_ENTRIES = 256;

/** Resolves and caches macOS application icons without exposing host paths to clients. */
export class NativeAppIconResolver extends Context.Service<
  NativeAppIconResolver,
  {
    /** Returns a cached PNG path for the application, or `null` when no icon is available. */
    readonly resolve: (app: ToolActivityNativeAppReference) => Effect.Effect<string | null>;
  }
>()("t3/assets/NativeAppIconResolver") {}

function appCacheKey(app: ToolActivityNativeAppReference): string {
  return JSON.stringify(app);
}

function appFromCacheKey(key: string): ToolActivityNativeAppReference {
  return JSON.parse(key) as ToolActivityNativeAppReference;
}

const existingFile = Effect.fn("NativeAppIconResolver.existingFile")(function* (filePath: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const info = yield* fileSystem.stat(filePath).pipe(
    Effect.map(Option.some),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound" ? Effect.succeed(Option.none()) : Effect.fail(error),
    }),
  );
  return Option.isSome(info) && info.value.type === "File" ? filePath : null;
});

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

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

const resolveApplicationPath = Effect.fn("NativeAppIconResolver.resolveApplicationPath")(function* (
  app: ToolActivityNativeAppReference,
) {
  const path = yield* Path.Path;
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

const resolveNativeAppIconUncached = Effect.fn("NativeAppIconResolver.resolveUncached")(function* (
  app: ToolActivityNativeAppReference,
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
  const cacheKey = NodeCrypto.createHash("sha256")
    .update(`${canonicalAppPath}\0${appVersion}\0${sourceIconPath}`)
    .digest("hex");
  const cacheDirectory = path.join(config.providerStatusCacheDir, "native-app-icons");
  const cachePath = path.join(cacheDirectory, `${cacheKey}.png`);
  if (yield* existingFile(cachePath)) return cachePath;

  yield* fileSystem.makeDirectory(cacheDirectory, { recursive: true });
  const temporaryPath = path.join(
    cacheDirectory,
    `.${cacheKey}-${process.pid}-${(yield* Clock.currentTimeMillis).toString(36)}-${NodeCrypto.randomUUID()}.png`,
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

export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  const resolutionSemaphore = yield* Semaphore.make(2);
  const resolutionCache: Cache.Cache<
    string,
    string | null,
    PlatformError.PlatformError | Cause.TimeoutError
  > = yield* Cache.makeWith(
    (key: string) =>
      resolutionSemaphore.withPermits(1)(resolveNativeAppIconUncached(appFromCacheKey(key))),
    {
      capacity: RESOLUTION_CACHE_MAX_ENTRIES,
      timeToLive: Exit.match({
        onSuccess: () => RESOLUTION_CACHE_TTL,
        onFailure: () => Duration.zero,
      }),
    },
  );

  const cachedFileExists = (filePath: string) =>
    fileSystem.stat(filePath).pipe(
      Effect.map((info) => info.type === "File"),
      Effect.catchTags({
        PlatformError: (error) =>
          error.reason._tag === "NotFound" ? Effect.succeed(false) : Effect.fail(error),
      }),
    );

  const resolveAttempt = Effect.fn("NativeAppIconResolver.resolve")(function* (
    app: ToolActivityNativeAppReference,
  ) {
    if (
      hostPlatform !== "darwin" ||
      (app._tag === "display-name" && containsControlCharacter(app.displayName))
    ) {
      return null;
    }

    const key = appCacheKey(app);
    const cached = yield* Cache.get(resolutionCache, key);
    if (cached === null) return null;
    if (yield* cachedFileExists(cached)) return cached;

    yield* Cache.invalidate(resolutionCache, key);
    return yield* Cache.get(resolutionCache, key);
  });

  const resolve: NativeAppIconResolver["Service"]["resolve"] = (app) =>
    resolveAttempt(app).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("Failed to resolve native application icon.", { app, cause }),
      ),
      Effect.orElseSucceed(() => null),
    );

  return NativeAppIconResolver.of({ resolve });
});

export const layer = Layer.effect(NativeAppIconResolver, make);

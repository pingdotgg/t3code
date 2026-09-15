import * as NodeCrypto from "node:crypto";
import type { ToolActivityNativeAppReference } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import * as Schema from "effect/Schema";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import * as HostProcess from "./hostProcess.ts";

import { windowsApplicationScript, windowsIconScript } from "./windowsNativeApp.ts";

const COMMAND_TIMEOUT = "5 seconds";
// Cached PNGs outlive the process. Bump when rendering changes so stale files are not served.
const ICON_CACHE_FORMAT = "1";
const RESOLUTION_CACHE_TTL = Duration.hours(1);
const RESOLUTION_CACHE_MAX_ENTRIES = 256;

export type NativeAppReference =
  | ToolActivityNativeAppReference
  | {
      readonly _tag: "path";
      readonly path: string;
    };

function appCacheKey(app: NativeAppReference): string {
  return JSON.stringify(app);
}

function appFromCacheKey(key: string): NativeAppReference {
  return JSON.parse(key) as NativeAppReference;
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
  env?: Record<string, string>,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  return yield* spawner
    .string(
      ChildProcess.make(command, args, { stdin: "ignore", stderr: "ignore", env, extendEnv: true }),
    )
    .pipe(Effect.timeout(COMMAND_TIMEOUT));
});

const windowsCommand = (script: string, input: unknown) =>
  commandOutput(
    `${process.env.SYSTEMROOT || process.env.windir || "C:\\Windows"}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`,
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-STA",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { T3_NATIVE_APP_INPUT: JSON.stringify(input) },
  );

// NSWorkspace can resolve running development apps that Spotlight has not indexed,
// and renders icons stored in asset catalogs as well as standalone .icns files.
const applicationScript = `
ObjC.import('AppKit');
function run(argv) {
  var app = JSON.parse(argv[0]);
  var workspace = $.NSWorkspace.sharedWorkspace;
  var running = workspace.runningApplications;
  var url;
  for (var i = 0; i < running.count; i++) {
    var candidate = running.objectAtIndex(i);
    var matches = app._tag === 'app-id'
      ? ObjC.unwrap(candidate.bundleIdentifier) === app.appId
      : ObjC.unwrap(candidate.localizedName) === app.displayName;
    if (matches && candidate.bundleURL && !candidate.bundleURL.isNil()) {
      url = candidate.bundleURL;
      break;
    }
  }
  if (app._tag === 'path') url = $.NSURL.fileURLWithPath(app.path);
  if (!url) {
    if (app._tag === 'app-id') {
      url = workspace.URLForApplicationWithBundleIdentifier(app.appId);
    } else {
      var appPath = workspace.fullPathForApplication(app.displayName);
      if (appPath && !appPath.isNil()) url = $.NSURL.fileURLWithPath(appPath);
    }
  }
  if (!url || url.isNil()) return 'null';
  var bundle = $.NSBundle.bundleWithURL(url);
  if (!bundle || bundle.isNil()) return 'null';
  var name = bundle.objectForInfoDictionaryKey('CFBundleDisplayName');
  if (!name || name.isNil()) name = bundle.objectForInfoDictionaryKey('CFBundleName');
  if (!name || name.isNil()) name = url.lastPathComponent.stringByDeletingPathExtension;
  var version = bundle.objectForInfoDictionaryKey('CFBundleVersion');
  if (!version || version.isNil()) version = bundle.objectForInfoDictionaryKey('CFBundleShortVersionString');
  return JSON.stringify({
    path: ObjC.unwrap(url.path),
    displayName: ObjC.unwrap(name),
    version: version && !version.isNil() ? ObjC.unwrap(version) : ''
  });
}
`;

const iconScript = (size: number) => `
ObjC.import('AppKit');
function run(argv) {
  var icon = $.NSWorkspace.sharedWorkspace.iconForFile(argv[0]);
  icon.size = $.NSMakeSize(${size}, ${size});
  var bitmap = $.NSBitmapImageRep.alloc.initWithBitmapDataPlanesPixelsWidePixelsHighBitsPerSampleSamplesPerPixelHasAlphaIsPlanarColorSpaceNameBytesPerRowBitsPerPixel(
    null, ${size}, ${size}, 8, 4, true, false, $.NSDeviceRGBColorSpace, 0, 0
  );
  $.NSGraphicsContext.saveGraphicsState;
  $.NSGraphicsContext.setCurrentContext($.NSGraphicsContext.graphicsContextWithBitmapImageRep(bitmap));
  icon.drawInRectFromRectOperationFraction(
    $.NSMakeRect(0, 0, ${size}, ${size}), $.NSZeroRect, $.NSCompositingOperationCopy, 1
  );
  $.NSGraphicsContext.restoreGraphicsState;
  var png = bitmap.representationUsingTypeProperties($.NSBitmapImageFileTypePNG, $({}));
  if (!png.writeToFileAtomically(argv[1], true)) throw new Error('Could not write application icon');
}
`;

const decodeApplication = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.NullOr(
      Schema.Struct({
        path: Schema.String,
        displayName: Schema.String,
        version: Schema.String,
      }),
    ),
  ),
);

/** Each adapter caches names; asset requests cache the same lookup independently. */
export const makeApplicationResolver = Effect.fn("NativeAppIconResolver.makeApplicationResolver")(
  function* () {
    const platform = yield* HostProcess.HostProcessPlatform;
    const semaphore = yield* Semaphore.make(2);
    const cache = yield* Cache.makeWith(
      (key: string) =>
        semaphore.withPermits(1)(
          (platform === "win32"
            ? windowsCommand(windowsApplicationScript, appFromCacheKey(key))
            : commandOutput("/usr/bin/osascript", [
                "-l",
                "JavaScript",
                "-e",
                applicationScript,
                key,
              ])
          ).pipe(Effect.map((output) => Option.getOrNull(decodeApplication(output)))),
        ),
      {
        capacity: RESOLUTION_CACHE_MAX_ENTRIES,
        timeToLive: Exit.match({
          onSuccess: (value) => (value === null ? Duration.minutes(1) : RESOLUTION_CACHE_TTL),
          onFailure: () => Duration.minutes(1),
        }),
      },
    );
    return (app: NativeAppReference) =>
      platform !== "darwin" && platform !== "win32"
        ? Effect.succeed(null)
        : Cache.get(cache, appCacheKey(app)).pipe(Effect.orElseSucceed(() => null));
  },
);

export const makeNativeAppIconResolver = Effect.fn("NativeAppIconResolver.make")(function* (
  cacheDirectory: string,
  size = 64,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resolveApplication = yield* makeApplicationResolver();
  const hostPlatform = yield* HostProcess.HostProcessPlatform;
  const resolutionSemaphore = yield* Semaphore.make(2);
  const resolutionCache: Cache.Cache<
    string,
    string | null,
    PlatformError.PlatformError | Cause.TimeoutError
  > = yield* Cache.makeWith(
    (key: string) =>
      resolutionSemaphore.withPermits(1)(
        Effect.gen(function* () {
          const reference = appFromCacheKey(key);
          const application =
            reference._tag === "path"
              ? {
                  path: reference.path,
                  version:
                    Option.getOrUndefined(
                      (yield* fileSystem.stat(reference.path)).mtime,
                    )?.toISOString() ?? "",
                }
              : yield* resolveApplication(reference);
          if (!application) return null;
          const cacheKey = NodeCrypto.createHash("sha256")
            .update(`${ICON_CACHE_FORMAT}\0${application.path}\0${application.version}\0${size}`)
            .digest("hex");
          const cachePath = path.join(cacheDirectory, `${cacheKey}.png`);
          if (yield* existingFile(cachePath)) return cachePath;
          yield* fileSystem.makeDirectory(cacheDirectory, { recursive: true });
          const temporaryPath = path.join(
            cacheDirectory,
            `.${cacheKey}-${NodeCrypto.randomUUID()}.png`,
          );
          yield* (
            hostPlatform === "win32"
              ? windowsCommand(windowsIconScript, {
                  path: application.path,
                  outputPath: temporaryPath,
                  size,
                })
              : commandOutput("/usr/bin/osascript", [
                  "-l",
                  "JavaScript",
                  "-e",
                  iconScript(size),
                  application.path,
                  temporaryPath,
                ])
          ).pipe(
            Effect.tap(() => fileSystem.rename(temporaryPath, cachePath)),
            Effect.ensuring(
              fileSystem
                .remove(temporaryPath)
                .pipe(Effect.catchTags({ PlatformError: () => Effect.void })),
            ),
          );
          return yield* existingFile(cachePath);
        }),
      ),
    {
      capacity: RESOLUTION_CACHE_MAX_ENTRIES,
      timeToLive: Exit.match({
        onSuccess: (value) => (value === null ? Duration.minutes(1) : RESOLUTION_CACHE_TTL),
        onFailure: () => Duration.minutes(1),
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
    app: NativeAppReference,
  ) {
    if (hostPlatform !== "darwin" && hostPlatform !== "win32") {
      return null;
    }

    const key = appCacheKey(app);
    const cached = yield* Cache.get(resolutionCache, key);
    if (cached === null) return null;
    if (yield* cachedFileExists(cached)) return cached;

    yield* Cache.invalidate(resolutionCache, key);
    return yield* Cache.get(resolutionCache, key);
  });

  const resolve = (app: NativeAppReference) =>
    resolveAttempt(app).pipe(
      Effect.tapError((cause) =>
        Effect.logDebug("Failed to resolve native application icon.", { app, cause }),
      ),
      Effect.orElseSucceed(() => null),
    );

  return { resolve };
});

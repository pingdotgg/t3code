import type { ToolActivityNativeAppReference } from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import type * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import * as Semaphore from "effect/Semaphore";
import { HostProcessPlatform } from "@t3tools/shared/hostProcess";

import { darwinSource } from "./nativeAppIcons/darwin.ts";
import { linuxSource } from "./nativeAppIcons/linux.ts";
import type { NativeAppIconSource } from "./nativeAppIcons/source.ts";

const RESOLUTION_CACHE_TTL = Duration.hours(1);
const RESOLUTION_CACHE_MAX_ENTRIES = 256;

/** One source per platform; a platform without one resolves nothing. */
const SOURCES: ReadonlyArray<NativeAppIconSource> = [darwinSource, linuxSource];

/** Resolves and caches host application icons without exposing host paths to clients. */
export class NativeAppIconResolver extends Context.Service<
  NativeAppIconResolver,
  {
    /** Returns a cached image path for the application, or `null` when no icon is available. */
    readonly resolve: (app: ToolActivityNativeAppReference) => Effect.Effect<string | null>;
  }
>()("t3/assets/NativeAppIconResolver") {}

function appCacheKey(app: ToolActivityNativeAppReference): string {
  return JSON.stringify(app);
}

function appFromCacheKey(key: string): ToolActivityNativeAppReference {
  return JSON.parse(key) as ToolActivityNativeAppReference;
}

function containsControlCharacter(value: string): boolean {
  return [...value].some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 31 || codePoint === 127;
  });
}

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const hostPlatform = yield* HostProcessPlatform;
  const source = SOURCES.find((candidate) => candidate.platform === hostPlatform);
  const resolutionSemaphore = yield* Semaphore.make(2);
  const resolutionCache: Cache.Cache<
    string,
    string | null,
    PlatformError.PlatformError | Cause.TimeoutError
  > = yield* Cache.makeWith(
    (key: string) =>
      source
        ? resolutionSemaphore.withPermits(1)(source.resolve(appFromCacheKey(key)))
        : Effect.succeed(null),
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
    if (!source || (app._tag === "display-name" && containsControlCharacter(app.displayName))) {
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

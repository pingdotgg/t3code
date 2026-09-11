import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { safariAccessGranted } from "./SafariCookies.ts";
import {
  BROWSER_IMPORT_SOURCES,
  resolveCookieDatabase,
  listSourceProfiles,
  sourcePathContext,
} from "./Sources.ts";

export const safariPermissionCheck = Effect.gen(function* () {
  const context = yield* sourcePathContext;
  const services = yield* Effect.context<FileSystem.FileSystem>();
  const runPromise = Effect.runPromiseWith(services);
  const safari = BROWSER_IMPORT_SOURCES.find((source) => source.engine === "safari");
  const check = Effect.gen(function* () {
    if (!safari || context.platform !== "darwin") return false;
    const defaultJar = yield* resolveCookieDatabase(safari, context, ".");
    if (defaultJar !== undefined) return yield* safariAccessGranted(defaultJar);
    // A Safari installation can have cookies only in a named profile. Rediscover
    // those stores after a grant, since TCC may have hidden their metadata before.
    const profiles = yield* listSourceProfiles(safari, context);
    for (const profile of profiles) {
      const jar = yield* resolveCookieDatabase(safari, context, profile.directory);
      if (jar !== undefined && (yield* safariAccessGranted(jar))) return true;
    }
    return false;
  });
  // Open and close the jar without reading cookies or attempting an import.
  return () => runPromise(check);
});

import * as Effect from "effect/Effect";

import type {
  AnyInstallationDefinition,
  InstallationCatalog,
  InstallationContext,
  ResolvedInstallation,
} from "./definition.ts";

function resolveFirst(
  context: InstallationContext,
  definitions: ReadonlyArray<AnyInstallationDefinition>,
) {
  return Effect.gen(function* () {
    const reasons: Array<string> = [];
    for (const definition of definitions) {
      const result = yield* definition.detectAndResolve(context);
      if (result._tag === "Matched") return result;
      if (result._tag === "Undetermined") reasons.push(`${definition.id}: ${result.reason}`);
    }
    return reasons.length > 0
      ? ({ _tag: "Undetermined", reasons } as const)
      : ({ _tag: "NotMatched" } as const);
  });
}

export const resolveInstallation = Effect.fn("resolveInstallation")(function* (
  context: InstallationContext,
  catalog: InstallationCatalog,
) {
  const textFiles = new Map<string, string | null>();
  const cachedContext: InstallationContext = {
    ...context,
    readTextFile: Effect.fn("readCachedInstallationTextFile")(function* (path, maxBytes) {
      const cacheKey = `${path}\0${maxBytes ?? "unbounded"}`;
      if (textFiles.has(cacheKey)) return textFiles.get(cacheKey) ?? null;
      const value = yield* context.readTextFile(path, maxBytes);
      textFiles.set(cacheKey, value);
      return value;
    }),
  };
  const owned = yield* resolveFirst(cachedContext, catalog.installations);
  if (owned._tag === "Matched") return owned.installation;
  return manualInstallation(context, owned._tag === "Undetermined");
});

function manualInstallation(context: InstallationContext, failed: boolean): ResolvedInstallation {
  return {
    identityKey: "manual",
    lockKey: `manual:${context.provider}`,
    label: failed ? "Unknown installation — verification failed" : "Unknown installation",
    ownershipVerified: false,
    packageName: context.packageName,
    currentVersion: null,
    latestVersion: null,
    update: null,
    instructionsUrl: null,
  };
}

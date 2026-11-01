import {
  type ProviderInstanceId,
  type ServerProvider,
  ServerProvider as ServerProviderSchema,
} from "@t3tools/contracts";
import { causeErrorTag } from "@t3tools/shared/observability";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { writeFileStringAtomically } from "@t3tools/shared/atomicWrite";

const decodeProviderStatusCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerProviderSchema),
);

const mergeProviderModels = (
  fallbackModels: ReadonlyArray<ServerProvider["models"][number]>,
  cachedModels: ReadonlyArray<ServerProvider["models"][number]>,
): ReadonlyArray<ServerProvider["models"][number]> => {
  const fallbackSlugs = new Set(fallbackModels.map((model) => model.slug));
  // Settings already supply current custom models; cached rows could resurrect removed ones.
  return [
    ...fallbackModels,
    ...cachedModels.filter((model) => !model.isCustom && !fallbackSlugs.has(model.slug)),
  ];
};

const BUILT_IN_DRIVER_ORDER: ReadonlyArray<string> = [
  "codex",
  "claudeAgent",
  "cursor",
  "grok",
  "opencode",
  "antigravity",
  "fx",
];

const driverRank = (driver: string): number => {
  const index = BUILT_IN_DRIVER_ORDER.indexOf(driver);
  return index === -1 ? BUILT_IN_DRIVER_ORDER.length : index;
};

export const orderProviderSnapshots = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> =>
  [...providers].toSorted(
    (left, right) =>
      driverRank(left.driver) - driverRank(right.driver) ||
      left.driver.localeCompare(right.driver) ||
      (left.displayName ?? "").localeCompare(right.displayName ?? "") ||
      left.instanceId.localeCompare(right.instanceId),
  );

export const isCachedProviderCorrelated = (input: {
  readonly cachedProvider: ServerProvider;
  readonly fallbackProvider: ServerProvider;
}): boolean =>
  input.cachedProvider.instanceId === input.fallbackProvider.instanceId &&
  input.cachedProvider.driver === input.fallbackProvider.driver;

export const hydrateCachedProvider = (input: {
  readonly cachedProvider: ServerProvider;
  readonly fallbackProvider: ServerProvider;
}): ServerProvider => {
  if (!isCachedProviderCorrelated(input)) {
    return input.fallbackProvider;
  }

  if (
    !input.fallbackProvider.enabled ||
    input.cachedProvider.enabled !== input.fallbackProvider.enabled
  ) {
    return input.fallbackProvider;
  }

  const { message: _fallbackMessage, ...fallbackWithoutMessage } = input.fallbackProvider;
  const hydratedProvider: ServerProvider = {
    ...fallbackWithoutMessage,
    models: mergeProviderModels(input.fallbackProvider.models, input.cachedProvider.models),
    installed: input.cachedProvider.installed,
    version: input.cachedProvider.version,
    status: input.cachedProvider.status,
    auth: input.cachedProvider.auth,
    checkedAt: input.cachedProvider.checkedAt,
    slashCommands: input.cachedProvider.slashCommands,
    skills: input.cachedProvider.skills,
  };

  return input.cachedProvider.message
    ? { ...hydratedProvider, message: input.cachedProvider.message }
    : hydratedProvider;
};

/** Require matching instanceId and driver before hydration; filenames alone cannot authorize routing. */
export const resolveProviderStatusCachePath = Effect.fn("resolveProviderStatusCachePath")(
  function* (input: {
    readonly cacheDir: string;
    readonly instanceId: ProviderInstanceId;
  }): Effect.fn.Return<string, never, Path.Path> {
    const path = yield* Path.Path;
    return path.join(input.cacheDir, `${input.instanceId}.json`);
  },
);

export const readProviderStatusCache = Effect.fn("providerStatusCache.readProviderStatusCache")(
  function* (filePath: string) {
    const fs = yield* FileSystem.FileSystem;
    const exists = yield* fs.exists(filePath).pipe(Effect.orElseSucceed(() => false));
    if (!exists) {
      return undefined;
    }

    const raw = yield* fs.readFileString(filePath).pipe(Effect.orElseSucceed(() => ""));
    const trimmed = raw.trim();
    if (trimmed.length === 0) {
      return undefined;
    }

    return yield* decodeProviderStatusCache(trimmed).pipe(
      Effect.matchCauseEffect({
        onFailure: (cause) =>
          Effect.logWarning("failed to parse provider status cache, ignoring", {
            path: filePath,
            errorTag: causeErrorTag(cause),
          }).pipe(Effect.as(undefined)),
        onSuccess: Effect.succeed,
      }),
    );
  },
);

export const writeProviderStatusCache = (input: {
  readonly filePath: string;
  readonly provider: ServerProvider;
}) => {
  const { updateState: _updateState, ...cacheableProvider } = input.provider;
  return writeFileStringAtomically({
    filePath: input.filePath,
    contents: `${JSON.stringify(cacheableProvider, null, 2)}\n`,
  });
};

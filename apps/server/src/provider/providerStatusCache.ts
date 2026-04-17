import * as nodePath from "node:path";
import { type ServerProvider, ServerProvider as ServerProviderSchema } from "@t3tools/contracts";
import { Cause, Effect, FileSystem, Path, Schema } from "effect";

export const PROVIDER_CACHE_IDS = [
  "codex",
  "claudeAgent",
  "opencode",
] as const satisfies ReadonlyArray<ServerProvider["provider"]>;

const decodeProviderStatusCache = Schema.decodeUnknownEffect(
  Schema.fromJsonString(ServerProviderSchema),
);

const providerOrderRank = (provider: ServerProvider["provider"]): number => {
  const rank = PROVIDER_CACHE_IDS.indexOf(provider);
  return rank === -1 ? Number.MAX_SAFE_INTEGER : rank;
};

export const orderProviderSnapshots = (
  providers: ReadonlyArray<ServerProvider>,
): ReadonlyArray<ServerProvider> =>
  [...providers].toSorted(
    (left, right) => providerOrderRank(left.provider) - providerOrderRank(right.provider),
  );

export const hydrateCachedProvider = (input: {
  readonly cachedProvider: ServerProvider;
  readonly fallbackProvider: ServerProvider;
}): ServerProvider => {
  if (
    !input.fallbackProvider.enabled ||
    input.cachedProvider.enabled !== input.fallbackProvider.enabled
  ) {
    return input.fallbackProvider;
  }

  const { message: _fallbackMessage, ...fallbackWithoutMessage } = input.fallbackProvider;
  const hydratedProvider: ServerProvider = {
    ...fallbackWithoutMessage,
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

export const resolveProviderStatusCachePath = (input: {
  readonly cacheDir: string;
  readonly provider: ServerProvider["provider"];
}) => nodePath.join(input.cacheDir, `${input.provider}.json`);

export const readProviderStatusCache = (filePath: string) =>
  Effect.gen(function* () {
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
            issues: Cause.pretty(cause),
          }).pipe(Effect.as(undefined)),
        onSuccess: Effect.succeed,
      }),
    );
  });

export const writeProviderStatusCache = (input: {
  readonly filePath: string;
  readonly provider: ServerProvider;
}) => {
  const tempPath = `${input.filePath}.${process.pid}.${Date.now()}.tmp`;
  return Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const encoded = `${JSON.stringify(input.provider, null, 2)}\n`;

    yield* fs.makeDirectory(path.dirname(input.filePath), { recursive: true });
    yield* fs.writeFileString(tempPath, encoded);
    yield* fs.rename(tempPath, input.filePath);
  }).pipe(
    Effect.ensuring(
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.remove(tempPath, { force: true }).pipe(Effect.ignore({ log: true }));
      }),
    ),
  );
};

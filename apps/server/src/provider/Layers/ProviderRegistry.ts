/**
 * ProviderRegistryLive - Aggregates provider-specific snapshot services.
 *
 * @module ProviderRegistryLive
 */
import type { ProviderKind, ServerProvider } from "@t3tools/contracts";
import { Effect, Equal, FileSystem, Layer, Path, PubSub, Ref, Stream } from "effect";

import { ServerConfig } from "../../config.ts";
import { ClaudeProviderLive } from "./ClaudeProvider.ts";
import { CodexProviderLive } from "./CodexProvider.ts";
import { OpenCodeProviderLive } from "./OpenCodeProvider.ts";
import type { ClaudeProviderShape } from "../Services/ClaudeProvider.ts";
import { ClaudeProvider } from "../Services/ClaudeProvider.ts";
import type { CodexProviderShape } from "../Services/CodexProvider.ts";
import { CodexProvider } from "../Services/CodexProvider.ts";
import type { OpenCodeProviderShape } from "../Services/OpenCodeProvider.ts";
import { OpenCodeProvider } from "../Services/OpenCodeProvider.ts";
import { ProviderRegistry, type ProviderRegistryShape } from "../Services/ProviderRegistry.ts";
import {
  hydrateCachedProvider,
  PROVIDER_CACHE_IDS,
  orderProviderSnapshots,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache.ts";

const loadProviders = (
  codexProvider: CodexProviderShape,
  claudeProvider: ClaudeProviderShape,
  openCodeProvider: OpenCodeProviderShape,
): Effect.Effect<readonly [ServerProvider, ServerProvider, ServerProvider]> =>
  Effect.all(
    [codexProvider.getSnapshot, claudeProvider.getSnapshot, openCodeProvider.getSnapshot],
    {
      concurrency: "unbounded",
    },
  );

export const haveProvidersChanged = (
  previousProviders: ReadonlyArray<ServerProvider>,
  nextProviders: ReadonlyArray<ServerProvider>,
): boolean => !Equal.equals(previousProviders, nextProviders);

export const ProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const codexProvider = yield* CodexProvider;
    const claudeProvider = yield* ClaudeProvider;
    const openCodeProvider = yield* OpenCodeProvider;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );
    const fallbackProviders = yield* loadProviders(codexProvider, claudeProvider, openCodeProvider);
    const cachePathByProvider = new Map(
      PROVIDER_CACHE_IDS.map(
        (provider) =>
          [
            provider,
            resolveProviderStatusCachePath({
              cacheDir: config.providerStatusCacheDir,
              provider,
            }),
          ] as const,
      ),
    );
    const fallbackByProvider = new Map(
      fallbackProviders.map((provider) => [provider.provider, provider] as const),
    );
    const cachedProviders = yield* Effect.forEach(
      PROVIDER_CACHE_IDS,
      (provider) => {
        const filePath = cachePathByProvider.get(provider)!;
        const fallbackProvider = fallbackByProvider.get(provider)!;
        return readProviderStatusCache(filePath).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.map((cachedProvider) =>
            cachedProvider === undefined
              ? undefined
              : hydrateCachedProvider({
                  cachedProvider,
                  fallbackProvider,
                }),
          ),
        );
      },
      { concurrency: "unbounded" },
    ).pipe(
      Effect.map((providers) =>
        orderProviderSnapshots(
          providers.filter((provider): provider is ServerProvider => provider !== undefined),
        ),
      ),
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(cachedProviders);

    const persistProvider = (provider: ServerProvider) =>
      writeProviderStatusCache({
        filePath: cachePathByProvider.get(provider.provider)!,
        provider,
      }).pipe(
        Effect.provideService(FileSystem.FileSystem, fileSystem),
        Effect.provideService(Path.Path, path),
        Effect.tapError(Effect.logError),
        Effect.ignore,
      );

    const upsertProviders = Effect.fn("upsertProviders")(function* (
      nextProviders: ReadonlyArray<ServerProvider>,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      const [previousProviders, providers] = yield* Ref.modify(
        providersRef,
        (previousProviders) => {
          const mergedProviders = new Map(
            previousProviders.map((provider) => [provider.provider, provider] as const),
          );

          for (const provider of nextProviders) {
            mergedProviders.set(provider.provider, provider);
          }

          const providers = orderProviderSnapshots([...mergedProviders.values()]);
          return [[previousProviders, providers] as const, providers];
        },
      );

      if (haveProvidersChanged(previousProviders, providers)) {
        yield* Effect.forEach(nextProviders, persistProvider, {
          concurrency: "unbounded",
          discard: true,
        });
        if (options?.publish !== false) {
          yield* PubSub.publish(changesPubSub, providers);
        }
      }

      return providers;
    });

    const syncProvider = Effect.fn("syncProvider")(function* (
      provider: ServerProvider,
      options?: {
        readonly publish?: boolean;
      },
    ) {
      return yield* upsertProviders([provider], options);
    });

    const refresh = Effect.fn("refresh")(function* (provider?: ProviderKind) {
      switch (provider) {
        case "codex":
          return yield* codexProvider.refresh.pipe(
            Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
          );
        case "claudeAgent":
          return yield* claudeProvider.refresh.pipe(
            Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
          );
        case "opencode":
          return yield* openCodeProvider.refresh.pipe(
            Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
          );
        default:
          return yield* Effect.all(
            [
              codexProvider.refresh.pipe(
                Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
              ),
              claudeProvider.refresh.pipe(
                Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
              ),
              openCodeProvider.refresh.pipe(
                Effect.flatMap((nextProvider) => syncProvider(nextProvider)),
              ),
            ],
            {
              concurrency: "unbounded",
              discard: true,
            },
          ).pipe(Effect.andThen(Ref.get(providersRef)));
      }
    });

    yield* Stream.runForEach(codexProvider.streamChanges, (provider) =>
      syncProvider(provider),
    ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(claudeProvider.streamChanges, (provider) =>
      syncProvider(provider),
    ).pipe(Effect.forkScoped);
    yield* Stream.runForEach(openCodeProvider.streamChanges, (provider) =>
      syncProvider(provider),
    ).pipe(Effect.forkScoped);

    return {
      getProviders: Ref.get(providersRef),
      refresh: (provider?: ProviderKind) =>
        refresh(provider).pipe(
          Effect.tapError(Effect.logError),
          Effect.orElseSucceed(() => [] as ReadonlyArray<ServerProvider>),
        ),
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
).pipe(
  Layer.provideMerge(CodexProviderLive),
  Layer.provideMerge(ClaudeProviderLive),
  Layer.provideMerge(OpenCodeProviderLive),
);

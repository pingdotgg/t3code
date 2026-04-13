import {
  DEFAULT_MODEL_BY_PROVIDER,
  type ServerProvider,
  type ServerProviderModel,
} from "@t3tools/contracts";
import { Effect, Equal, Layer, PubSub, Ref, Stream } from "effect";

import { getClaudeModelCapabilities } from "../provider/Layers/ClaudeProvider.ts";
import { getCodexModelCapabilities } from "../provider/Layers/CodexProvider.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  ProviderRegistry,
  type ProviderRegistryShape,
} from "../provider/Services/ProviderRegistry.ts";

const makeProviderModel = (input: {
  readonly slug: string;
  readonly name: string;
  readonly capabilities: ServerProviderModel["capabilities"];
}): ServerProviderModel => ({
  slug: input.slug,
  name: input.name,
  isCustom: false,
  capabilities: input.capabilities,
});

const CODEX_MODELS: ReadonlyArray<ServerProviderModel> = [
  makeProviderModel({
    slug: DEFAULT_MODEL_BY_PROVIDER.codex,
    name: "GPT-5.4",
    capabilities: getCodexModelCapabilities(DEFAULT_MODEL_BY_PROVIDER.codex),
  }),
];

const CLAUDE_MODELS: ReadonlyArray<ServerProviderModel> = [
  makeProviderModel({
    slug: DEFAULT_MODEL_BY_PROVIDER.claudeAgent,
    name: "Claude Sonnet 4.6",
    capabilities: getClaudeModelCapabilities(DEFAULT_MODEL_BY_PROVIDER.claudeAgent),
  }),
];

const makeProviderSnapshot = (input: {
  readonly provider: ServerProvider["provider"];
  readonly enabled: boolean;
  readonly checkedAt: string;
}): ServerProvider => {
  if (input.provider === "codex") {
    return {
      provider: "codex",
      enabled: input.enabled,
      installed: true,
      version: "perf-fixture",
      status: input.enabled ? "ready" : "disabled",
      auth: input.enabled
        ? {
            status: "authenticated",
            type: "perf",
            label: "Local perf harness",
          }
        : {
            status: "unknown",
          },
      checkedAt: input.checkedAt,
      message: input.enabled ? "Perf fixture provider active." : "Disabled in T3 Code settings.",
      models: CODEX_MODELS,
    };
  }

  return {
    provider: "claudeAgent",
    enabled: input.enabled,
    installed: false,
    version: null,
    status: input.enabled ? "warning" : "disabled",
    auth: {
      status: "unknown",
    },
    checkedAt: input.checkedAt,
    message: input.enabled
      ? "Perf harness only stubs Codex runtime sessions."
      : "Disabled in T3 Code settings.",
    models: CLAUDE_MODELS,
  };
};

const loadPerfProviderSnapshots = Effect.fn("loadPerfProviderSnapshots")(function* (input: {
  readonly serverSettings: ServerSettingsService["Service"];
}) {
  const settings = yield* input.serverSettings.getSettings;
  const checkedAt = new Date().toISOString();
  return [
    makeProviderSnapshot({
      provider: "codex",
      enabled: settings.providers.codex.enabled,
      checkedAt,
    }),
    makeProviderSnapshot({
      provider: "claudeAgent",
      enabled: settings.providers.claudeAgent.enabled,
      checkedAt,
    }),
  ] as const;
});

const loadPerfProviderSnapshotsSafely = (
  serverSettings: ServerSettingsService["Service"],
  fallback: ReadonlyArray<ServerProvider>,
) =>
  loadPerfProviderSnapshots({ serverSettings }).pipe(
    Effect.tapError(Effect.logError),
    Effect.orElseSucceed(() => fallback),
  );

export const PerfProviderRegistryLive = Layer.effect(
  ProviderRegistry,
  Effect.gen(function* () {
    const serverSettings = yield* ServerSettingsService;
    const changesPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<ReadonlyArray<ServerProvider>>(),
      PubSub.shutdown,
    );
    const providersRef = yield* Ref.make<ReadonlyArray<ServerProvider>>(
      yield* loadPerfProviderSnapshotsSafely(serverSettings, [
        makeProviderSnapshot({
          provider: "codex",
          enabled: true,
          checkedAt: new Date().toISOString(),
        }),
        makeProviderSnapshot({
          provider: "claudeAgent",
          enabled: false,
          checkedAt: new Date().toISOString(),
        }),
      ]),
    );

    const refreshProviders = Effect.fn("refreshPerfProviders")(function* () {
      const previous = yield* Ref.get(providersRef);
      const next = yield* loadPerfProviderSnapshotsSafely(serverSettings, previous);
      yield* Ref.set(providersRef, next);
      if (!Equal.equals(previous, next)) {
        yield* PubSub.publish(changesPubSub, next);
      }
      return next;
    });

    yield* Stream.runForEach(serverSettings.streamChanges, () => refreshProviders()).pipe(
      Effect.forkScoped,
    );

    return {
      getProviders: Ref.get(providersRef),
      refresh: (_provider) => refreshProviders(),
      get streamChanges() {
        return Stream.fromPubSub(changesPubSub);
      },
    } satisfies ProviderRegistryShape;
  }),
);

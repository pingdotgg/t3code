/**
 * ProviderAdapterRegistryLive - In-memory provider adapter lookup layer.
 *
 * Binds provider kinds (codex/claudeAgent/...) to concrete adapter services.
 * This layer only performs adapter lookup; it does not route session-scoped
 * calls or own provider lifecycle workflows.
 *
 * @module ProviderAdapterRegistryLive
 */
import { Effect, Layer } from "effect";

import { ProviderUnsupportedError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { ClaudeAdapter } from "../Services/ClaudeAdapter.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { GrokAdapter } from "../Services/GrokAdapter.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import { createBuiltInAdapterList } from "../builtInProviderCatalog.ts";

export interface ProviderAdapterRegistryLiveOptions {
  readonly adapters?: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
}

const makeProviderAdapterRegistry = Effect.fn("makeProviderAdapterRegistry")(function* (
  options?: ProviderAdapterRegistryLiveOptions,
) {
  const cursorAdapterOption = yield* Effect.serviceOption(CursorAdapter);
  const grokAdapterOption = yield* Effect.serviceOption(GrokAdapter);
  const adapters =
    options?.adapters !== undefined
      ? options.adapters
      : createBuiltInAdapterList({
          codex: yield* CodexAdapter,
          claudeAgent: yield* ClaudeAdapter,
          ...(cursorAdapterOption._tag === "Some" ? { cursor: cursorAdapterOption.value } : {}),
          ...(grokAdapterOption._tag === "Some" ? { grok: grokAdapterOption.value } : {}),
          opencode: yield* OpenCodeAdapter,
        });
  const byProvider = new Map(adapters.map((adapter) => [adapter.provider, adapter]));

  const getByProvider: ProviderAdapterRegistryShape["getByProvider"] = (provider) => {
    const adapter = byProvider.get(provider);
    if (!adapter) {
      return Effect.fail(new ProviderUnsupportedError({ provider }));
    }
    return Effect.succeed(adapter);
  };

  const listProviders: ProviderAdapterRegistryShape["listProviders"] = () =>
    Effect.sync(() => Array.from(byProvider.keys()));

  return {
    getByProvider,
    listProviders,
  } satisfies ProviderAdapterRegistryShape;
});

export const ProviderAdapterRegistryLive = Layer.effect(
  ProviderAdapterRegistry,
  makeProviderAdapterRegistry(),
);

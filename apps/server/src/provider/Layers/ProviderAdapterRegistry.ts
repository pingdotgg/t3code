/**
 * ProviderAdapterRegistryLive - In-memory provider adapter lookup layer.
 *
 * Binds provider kinds (codex/cursor/...) to concrete adapter services.
 * This layer only performs adapter lookup; it does not route session-scoped
 * calls or own provider lifecycle workflows.
 *
 * @module ProviderAdapterRegistryLive
 */
import type { ProviderKind } from "@t3tools/contracts";
import { Effect, Layer } from "effect";

import { ProviderUnsupportedError, type ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRegistry,
  type ProviderAdapterRegistryShape,
} from "../Services/ProviderAdapterRegistry.ts";
import { ClaudeCodeAdapter } from "../Services/ClaudeCodeAdapter.ts";
import { CopilotAdapter } from "../Services/CopilotAdapter.ts";
import { CodexAdapter } from "../Services/CodexAdapter.ts";
import { CursorAdapter } from "../Services/CursorAdapter.ts";
import { GeminiCliAdapter } from "../Services/GeminiCliAdapter.ts";
import { OpenCodeAdapter } from "../Services/OpenCodeAdapter.ts";
import { AmpAdapter } from "../Services/AmpAdapter.ts";
import { KiloAdapter } from "../Services/KiloAdapter.ts";

export interface ProviderAdapterRegistryLiveOptions {
  readonly adapters?: ReadonlyArray<ProviderAdapterShape<ProviderAdapterError>>;
}

const makeProviderAdapterRegistry = (options?: ProviderAdapterRegistryLiveOptions) =>
  Effect.gen(function* () {
    const adapters =
      options?.adapters !== undefined
        ? options.adapters
        : [
            yield* CodexAdapter,
            yield* CopilotAdapter,
            yield* ClaudeCodeAdapter,
            yield* CursorAdapter,
            yield* OpenCodeAdapter,
            yield* GeminiCliAdapter,
            yield* AmpAdapter,
            yield* KiloAdapter,
          ];
    const byProvider = new Map<ProviderKind, ProviderAdapterShape<ProviderAdapterError>>();
    for (const adapter of adapters) {
      if (byProvider.has(adapter.provider)) {
        return yield* Effect.die(
          new Error(
            `Duplicate provider adapter registration for provider "${adapter.provider}"`,
          ),
        );
      }
      byProvider.set(adapter.provider, adapter);
    }

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

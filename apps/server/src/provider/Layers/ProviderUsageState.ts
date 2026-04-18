import type {
  ProviderKind,
  ProviderRuntimeEvent,
  ServerProviderUsageLimits,
} from "@t3tools/contracts";
import { Effect, Layer, Ref, Stream } from "effect";

import { runtimeUsageToProviderUsageLimits } from "../runtimeUsageToProviderUsageLimits.ts";
import {
  ProviderUsageState,
  type ProviderUsageStateShape,
} from "../Services/ProviderUsageState.ts";
import { ProviderService } from "../Services/ProviderService.ts";

function toCursorUsageLimits(
  event: Extract<ProviderRuntimeEvent, { readonly type: "thread.token-usage.updated" }>,
) {
  const maxTokens = event.payload.usage.maxTokens;
  if (typeof maxTokens !== "number") {
    return undefined;
  }

  return runtimeUsageToProviderUsageLimits({
    source: "cursorAcp",
    checkedAt: event.createdAt,
    usedTokens: event.payload.usage.usedTokens,
    maxTokens,
  });
}

export const ProviderUsageStateLive = Layer.effect(
  ProviderUsageState,
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const stateRef = yield* Ref.make(new Map<ProviderKind, ServerProviderUsageLimits>());

    const service: ProviderUsageStateShape = {
      get: (provider) => Ref.get(stateRef).pipe(Effect.map((state) => state.get(provider))),
      set: (provider, usage) =>
        Ref.update(stateRef, (state) => {
          const next = new Map(state);
          if (usage === undefined) {
            next.delete(provider);
          } else {
            next.set(provider, usage);
          }
          return next;
        }),
      clear: (provider) =>
        Ref.update(stateRef, (state) => {
          if (!state.has(provider)) {
            return state;
          }
          const next = new Map(state);
          next.delete(provider);
          return next;
        }),
    };

    yield* Stream.runForEach(providerService.streamEvents, (event) =>
      Effect.gen(function* () {
        if (event.provider !== "cursor") {
          return;
        }

        if (event.type === "session.started" || event.type === "session.exited") {
          yield* service.clear("cursor");
          return;
        }

        if (event.type !== "thread.token-usage.updated") {
          return;
        }

        const usage = toCursorUsageLimits(event);
        if (usage === undefined) {
          return;
        }

        yield* service.set("cursor", usage);
      }),
    ).pipe(Effect.forkScoped);

    return service;
  }),
);

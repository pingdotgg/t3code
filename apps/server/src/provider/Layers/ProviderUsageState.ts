import type {
  ProviderDriverKind,
  ProviderRuntimeEvent,
  ServerProviderUsageLimits,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderDriverKind as ProviderDriverKindSchema } from "@t3tools/contracts";
import { Effect, Layer, Ref, Stream } from "effect";

import { runtimeUsageToProviderUsageLimits } from "../runtimeUsageToProviderUsageLimits.ts";
import {
  ProviderUsageState,
  type ProviderUsageStateShape,
} from "../Services/ProviderUsageState.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const CURSOR_DRIVER = ProviderDriverKindSchema.make("cursor");

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
    const stateRef = yield* Ref.make(
      new Map<
        ProviderDriverKind,
        Map<ThreadId, { readonly usage: ServerProviderUsageLimits; readonly updatedAtMs: number }>
      >(),
    );

    const service: ProviderUsageStateShape = {
      get: (provider) =>
        Ref.get(stateRef).pipe(
          Effect.map((state) => {
            const threadMap = state.get(provider);
            if (!threadMap || threadMap.size === 0) {
              return undefined;
            }
            let latest:
              | { readonly usage: ServerProviderUsageLimits; readonly updatedAtMs: number }
              | undefined;
            for (const entry of threadMap.values()) {
              if (!latest || entry.updatedAtMs > latest.updatedAtMs) {
                latest = entry;
              }
            }
            return latest?.usage;
          }),
        ),
      set: (provider, threadId, usage) =>
        Ref.update(stateRef, (state) => {
          const next = new Map(state);
          if (usage === undefined) {
            const existingThreadMap = next.get(provider);
            if (existingThreadMap) {
              const newThreadMap = new Map(existingThreadMap);
              newThreadMap.delete(threadId);
              if (newThreadMap.size === 0) {
                next.delete(provider);
              } else {
                next.set(provider, newThreadMap);
              }
            }
          } else {
            let threadMap = next.get(provider);
            if (!threadMap) {
              threadMap = new Map();
            } else {
              threadMap = new Map(threadMap);
            }
            next.set(provider, threadMap);
            threadMap.set(threadId, { usage, updatedAtMs: Date.now() });
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
          yield* Ref.update(stateRef, (state) => {
            const next = new Map(state);
            const existingThreadMap = next.get(CURSOR_DRIVER);
            if (existingThreadMap) {
              const threadMap = new Map(existingThreadMap);
              next.set(CURSOR_DRIVER, threadMap);
              threadMap.delete(event.threadId);
              if (threadMap.size === 0) {
                next.delete(CURSOR_DRIVER);
              }
            }
            return next;
          });
          return;
        }

        if (event.type !== "thread.token-usage.updated") {
          return;
        }

        const usage = toCursorUsageLimits(event);
        if (usage === undefined) {
          return;
        }

        yield* Ref.update(stateRef, (state) => {
          const next = new Map(state);
          let threadMap = next.get(CURSOR_DRIVER);
          if (!threadMap) {
            threadMap = new Map();
          } else {
            threadMap = new Map(threadMap);
          }
          next.set(CURSOR_DRIVER, threadMap);
          threadMap.set(event.threadId, {
            usage,
            updatedAtMs: Date.parse(event.createdAt) || Date.now(),
          });
          return next;
        });
      }),
    ).pipe(Effect.forkScoped);

    return service;
  }),
);

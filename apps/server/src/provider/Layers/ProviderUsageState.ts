import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
  ServerProviderUsageLimits,
  ThreadId,
} from "@t3tools/contracts";
import { ProviderDriverKind as ProviderDriverKindSchema } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import { parseClaudeRuntimeUsageLimits } from "../claudeUsageProbe.ts";
import { runtimeUsageToProviderUsageLimits } from "../runtimeUsageToProviderUsageLimits.ts";
import {
  ProviderUsageState,
  type ProviderUsageStateShape,
} from "../Services/ProviderUsageState.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const CURSOR_DRIVER = ProviderDriverKindSchema.make("cursor");
const CLAUDE_DRIVER = ProviderDriverKindSchema.make("claudeAgent");

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

function makeProviderInstanceKey(
  provider: ProviderDriverKind,
  providerInstanceId: ProviderInstanceId | undefined,
): string {
  if (providerInstanceId === undefined || providerInstanceId === null) {
    return provider;
  }
  return `${provider}_${providerInstanceId}`;
}

export const ProviderUsageStateLive = Layer.effect(
  ProviderUsageState,
  Effect.gen(function* () {
    const providerService = yield* ProviderService;
    const stateRef = yield* Ref.make(
      new Map<
        string,
        Map<ThreadId, { readonly usage: ServerProviderUsageLimits; readonly updatedAtMs: number }>
      >(),
    );

    const clearThreadUsage = (
      provider: ProviderDriverKind,
      providerInstanceId: ProviderInstanceId | undefined,
      threadId: ThreadId,
    ) =>
      Ref.update(stateRef, (state) => {
        const next = new Map(state);
        const key = makeProviderInstanceKey(provider, providerInstanceId);
        const existingThreadMap = next.get(key);
        if (!existingThreadMap) {
          return state;
        }
        const threadMap = new Map(existingThreadMap);
        threadMap.delete(threadId);
        if (threadMap.size === 0) {
          next.delete(key);
        } else {
          next.set(key, threadMap);
        }
        return next;
      });

    const setThreadUsage = (
      provider: ProviderDriverKind,
      providerInstanceId: ProviderInstanceId | undefined,
      threadId: ThreadId,
      usage: ServerProviderUsageLimits,
      updatedAtMs: number,
    ) =>
      Ref.update(stateRef, (state) => {
        const next = new Map(state);
        const key = makeProviderInstanceKey(provider, providerInstanceId);
        const threadMap = new Map(next.get(key) ?? []);
        next.set(key, threadMap);
        threadMap.set(threadId, { usage, updatedAtMs });
        return next;
      });

    const service: ProviderUsageStateShape = {
      get: (provider, providerInstanceId) =>
        Ref.get(stateRef).pipe(
          Effect.map((state) => {
            const key = makeProviderInstanceKey(provider, providerInstanceId);
            const threadMap = state.get(key);
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
      set: (provider, providerInstanceId, threadId, usage) =>
        Effect.flatMap(Effect.map(DateTime.now, DateTime.toEpochMillis), (updatedAtMs) =>
          Ref.update(stateRef, (state) => {
            const next = new Map(state);
            const key = makeProviderInstanceKey(provider, providerInstanceId);
            if (usage === undefined) {
              const existingThreadMap = next.get(key);
              if (existingThreadMap) {
                const newThreadMap = new Map(existingThreadMap);
                newThreadMap.delete(threadId);
                if (newThreadMap.size === 0) {
                  next.delete(key);
                } else {
                  next.set(key, newThreadMap);
                }
              }
            } else {
              const threadMap = new Map(next.get(key) ?? []);
              next.set(key, threadMap);
              threadMap.set(threadId, { usage, updatedAtMs });
            }
            return next;
          }),
        ),
      clear: (provider, providerInstanceId) =>
        Ref.update(stateRef, (state) => {
          const next = new Map(state);
          const key = makeProviderInstanceKey(provider, providerInstanceId);
          next.delete(key);
          return next;
        }),
    };

    yield* Stream.runForEach(providerService.streamEvents, (event) =>
      Effect.gen(function* () {
        const providerInstanceId = event.providerInstanceId;

        if (event.type === "session.started" || event.type === "session.exited") {
          yield* clearThreadUsage(event.provider, providerInstanceId, event.threadId);
          return;
        }

        if (event.provider === "cursor" && event.type === "thread.token-usage.updated") {
          const usage = toCursorUsageLimits(event);
          if (usage === undefined) {
            return;
          }

          const cursorMaybeDate = DateTime.make(event.createdAt);
          const cursorUpdatedAtMs = Option.isSome(cursorMaybeDate)
            ? DateTime.toEpochMillis(cursorMaybeDate.value)
            : DateTime.toEpochMillis(yield* DateTime.now);
          yield* setThreadUsage(
            CURSOR_DRIVER,
            providerInstanceId,
            event.threadId,
            usage,
            cursorUpdatedAtMs,
          );
          return;
        }

        if (event.provider !== "claudeAgent" || event.type !== "account.rate-limits.updated") {
          return;
        }

        const usage = parseClaudeRuntimeUsageLimits({
          checkedAt: event.createdAt,
          rateLimits:
            typeof event.payload === "object" &&
            event.payload !== null &&
            "rateLimits" in event.payload
              ? (event.payload as { readonly rateLimits?: unknown }).rateLimits
              : undefined,
        });
        if (usage === undefined) {
          return;
        }

        const claudeMaybeDate = DateTime.make(event.createdAt);
        const claudeUpdatedAtMs = Option.isSome(claudeMaybeDate)
          ? DateTime.toEpochMillis(claudeMaybeDate.value)
          : DateTime.toEpochMillis(yield* DateTime.now);
        yield* setThreadUsage(
          CLAUDE_DRIVER,
          providerInstanceId,
          event.threadId,
          usage,
          claudeUpdatedAtMs,
        );
      }),
    ).pipe(Effect.forkScoped);

    return service;
  }),
);

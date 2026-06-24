import type {
  ProviderDriverKind,
  ProviderInstanceId,
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
import { parseCodexRuntimeUsageLimits } from "../codexUsageProbe.ts";
import { mergeProviderUsageLimits } from "../providerUsageLimits.ts";
import { ProviderRegistry } from "../Services/ProviderRegistry.ts";
import { ProviderUsageState } from "../Services/ProviderUsageState.ts";
import { ProviderService } from "../Services/ProviderService.ts";

const CLAUDE_DRIVER = ProviderDriverKindSchema.make("claudeAgent");
const CODEX_DRIVER = ProviderDriverKindSchema.make("codex");

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

    const publishUsageLimits = (
      providerInstanceId: ProviderInstanceId | undefined,
      usage: ServerProviderUsageLimits,
    ) =>
      providerInstanceId === undefined
        ? Effect.void
        : Effect.serviceOption(ProviderRegistry).pipe(
            Effect.flatMap(
              Option.match({
                onNone: () => Effect.void,
                onSome: (registry) =>
                  registry
                    .patchProviderUsageLimits(providerInstanceId, usage)
                    .pipe(Effect.ignoreCause({ log: true })),
              }),
            ),
          );

    const service: ProviderUsageState["Service"] = {
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

        if (event.type !== "account.rate-limits.updated") {
          return;
        }

        const rateLimitsPayload =
          typeof event.payload === "object" &&
          event.payload !== null &&
          "rateLimits" in event.payload
            ? (event.payload as { readonly rateLimits?: unknown }).rateLimits
            : undefined;

        const usage =
          event.provider === CLAUDE_DRIVER
            ? parseClaudeRuntimeUsageLimits({
                checkedAt: event.createdAt,
                rateLimits: rateLimitsPayload,
              })
            : event.provider === CODEX_DRIVER
              ? parseCodexRuntimeUsageLimits({
                  checkedAt: event.createdAt,
                  rateLimits: rateLimitsPayload,
                })
              : undefined;
        if (usage === undefined) {
          return;
        }

        const existingUsage = yield* service.get(event.provider, providerInstanceId);
        const mergedUsage = mergeProviderUsageLimits(existingUsage, usage);

        const maybeDate = DateTime.make(event.createdAt);
        const updatedAtMs = Option.isSome(maybeDate)
          ? DateTime.toEpochMillis(maybeDate.value)
          : DateTime.toEpochMillis(yield* DateTime.now);
        yield* setThreadUsage(
          event.provider,
          providerInstanceId,
          event.threadId,
          mergedUsage,
          updatedAtMs,
        );
        // Publish only the sparse event delta. The registry merges by window
        // kind; sending the full in-memory snapshot would let stale windows
        // from other threads overwrite fresher quota from a recent status probe.
        yield* publishUsageLimits(providerInstanceId, usage);
      }),
    ).pipe(Effect.forkScoped);

    return service;
  }),
);

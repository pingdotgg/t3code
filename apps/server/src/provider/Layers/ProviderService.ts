/**
 * ProviderServiceLive - Cross-provider orchestration layer.
 *
 * Routes validated transport/API calls to provider adapters through
 * `ProviderAdapterRegistry` and `ProviderSessionDirectory`, and exposes a
 * unified provider event stream for subscribers.
 *
 * It does not implement provider protocol details (adapter concern).
 *
 * @module ProviderServiceLive
 */
import {
  NonNegativeInt,
  ProviderSessionId,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { Effect, Layer, Option, PubSub, Queue, Ref, Schema, SchemaIssue, Stream } from "effect";

import { ProviderSessionNotFoundError, ProviderValidationError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import {
  ProviderSessionDirectory,
  type ProviderSessionBinding,
} from "../Services/ProviderSessionDirectory.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
  readonly canonicalEventLogger?: EventNdjsonLogger;
}

const ProviderRollbackConversationInput = Schema.Struct({
  sessionId: ProviderSessionId,
  numTurns: NonNegativeInt,
});

function toValidationError(
  operation: string,
  issue: string,
  cause?: unknown,
): ProviderValidationError {
  return new ProviderValidationError({
    operation,
    issue,
    ...(cause !== undefined ? { cause } : {}),
  });
}

const decodeInputOrValidationError = <S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}) =>
  Schema.decodeUnknownEffect(input.schema)(input.payload).pipe(
    Effect.mapError(
      (schemaError) =>
        new ProviderValidationError({
          operation: input.operation,
          issue: SchemaIssue.makeFormatterDefault()(schemaError.issue),
          cause: schemaError,
        }),
    ),
  );

function toRuntimeStatus(session: ProviderSession): "starting" | "running" | "stopped" | "error" {
  switch (session.status) {
    case "connecting":
      return "starting";
    case "error":
      return "error";
    case "closed":
      return "stopped";
    case "ready":
    case "running":
    default:
      return "running";
  }
}

function toRuntimePayloadFromSession(session: ProviderSession): Record<string, unknown> {
  return {
    cwd: session.cwd ?? null,
    model: session.model ?? null,
    activeTurnId: session.activeTurnId ?? null,
    lastError: session.lastError ?? null,
  };
}

function readPersistedCwd(
  runtimePayload: ProviderSessionBinding["runtimePayload"],
): string | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const rawCwd = "cwd" in runtimePayload ? runtimePayload.cwd : undefined;
  if (typeof rawCwd !== "string") return undefined;
  const trimmed = rawCwd.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
    const canonicalEventLogger =
      options?.canonicalEventLogger ??
      (options?.canonicalEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.canonicalEventLogPath, {
            stream: "canonical",
          })
        : undefined);

    const registry = yield* ProviderAdapterRegistry;
    const directory = yield* ProviderSessionDirectory;
    const runtimeEventQueue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const runtimeEventPubSub = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const routedSessionAliasesRef = yield* Ref.make<Map<ProviderSessionId, ProviderSessionId>>(
      new Map(),
    );

    const canonicalizeRuntimeEventSession = (
      event: ProviderRuntimeEvent,
    ): Effect.Effect<ProviderRuntimeEvent> =>
      Ref.get(routedSessionAliasesRef).pipe(
        Effect.map((aliases) => {
          for (const [staleSessionId, liveSessionId] of aliases) {
            if (liveSessionId === event.sessionId) {
              return {
                ...event,
                sessionId: staleSessionId,
              } satisfies ProviderRuntimeEvent;
            }
          }
          return event;
        }),
      );

    const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      canonicalizeRuntimeEventSession(event).pipe(
        Effect.tap((canonicalEvent) =>
          canonicalEventLogger
            ? Effect.flatMap(
                Effect.catch(
                  directory.getThreadId(canonicalEvent.sessionId).pipe(
                    Effect.map((threadIdOption) =>
                      Option.isSome(threadIdOption) ? threadIdOption.value : null,
                    ),
                  ),
                  () => Effect.succeed<ThreadId | null>(null),
                ),
                (orchestrationThreadId) =>
                  canonicalEventLogger.write(canonicalEvent, orchestrationThreadId),
              )
            : Effect.void,
        ),
        Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
        Effect.asVoid,
      );

    const upsertSessionBinding = (
      session: ProviderSession,
      operation: string,
      threadId: ThreadId,
    ) =>
      Effect.gen(function* () {
        const providerThreadId = session.threadId;
        if (!providerThreadId) {
          return yield* toValidationError(
            operation,
            `Provider '${session.provider}' returned a session without threadId.`,
          );
        }

        yield* directory.upsert({
          sessionId: session.sessionId,
          provider: session.provider,
          threadId,
          providerThreadId,
          status: toRuntimeStatus(session),
          ...(session.resumeCursor !== undefined ? { resumeCursor: session.resumeCursor } : {}),
          runtimePayload: toRuntimePayloadFromSession(session),
        });

        return providerThreadId;
      });

    const clearAliasKey = (staleSessionId: ProviderSessionId) =>
      Ref.update(routedSessionAliasesRef, (current) => {
        if (!current.has(staleSessionId)) {
          return current;
        }
        const next = new Map(current);
        next.delete(staleSessionId);
        return next;
      });

    const clearAliasesReferencing = (sessionId: ProviderSessionId) =>
      Ref.update(routedSessionAliasesRef, (current) => {
        let changed = false;
        const next = new Map<ProviderSessionId, ProviderSessionId>();
        for (const [key, value] of current) {
          if (key === sessionId || value === sessionId) {
            changed = true;
            continue;
          }
          next.set(key, value);
        }
        return changed ? next : current;
      });

    const setAlias = (staleSessionId: ProviderSessionId, liveSessionId: ProviderSessionId) =>
      Ref.update(routedSessionAliasesRef, (current) => {
        const existing = current.get(staleSessionId);
        if (existing === liveSessionId) {
          return current;
        }
        const next = new Map(current);
        next.set(staleSessionId, liveSessionId);
        return next;
      });

    const providers = yield* registry.listProviders();
    const adapters = yield* Effect.forEach(providers, (provider) =>
      registry.getByProvider(provider),
    );

    const processRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      publishRuntimeEvent(event);

    const worker = Effect.forever(
      Queue.take(runtimeEventQueue).pipe(Effect.flatMap(processRuntimeEvent)),
    );
    yield* Effect.forkScoped(worker);

    yield* Effect.forEach(adapters, (adapter) =>
      Stream.runForEach(adapter.streamEvents, (event) =>
        Queue.offer(runtimeEventQueue, event).pipe(Effect.asVoid),
      ).pipe(Effect.forkScoped),
    ).pipe(Effect.asVoid);

    const recoverSessionForThread = (input: {
      readonly staleSessionId: ProviderSessionId;
      readonly binding: ProviderSessionBinding & { readonly threadId: ThreadId };
      readonly operation: string;
    }) =>
      Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(input.binding.provider);
        const activeSessions = yield* adapter.listSessions();
        const resumeThreadId = input.binding.providerThreadId ?? undefined;
        const hasResumeCursor =
          input.binding.resumeCursor !== null && input.binding.resumeCursor !== undefined;
        const existing =
          resumeThreadId === undefined
            ? undefined
            : activeSessions.find((session) => session.threadId === resumeThreadId);
        if (existing) {
          const existingProviderThreadId = yield* upsertSessionBinding(
            existing,
            `${input.operation}:upsertExistingSession`,
            input.binding.threadId,
          );
          yield* directory.upsert({
            sessionId: input.staleSessionId,
            provider: existing.provider,
            threadId: input.binding.threadId,
            providerThreadId: existingProviderThreadId,
            ...(existing.resumeCursor !== undefined ? { resumeCursor: existing.resumeCursor } : {}),
          });
          if (existing.sessionId !== input.staleSessionId) {
            yield* setAlias(input.staleSessionId, existing.sessionId);
          } else {
            yield* clearAliasKey(input.staleSessionId);
          }
          return {
            adapter,
            sessionId: existing.sessionId,
          } as const;
        }

        if (!hasResumeCursor) {
          return yield* toValidationError(
            input.operation,
            `Cannot recover stale session '${input.staleSessionId}' because no provider resume state is persisted.`,
          );
        }

        const persistedCwd = readPersistedCwd(input.binding.runtimePayload);

        const resumed = yield* adapter.startSession({
          provider: input.binding.provider,
          ...(persistedCwd ? { cwd: persistedCwd } : {}),
          ...(resumeThreadId ? { resumeThreadId } : {}),
          ...(hasResumeCursor ? { resumeCursor: input.binding.resumeCursor } : {}),
        });
        if (resumed.provider !== adapter.provider) {
          return yield* toValidationError(
            input.operation,
            `Adapter/provider mismatch while recovering stale session '${input.staleSessionId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
          );
        }

        const resumedProviderThreadId = yield* upsertSessionBinding(
          resumed,
          `${input.operation}:upsertRecoveredSession`,
          input.binding.threadId,
        );

        yield* directory.upsert({
          sessionId: input.staleSessionId,
          provider: resumed.provider,
          threadId: input.binding.threadId,
          providerThreadId: resumedProviderThreadId,
          ...(resumed.resumeCursor !== undefined ? { resumeCursor: resumed.resumeCursor } : {}),
        });

        if (resumed.sessionId !== input.staleSessionId) {
          yield* setAlias(input.staleSessionId, resumed.sessionId);
        } else {
          yield* clearAliasKey(input.staleSessionId);
        }

        return {
          adapter,
          sessionId: resumed.sessionId,
        } as const;
      });

    const resolveRoutableSession = (input: {
      readonly sessionId: ProviderSessionId;
      readonly operation: string;
      readonly allowRecovery: boolean;
    }) =>
      Effect.gen(function* () {
        const bindingOption = yield* directory.getBinding(input.sessionId);
        const binding = Option.getOrUndefined(bindingOption);
        if (!binding) {
          return yield* new ProviderSessionNotFoundError({
            sessionId: input.sessionId,
          });
        }
        if (!binding.threadId) {
          return yield* toValidationError(
            input.operation,
            `Cannot route session '${input.sessionId}' because no orchestration thread id is persisted.`,
          );
        }
        const bindingWithThreadId: ProviderSessionBinding & {
          readonly threadId: ThreadId;
        } = {
          ...binding,
          threadId: binding.threadId,
        };
        const adapter = yield* registry.getByProvider(binding.provider);

        const hasRequestedSession = yield* adapter.hasSession(input.sessionId);
        if (hasRequestedSession) {
          yield* clearAliasKey(input.sessionId);
          return {
            adapter,
            sessionId: input.sessionId,
            isActive: true,
          } as const;
        }

        const alias = yield* Ref.get(routedSessionAliasesRef).pipe(
          Effect.map((aliases) => aliases.get(input.sessionId)),
        );
        if (alias) {
          const aliasIsActive = yield* adapter.hasSession(alias);
          if (aliasIsActive) {
            return {
              adapter,
              sessionId: alias,
              isActive: true,
            } as const;
          }
          yield* clearAliasKey(input.sessionId);
        }

        if (!input.allowRecovery) {
          return {
            adapter,
            sessionId: input.sessionId,
            isActive: false,
          } as const;
        }

        const recovered = yield* recoverSessionForThread({
          staleSessionId: input.sessionId,
          binding: bindingWithThreadId,
          operation: input.operation,
        });

        return {
          adapter: recovered.adapter,
          sessionId: recovered.sessionId,
          isActive: true,
        } as const;
      });

    const startSession: ProviderServiceShape["startSession"] = (threadId, rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.startSession",
          schema: ProviderSessionStartInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          provider: parsed.provider ?? "codex",
          approvalPolicy: parsed.approvalPolicy ?? "never",
          sandboxMode: parsed.sandboxMode ?? "workspace-write",
        };
        const adapter = yield* registry.getByProvider(input.provider);
        const session = yield* adapter.startSession(input);

        if (session.provider !== adapter.provider) {
          return yield* toValidationError(
            "ProviderService.startSession",
            `Adapter/provider mismatch: requested '${adapter.provider}', received '${session.provider}'.`,
          );
        }

        yield* upsertSessionBinding(session, "ProviderService.startSession", threadId);

        return session;
      });

    const sendTurn: ProviderServiceShape["sendTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const parsed = yield* decodeInputOrValidationError({
          operation: "ProviderService.sendTurn",
          schema: ProviderSendTurnInput,
          payload: rawInput,
        });

        const input = {
          ...parsed,
          attachments: parsed.attachments ?? [],
        };
        if (!input.input && input.attachments.length === 0) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            "Either input text or at least one attachment is required",
          );
        }
        const routed = yield* resolveRoutableSession({
          sessionId: input.sessionId,
          operation: "ProviderService.sendTurn",
          allowRecovery: true,
        });
        const turn = yield* routed.adapter.sendTurn({
          ...input,
          sessionId: routed.sessionId,
        });
        const threadId = yield* directory
          .getThreadId(input.sessionId)
          .pipe(Effect.map(Option.getOrUndefined));
        if (!threadId) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            `No thread id is tracked for provider session '${input.sessionId}'.`,
          );
        }
        yield* directory.upsert({
          sessionId: input.sessionId,
          provider: routed.adapter.provider,
          threadId,
          providerThreadId: turn.threadId,
          status: "running",
          ...(turn.resumeCursor !== undefined ? { resumeCursor: turn.resumeCursor } : {}),
          runtimePayload: {
            activeTurnId: turn.turnId,
            lastRuntimeEvent: "provider.sendTurn",
            lastRuntimeEventAt: new Date().toISOString(),
          },
        });
        return turn;
      });

    const interruptTurn: ProviderServiceShape["interruptTurn"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.interruptTurn",
          schema: ProviderInterruptTurnInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          sessionId: input.sessionId,
          operation: "ProviderService.interruptTurn",
          allowRecovery: true,
        });
        yield* routed.adapter.interruptTurn(routed.sessionId, input.turnId);
      });

    const respondToRequest: ProviderServiceShape["respondToRequest"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.respondToRequest",
          schema: ProviderRespondToRequestInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          sessionId: input.sessionId,
          operation: "ProviderService.respondToRequest",
          allowRecovery: true,
        });
        yield* routed.adapter.respondToRequest(routed.sessionId, input.requestId, input.decision);
      });

    const stopSession: ProviderServiceShape["stopSession"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.stopSession",
          schema: ProviderStopSessionInput,
          payload: rawInput,
        });
        const routed = yield* resolveRoutableSession({
          sessionId: input.sessionId,
          operation: "ProviderService.stopSession",
          allowRecovery: false,
        });
        if (routed.isActive) {
          yield* routed.adapter.stopSession(routed.sessionId);
        }
        if (routed.sessionId !== input.sessionId) {
          yield* directory.remove(routed.sessionId);
          yield* clearAliasesReferencing(routed.sessionId);
        }
        yield* directory.remove(input.sessionId);
        yield* clearAliasesReferencing(input.sessionId);
      });

    const listSessions: ProviderServiceShape["listSessions"] = () =>
      Effect.forEach(adapters, (adapter) => adapter.listSessions()).pipe(
        Effect.map((sessionsByProvider) => sessionsByProvider.flatMap((sessions) => sessions)),
      );

    const rollbackConversation: ProviderServiceShape["rollbackConversation"] = (rawInput) =>
      Effect.gen(function* () {
        const input = yield* decodeInputOrValidationError({
          operation: "ProviderService.rollbackConversation",
          schema: ProviderRollbackConversationInput,
          payload: rawInput,
        });
        if (input.numTurns === 0) {
          return;
        }
        const routed = yield* resolveRoutableSession({
          sessionId: input.sessionId,
          operation: "ProviderService.rollbackConversation",
          allowRecovery: true,
        });
        yield* routed.adapter.rollbackThread(routed.sessionId, input.numTurns);
      });

    const stopAll: ProviderServiceShape["stopAll"] = () =>
      Effect.gen(function* () {
        const sessionIds = yield* directory.listSessionIds();
        yield* Effect.forEach(adapters, (adapter) => adapter.stopAll()).pipe(Effect.asVoid);
        yield* Effect.forEach(sessionIds, (sessionId) =>
          directory.getProvider(sessionId).pipe(
            Effect.flatMap((provider) =>
              directory.upsert({
                sessionId,
                provider,
                status: "stopped",
                runtimePayload: {
                  activeTurnId: null,
                  lastRuntimeEvent: "provider.stopAll",
                  lastRuntimeEventAt: new Date().toISOString(),
                },
              }),
            ),
          ),
        ).pipe(Effect.asVoid);
        // Keep persisted session bindings so stale sessions can be resumed after
        // process restart via providerThreadId.
        yield* Ref.set(routedSessionAliasesRef, new Map());
      });

    return {
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      stopSession,
      listSessions,
      rollbackConversation,
      stopAll,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
    } satisfies ProviderServiceShape;
  });

export const ProviderServiceLive = Layer.effect(ProviderService, makeProviderService());

export function makeProviderServiceLive(options?: ProviderServiceLiveOptions) {
  return Layer.effect(ProviderService, makeProviderService(options));
}

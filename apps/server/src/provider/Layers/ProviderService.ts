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
  ProviderThreadId,
  ThreadId,
  ProviderInterruptTurnInput,
  ProviderRespondToRequestInput,
  ProviderSendTurnInput,
  ProviderSessionStartInput,
  ProviderStopSessionInput,
  type ProviderRuntimeEvent,
  type ProviderSession,
} from "@t3tools/contracts";
import { Effect, Layer, Option, PubSub, Queue, Ref, Schema, Stream } from "effect";

import { ProviderValidationError } from "../Errors.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService, type ProviderServiceShape } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

export interface ProviderServiceLiveOptions {
  readonly canonicalEventLogPath?: string;
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

function decodeIssueMessage(cause: unknown): string {
  if (cause instanceof Error && cause.message.length > 0) {
    return cause.message;
  }
  try {
    return JSON.stringify(cause);
  } catch {
    return "Invalid provider input.";
  }
}

function decodeInputOrValidationError<S extends Schema.Top>(input: {
  readonly operation: string;
  readonly schema: S;
  readonly payload: unknown;
}): Effect.Effect<Schema.Schema.Type<S>, ProviderValidationError> {
  try {
    return Effect.succeed(
      Schema.decodeUnknownSync(input.schema as never)(input.payload) as Schema.Schema.Type<S>,
    );
  } catch (cause) {
    return Effect.fail(toValidationError(input.operation, decodeIssueMessage(cause), cause));
  }
}

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

function asProviderSessionId(value: string | ProviderSessionId): ProviderSessionId {
  return typeof value === "string" ? ProviderSessionId.makeUnsafe(value) : value;
}

function asProviderThreadId(value: string | ProviderThreadId): ProviderThreadId {
  return typeof value === "string" ? ProviderThreadId.makeUnsafe(value) : value;
}

const makeProviderService = (options?: ProviderServiceLiveOptions) =>
  Effect.gen(function* () {
    const canonicalEventLogger =
      options?.canonicalEventLogPath !== undefined
        ? makeEventNdjsonLogger(options.canonicalEventLogPath)
        : undefined;

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
                sessionId: ProviderSessionId.makeUnsafe(staleSessionId),
              } satisfies ProviderRuntimeEvent;
            }
          }
          return event;
        }),
      );

    const publishRuntimeEvent = (event: ProviderRuntimeEvent): Effect.Effect<void> =>
      canonicalizeRuntimeEventSession(event).pipe(
        Effect.tap((canonicalEvent) =>
          Effect.sync(() => {
            canonicalEventLogger?.write({
              observedAt: new Date().toISOString(),
              event: canonicalEvent,
            });
          }),
        ),
        Effect.flatMap((canonicalEvent) => PubSub.publish(runtimeEventPubSub, canonicalEvent)),
        Effect.asVoid,
      );

    const upsertSessionBinding = (session: ProviderSession, operation: string) =>
      Effect.gen(function* () {
        const providerThreadId = session.threadId;
        if (!providerThreadId) {
          return yield* toValidationError(
            operation,
            `Provider '${session.provider}' returned a session without threadId.`,
          );
        }

        const providerSessionId = asProviderSessionId(session.sessionId);
        const brandedThreadId = ThreadId.makeUnsafe(providerThreadId);
        yield* directory.upsert({
          sessionId: providerSessionId,
          provider: session.provider,
          threadId: brandedThreadId,
          providerThreadId,
          status: toRuntimeStatus(session),
          resumeCursor: { resumeThreadId: providerThreadId },
          runtimePayload: toRuntimePayloadFromSession(session),
        });

        return brandedThreadId;
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
      readonly provider: ProviderSession["provider"];
      readonly threadId: ThreadId;
      readonly operation: string;
    }) =>
      Effect.gen(function* () {
        const adapter = yield* registry.getByProvider(input.provider);
        const activeSessions = yield* adapter.listSessions();
        const expectedProviderThreadId = asProviderThreadId(input.threadId);
        const existing = activeSessions.find(
          (session) => session.threadId === expectedProviderThreadId,
        );
        if (existing) {
          const existingThreadId = yield* upsertSessionBinding(
            existing,
            `${input.operation}:upsertExistingSession`,
          );
          yield* directory.upsert({
            sessionId: input.staleSessionId,
            provider: existing.provider,
            threadId: existingThreadId,
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

        const resumed = yield* adapter.startSession({
          provider: input.provider,
          resumeThreadId: ProviderThreadId.makeUnsafe(input.threadId),
        });
        if (resumed.provider !== adapter.provider) {
          return yield* toValidationError(
            input.operation,
            `Adapter/provider mismatch while recovering stale session '${input.staleSessionId}'. Expected '${adapter.provider}', received '${resumed.provider}'.`,
          );
        }

        const resumedThreadId = yield* upsertSessionBinding(
          resumed,
          `${input.operation}:upsertRecoveredSession`,
        );
        if (resumedThreadId !== input.threadId) {
          return yield* toValidationError(
            input.operation,
            `Recovered session thread '${resumedThreadId}' does not match expected thread '${input.threadId}'.`,
          );
        }

        yield* directory.upsert({
          sessionId: input.staleSessionId,
          provider: resumed.provider,
          threadId: resumedThreadId,
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
        const provider = yield* directory.getProvider(input.sessionId);
        const adapter = yield* registry.getByProvider(provider);

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

        const threadIdOption = yield* directory.getThreadId(input.sessionId);
        const threadId = Option.getOrUndefined(threadIdOption);
        if (!threadId) {
          return yield* toValidationError(
            input.operation,
            `Cannot recover stale session '${input.sessionId}' because no thread id is persisted.`,
          );
        }

        const recovered = yield* recoverSessionForThread({
          staleSessionId: input.sessionId,
          provider,
          threadId,
          operation: input.operation,
        });

        return {
          adapter: recovered.adapter,
          sessionId: recovered.sessionId,
          isActive: true,
        } as const;
      });

    const startSession: ProviderServiceShape["startSession"] = (rawInput) =>
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

        yield* upsertSessionBinding(session, "ProviderService.startSession");

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
          .getThreadId(asProviderSessionId(input.sessionId))
          .pipe(Effect.map(Option.getOrUndefined));
        if (!threadId) {
          return yield* toValidationError(
            "ProviderService.sendTurn",
            `No thread id is tracked for provider session '${input.sessionId}'.`,
          );
        }
        yield* directory.upsert({
          sessionId: asProviderSessionId(input.sessionId),
          provider: routed.adapter.provider,
          threadId,
          providerThreadId: asProviderThreadId(turn.threadId),
          status: "running",
          resumeCursor: { resumeThreadId: turn.threadId },
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
          yield* directory.remove(asProviderSessionId(routed.sessionId));
          yield* clearAliasesReferencing(routed.sessionId);
        }
        yield* directory.remove(asProviderSessionId(input.sessionId));
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
        // process restart via resumeThreadId.
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

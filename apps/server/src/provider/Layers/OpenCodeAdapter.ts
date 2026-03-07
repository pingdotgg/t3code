import {
  EventId,
  RuntimeItemId,
  ThreadId,
  TurnId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { createOpencode } from "@opencode-ai/sdk";
import { Effect, Layer, Queue, Stream } from "effect";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { OpenCodeAdapter, type OpenCodeAdapterShape } from "../Services/OpenCodeAdapter.ts";
import { resolveModelSlugForProvider } from "@t3tools/shared/model";

const PROVIDER = "opencode" as const;

type OpenCodeInstance = Awaited<ReturnType<typeof createOpencode>>;

type SessionState = {
  readonly providerSessionId: string;
  readonly threadId: ThreadId;
  readonly createdAt: string;
  updatedAt: string;
  activeTurnId?: TurnId;
};

type ThreadTurnSnapshot = {
  readonly id: TurnId;
  readonly items: unknown[];
};

export interface OpenCodeAdapterLiveOptions {
  readonly createClient?: () => Promise<OpenCodeInstance>;
}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.length > 0 ? cause.message : fallback;
}

function toRequestError(method: string, cause: unknown): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail: toMessage(cause, `${method} failed`),
    cause,
  });
}

function nowIso(): string {
  return new Date().toISOString();
}

function parseProviderModel(model: string): { providerID: string; modelID: string } {
  const [providerID, ...rest] = model.split("/");
  const modelID = rest.join("/");
  if (!providerID || !modelID) {
    throw new ProviderAdapterValidationError({
      provider: PROVIDER,
      operation: "sendTurn",
      issue: `Invalid OpenCode model '${model}'. Expected 'provider/model'.`,
    });
  }
  return { providerID, modelID };
}

function baseEvent(threadId: ThreadId): Pick<ProviderRuntimeEvent, "eventId" | "provider" | "threadId" | "createdAt"> {
  return {
    eventId: EventId.makeUnsafe(`evt_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`),
    provider: PROVIDER,
    threadId,
    createdAt: nowIso(),
  };
}

const makeOpenCodeAdapter = (options?: OpenCodeAdapterLiveOptions) =>
  Effect.gen(function* () {
    const runtime = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: () => (options?.createClient ? options.createClient() : createOpencode()),
        catch: (cause) =>
          new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: ThreadId.makeUnsafe("startup"),
            detail: toMessage(cause, "Failed to start OpenCode SDK runtime."),
            cause,
          }),
      }),
      (instance) =>
        Effect.sync(() => {
          instance.server.close();
        }),
    );

    const client = runtime.client;
    const queue = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, SessionState>();
    const snapshots = new Map<ThreadId, ThreadTurnSnapshot[]>();

    const getSession = (threadId: ThreadId): Effect.Effect<SessionState, ProviderAdapterError> => {
      const session = sessions.get(threadId);
      if (!session) {
        return Effect.fail(
          new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          }),
        );
      }
      return Effect.succeed(session);
    };

    const startSession: OpenCodeAdapterShape["startSession"] = (input) =>
      Effect.gen(function* () {
        if (input.provider !== undefined && input.provider !== PROVIDER) {
          return yield* Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "startSession",
              issue: `Expected provider '${PROVIDER}' but received '${input.provider}'.`,
            }),
          );
        }

        const created = yield* Effect.tryPromise({
          try: () =>
            client.session.create({
              body: { title: input.threadId },
              ...(input.cwd ? { query: { directory: input.cwd } } : {}),
            }),
          catch: (cause) => toRequestError("session.create", cause),
        });

        const at = nowIso();
        const state: SessionState = {
          providerSessionId: created.id,
          threadId: input.threadId,
          createdAt: at,
          updatedAt: at,
        };
        sessions.set(input.threadId, state);
        snapshots.set(input.threadId, []);

        yield* Queue.offer(queue, {
          ...baseEvent(input.threadId),
          type: "session.started",
          payload: { message: "OpenCode session created" },
        });
        yield* Queue.offer(queue, {
          ...baseEvent(input.threadId),
          type: "thread.started",
          payload: { providerThreadId: created.id },
        });

        return {
          provider: PROVIDER,
          status: "ready",
          runtimeMode: input.runtimeMode,
          threadId: input.threadId,
          ...(input.cwd ? { cwd: input.cwd } : {}),
          createdAt: at,
          updatedAt: at,
          resumeCursor: { providerSessionId: created.id },
          ...(input.model ? { model: resolveModelSlugForProvider(PROVIDER, input.model) } : {}),
        };
      });

    const sendTurn: OpenCodeAdapterShape["sendTurn"] = (input) =>
      Effect.gen(function* () {
        const session = yield* getSession(input.threadId);
        const turnId = TurnId.makeUnsafe(`turn_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`);
        session.activeTurnId = turnId;
        session.updatedAt = nowIso();

        const resolvedModel = resolveModelSlugForProvider(PROVIDER, input.model);
        const model = parseProviderModel(resolvedModel);

        const turnList = snapshots.get(input.threadId) ?? [];
        turnList.push({ id: turnId, items: [] });
        snapshots.set(input.threadId, turnList);

        yield* Queue.offer(queue, {
          ...baseEvent(input.threadId),
          turnId,
          type: "turn.started",
          payload: { model: `${model.providerID}/${model.modelID}` },
        });

        const subscription = yield* Effect.tryPromise({
          try: () => client.event.subscribe(),
          catch: (cause) => toRequestError("event.subscribe", cause),
        });

        yield* Effect.tryPromise({
          try: () =>
            client.session.prompt({
              path: { id: session.providerSessionId },
              body: {
                model,
                parts: [{ type: "text", text: input.input ?? "" }],
              },
            }),
          catch: (cause) => toRequestError("session.prompt", cause),
        });

        yield* Effect.forkScoped(
          Effect.tryPromise({
            try: async () => {
              for await (const sseEvent of subscription.stream) {
                const event = sseEvent as { type?: string; properties?: Record<string, unknown> };
                if (event.type === "message.part.updated") {
                  const part = event.properties?.part as { id?: string; type?: string; tool?: string } | undefined;
                  const delta = event.properties?.delta;
                  if (typeof delta === "string" && delta.length > 0) {
                    await Effect.runPromise(
                      Queue.offer(queue, {
                        ...baseEvent(input.threadId),
                        turnId,
                        itemId: RuntimeItemId.makeUnsafe(part?.id ?? `item_${Date.now()}`),
                        type: "content.delta",
                        payload: { streamKind: "output", delta },
                      }),
                    );
                  }
                  if (part?.type === "tool" || part?.type === "tool-call") {
                    await Effect.runPromise(
                      Queue.offer(queue, {
                        ...baseEvent(input.threadId),
                        turnId,
                        itemId: RuntimeItemId.makeUnsafe(part?.id ?? `tool_${Date.now()}`),
                        type: "item.started",
                        payload: {
                          itemType: "dynamic_tool_call",
                          title: part.tool ?? "Tool call",
                          data: event.properties,
                        },
                      }),
                    );
                  }
                  if (part?.type === "tool-result") {
                    await Effect.runPromise(
                      Queue.offer(queue, {
                        ...baseEvent(input.threadId),
                        turnId,
                        itemId: RuntimeItemId.makeUnsafe(part?.id ?? `tool_${Date.now()}`),
                        type: "item.completed",
                        payload: {
                          itemType: "dynamic_tool_call",
                          status: "completed",
                          detail: "Tool result",
                          data: event.properties,
                        },
                      }),
                    );
                  }
                }

                if (event.type === "session.updated") {
                  await Effect.runPromise(
                    Queue.offer(queue, {
                      ...baseEvent(input.threadId),
                      turnId,
                      type: "turn.completed",
                      payload: { state: "completed" },
                    }),
                  );
                  session.activeTurnId = undefined;
                  break;
                }

                if (event.type === "session.error") {
                  await Effect.runPromise(
                    Queue.offer(queue, {
                      ...baseEvent(input.threadId),
                      turnId,
                      type: "turn.completed",
                      payload: {
                        state: "failed",
                        errorMessage: "OpenCode session error",
                      },
                    }),
                  );
                  session.activeTurnId = undefined;
                  break;
                }
              }
            },
            catch: (cause) => cause,
          }).pipe(Effect.ignore),
        );

        return {
          threadId: input.threadId,
          turnId,
        };
      });

    const interruptTurn: OpenCodeAdapterShape["interruptTurn"] = (threadId) =>
      Effect.gen(function* () {
        const session = yield* getSession(threadId);
        yield* Effect.tryPromise({
          try: () => client.session.abort({ path: { id: session.providerSessionId } }),
          catch: (cause) => toRequestError("session.abort", cause),
        });
        session.activeTurnId = undefined;
      });

    const readThread: OpenCodeAdapterShape["readThread"] = (threadId) =>
      Effect.gen(function* () {
        yield* getSession(threadId);
        return {
          threadId,
          turns: snapshots.get(threadId) ?? [],
        };
      });

    const rollbackThread: OpenCodeAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      Effect.gen(function* () {
        yield* getSession(threadId);
        if (!Number.isInteger(numTurns) || numTurns < 1) {
          return yield* Effect.fail(
            new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "rollbackThread",
              issue: "numTurns must be an integer >= 1.",
            }),
          );
        }
        const turns = snapshots.get(threadId) ?? [];
        const nextTurns = turns.slice(0, Math.max(0, turns.length - numTurns));
        snapshots.set(threadId, nextTurns);
        return {
          threadId,
          turns: nextTurns,
        };
      });

    const stopSession: OpenCodeAdapterShape["stopSession"] = (threadId) =>
      Effect.gen(function* () {
        const session = yield* getSession(threadId);
        yield* Effect.tryPromise({
          try: () => client.session.delete({ path: { id: session.providerSessionId } }),
          catch: (cause) => toRequestError("session.delete", cause),
        });
        sessions.delete(threadId);
      });

    const listSessions: OpenCodeAdapterShape["listSessions"] = () =>
      Effect.sync(() =>
        [...sessions.values()].map((session) => ({
          provider: PROVIDER,
          status: session.activeTurnId ? ("running" as const) : ("ready" as const),
          runtimeMode: "full-access" as const,
          threadId: session.threadId,
          activeTurnId: session.activeTurnId,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          resumeCursor: { providerSessionId: session.providerSessionId },
        })),
      );

    const hasSession: OpenCodeAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const stopAll: OpenCodeAdapterShape["stopAll"] = () =>
      Effect.sync(() => {
        sessions.clear();
      });

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      stopAll,
      streamEvents: Stream.fromQueue(queue),
    } satisfies OpenCodeAdapterShape;
  });

export const OpenCodeAdapterLive = Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter());

export function makeOpenCodeAdapterLive(options?: OpenCodeAdapterLiveOptions) {
  return Layer.effect(OpenCodeAdapter, makeOpenCodeAdapter(options));
}

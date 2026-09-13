// @effect-diagnostics globalDate:off globalDateInEffect:off abortControllerInEffect:off preferSchemaOverJson:off schemaSyncInEffect:off preferTypedSchemaDecoder:off
import { randomUUID } from "node:crypto";
import {
  EventId,
  ProviderDriverKind,
  type OllamaSettings,
  type ProviderRuntimeEvent,
  ProviderInstanceId,
  type ProviderSession,
  type ProviderSessionStartInput,
  type ProviderSendTurnInput,
  type ProviderTurnStartResult,
  type ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import * as Schema from "effect/Schema";
import type { ProviderAdapterShape } from "../Services/ProviderAdapter.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { OLLAMA_API_KEY_ENV, ollamaApiUrl, type OllamaFetch } from "./OllamaProvider.ts";

const PROVIDER = ProviderDriverKind.make("ollama");
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
type Message = { role: "user" | "assistant"; content: string };
type Context = {
  session: ProviderSession;
  messages: Message[];
  controller?: AbortController;
  stopped: boolean;
};
const now = () => new Date().toISOString();
const eventStamp = () => ({ eventId: EventId.make(randomUUID()), createdAt: now() });
const requestError = (method: string, detail: string, cause?: unknown) =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause === undefined ? {} : { cause }),
  });

export function makeOllamaAdapter(
  settings: OllamaSettings,
  options?: {
    instanceId?: ProviderInstanceId;
    environment?: NodeJS.ProcessEnv;
    fetch?: OllamaFetch;
  },
): Effect.Effect<
  ProviderAdapterShape<
    | ProviderAdapterRequestError
    | ProviderAdapterValidationError
    | ProviderAdapterSessionNotFoundError
  >
> {
  return Effect.gen(function* () {
    const sessions = new Map<ThreadId, Context>();
    const eventBus = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const instanceId = options?.instanceId ?? ProviderInstanceId.make("ollama");
    const fetchImpl = options?.fetch ?? fetch;
    const headers = () => {
      const key = settings.apiKey.trim() || options?.environment?.[OLLAMA_API_KEY_ENV]?.trim();
      return {
        "content-type": "application/json",
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      };
    };
    const requireSession = (
      threadId: ThreadId,
    ): Effect.Effect<Context, ProviderAdapterSessionNotFoundError> => {
      const context = sessions.get(threadId);
      if (context && !context.stopped) return Effect.succeed(context);
      return Effect.fail(new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId }));
    };
    const startSession = (input: ProviderSessionStartInput) =>
      Effect.gen(function* () {
        if (input.provider && input.provider !== PROVIDER)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "Wrong provider.",
          });
        if (!input.cwd?.trim())
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: "cwd is required.",
          });
        const model =
          input.modelSelection?.model?.trim() || settings.defaultModel.trim() || "llama3.2";
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: instanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd.trim(),
          model,
          threadId: input.threadId,
          createdAt: now(),
          updatedAt: now(),
        };
        sessions.set(input.threadId, { session, messages: [], stopped: false });
        yield* PubSub.publish(eventBus, {
          type: "session.started",
          ...eventStamp(),
          provider: PROVIDER,
          threadId: input.threadId,
          payload: {},
        } as ProviderRuntimeEvent);
        return session;
      });
    const sendTurn = (
      input: ProviderSendTurnInput,
    ): Effect.Effect<
      ProviderTurnStartResult,
      | ProviderAdapterRequestError
      | ProviderAdapterValidationError
      | ProviderAdapterSessionNotFoundError
    > =>
      Effect.gen(function* () {
        const context = yield* requireSession(input.threadId);
        const text = input.input?.trim();
        if (!text)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text.",
          });
        const turnId = TurnId.make(randomUUID());
        const model =
          input.modelSelection?.model?.trim() ||
          context.session.model ||
          settings.defaultModel.trim() ||
          "llama3.2";
        context.messages.push({ role: "user", content: text });
        context.controller?.abort();
        const controller = new AbortController();
        context.controller = controller;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          model,
          updatedAt: now(),
        };
        yield* PubSub.publish(eventBus, {
          type: "turn.started",
          ...eventStamp(),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model },
        } as ProviderRuntimeEvent);
        const response = yield* Effect.tryPromise({
          try: () =>
            fetchImpl(ollamaApiUrl(settings.host, "/chat"), {
              method: "POST",
              headers: headers(),
              signal: controller.signal,
              body: encodeJson({ model, messages: context.messages, stream: true }),
            }),
          catch: (cause) => requestError("/api/chat", "Ollama chat request failed.", cause),
        });
        if (!response.ok || !response.body)
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "/api/chat",
            detail: `Ollama returned HTTP ${response.status}.`,
          });
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        let assistant = "";
        while (true) {
          const result = yield* Effect.tryPromise({
            try: () => reader.read(),
            catch: (cause) => requestError("/api/chat", "Failed reading Ollama stream.", cause),
          });
          if (result.done) break;
          buffer += decoder.decode(result.value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (!line.trim()) continue;
            const chunk = yield* Effect.try({
              try: () =>
                Schema.decodeUnknownSync(
                  Schema.Struct({
                    message: Schema.optional(
                      Schema.Struct({ content: Schema.optional(Schema.String) }),
                    ),
                  }),
                )(Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown))(line)),
              catch: () => ({}),
            }).pipe(
              Effect.mapError(() => requestError("/api/chat", "Invalid Ollama stream chunk.")),
            );
            const delta = chunk.message?.content ?? "";
            if (!delta) continue;
            assistant += delta;
            yield* PubSub.publish(eventBus, {
              type: "content.delta",
              ...eventStamp(),
              provider: PROVIDER,
              threadId: input.threadId,
              turnId,
              payload: { streamKind: "assistant_text", delta },
            } as ProviderRuntimeEvent);
          }
        }
        context.messages.push({ role: "assistant", content: assistant });
        context.session = { ...context.session, status: "ready", updatedAt: now() };
        yield* PubSub.publish(eventBus, {
          type: "turn.completed",
          ...eventStamp(),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { state: "completed", stopReason: "stop" },
        } as ProviderRuntimeEvent);
        return { threadId: input.threadId, turnId } as ProviderTurnStartResult;
      });
    const interruptTurn = (threadId: ThreadId) =>
      Effect.flatMap(requireSession(threadId), (context) =>
        Effect.sync(() => context.controller?.abort()),
      ).pipe(Effect.asVoid);
    const stopSession = (threadId: ThreadId) =>
      Effect.flatMap(requireSession(threadId), (context) =>
        Effect.sync(() => {
          context.stopped = true;
          context.controller?.abort();
          sessions.delete(threadId);
        }),
      ).pipe(Effect.asVoid);
    const unsupported = (threadId: ThreadId, operation: string) =>
      Effect.flatMap(requireSession(threadId), () =>
        Effect.fail(requestError(operation, "Ollama does not support this operation.")),
      );
    const rollbackThread = (threadId: ThreadId, _numTurns: number) =>
      unsupported(threadId, "rollbackThread").pipe(
        Effect.map(() => ({ threadId, turns: [] })),
        Effect.mapError(
          (cause) => cause as ProviderAdapterRequestError | ProviderAdapterSessionNotFoundError,
        ),
      );
    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "in-session", supportsConversationRollback: false },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest: () => Effect.void,
      respondToUserInput: () => Effect.void,
      stopSession,
      listSessions: () =>
        Effect.succeed([...sessions.values()].map(({ session }) => ({ ...session }))),
      hasSession: (threadId: ThreadId) => Effect.succeed(sessions.has(threadId)),
      readThread: (threadId: ThreadId) =>
        requireSession(threadId).pipe(Effect.map(() => ({ threadId, turns: [] }))),
      rollbackThread,
      stopAll: () => Effect.forEach([...sessions.keys()], stopSession, { discard: true }),
      streamEvents: Stream.fromPubSub(eventBus),
    } satisfies ProviderAdapterShape<
      | ProviderAdapterRequestError
      | ProviderAdapterValidationError
      | ProviderAdapterSessionNotFoundError
    >;
  });
}

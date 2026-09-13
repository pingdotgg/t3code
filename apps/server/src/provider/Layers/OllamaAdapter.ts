import * as NodeCrypto from "node:crypto";
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
import * as DateTime from "effect/DateTime";
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
const decodeOllamaJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const decodeOllamaStreamChunk = Schema.decodeUnknownSync(
  Schema.Struct({
    message: Schema.optional(Schema.Struct({ content: Schema.optional(Schema.String) })),
  }),
);
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
    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const makeEventStamp = () =>
      Effect.all({
        eventId: Effect.sync(() => EventId.make(NodeCrypto.randomUUID())),
        createdAt: nowIso,
      });
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
    const finishTurn = (
      context: Context,
      turnId: TurnId,
      state: "completed" | "cancelled" | "failed",
      errorMessage?: string,
    ) =>
      Effect.gen(function* () {
        if (context.stopped || context.session.activeTurnId !== turnId) return;
        delete context.controller;
        const { activeTurnId: _activeTurnId, ...sessionWithoutActiveTurn } = context.session;
        context.session = {
          ...sessionWithoutActiveTurn,
          status: state === "failed" ? "error" : "ready",
          updatedAt: yield* nowIso,
          ...(errorMessage ? { lastError: errorMessage } : { lastError: undefined }),
        };
        yield* PubSub.publish(eventBus, {
          type: "turn.completed",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: context.session.threadId,
          turnId,
          payload:
            state === "failed"
              ? { state, errorMessage: errorMessage ?? "Ollama request failed." }
              : { state, stopReason: state === "cancelled" ? "cancelled" : "stop" },
        } as ProviderRuntimeEvent);
      });
    const stopContext = (context: Context) =>
      Effect.gen(function* () {
        if (context.stopped) return;
        context.stopped = true;
        context.controller?.abort();
        delete context.controller;
        sessions.delete(context.session.threadId);
        yield* PubSub.publish(eventBus, {
          type: "session.exited",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: context.session.threadId,
          payload: { exitKind: "graceful" },
        } as ProviderRuntimeEvent);
      });
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
        if (input.providerInstanceId !== undefined && input.providerInstanceId !== instanceId)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Ollama session is bound to instance '${input.providerInstanceId}', expected '${instanceId}'.`,
          });
        if (
          input.modelSelection?.instanceId !== undefined &&
          input.modelSelection.instanceId !== instanceId
        )
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "startSession",
            issue: `Ollama model selection is bound to instance '${input.modelSelection.instanceId}', expected '${instanceId}'.`,
          });
        const existing = sessions.get(input.threadId);
        if (existing) yield* stopContext(existing);
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
          createdAt: yield* nowIso,
          updatedAt: yield* nowIso,
        };
        sessions.set(input.threadId, { session, messages: [], stopped: false });
        yield* PubSub.publish(eventBus, {
          type: "session.started",
          ...(yield* makeEventStamp()),
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
        if (
          input.modelSelection?.instanceId !== undefined &&
          input.modelSelection.instanceId !== instanceId
        )
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: `Ollama model selection is bound to instance '${input.modelSelection.instanceId}', expected '${instanceId}'.`,
          });
        const text = input.input?.trim();
        if (!text)
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "Turn requires non-empty text.",
          });
        const turnId = TurnId.make(NodeCrypto.randomUUID());
        const model =
          input.modelSelection?.model?.trim() ||
          context.session.model ||
          settings.defaultModel.trim() ||
          "llama3.2";
        const previousTurnId =
          context.session.status === "running" ? context.session.activeTurnId : undefined;
        context.messages.push({ role: "user", content: text });
        context.controller?.abort();
        if (previousTurnId) yield* finishTurn(context, previousTurnId, "cancelled");
        // @effect-diagnostics-next-line abortControllerInEffect:off -- Detached turns need an externally abortable request controller.
        const controller = new AbortController();
        context.controller = controller;
        context.session = {
          ...context.session,
          status: "running",
          activeTurnId: turnId,
          model,
          updatedAt: yield* nowIso,
        };
        yield* PubSub.publish(eventBus, {
          type: "turn.started",
          ...(yield* makeEventStamp()),
          provider: PROVIDER,
          threadId: input.threadId,
          turnId,
          payload: { model },
        } as ProviderRuntimeEvent);
        const runTurn = Effect.gen(function* () {
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
          const processLine = (line: string) =>
            Effect.gen(function* () {
              if (!line.trim() || context.stopped || context.session.activeTurnId !== turnId)
                return;
              const chunk = yield* Effect.try({
                try: () => decodeOllamaStreamChunk(decodeOllamaJson(line)),
                catch: (cause) => requestError("/api/chat", "Invalid Ollama stream chunk.", cause),
              });
              const delta = chunk.message?.content ?? "";
              if (!delta) return;
              assistant += delta;
              yield* PubSub.publish(eventBus, {
                type: "content.delta",
                ...(yield* makeEventStamp()),
                provider: PROVIDER,
                threadId: input.threadId,
                turnId,
                payload: { streamKind: "assistant_text", delta },
              } as ProviderRuntimeEvent);
            });
          while (true) {
            const result = yield* Effect.tryPromise({
              try: () => reader.read(),
              catch: (cause) => requestError("/api/chat", "Failed reading Ollama stream.", cause),
            });
            if (result.done) break;
            buffer += decoder.decode(result.value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() ?? "";
            for (const line of lines) yield* processLine(line);
          }
          buffer += decoder.decode();
          yield* processLine(buffer);
          if (!context.stopped && context.session.activeTurnId === turnId) {
            context.messages.push({ role: "assistant", content: assistant });
            yield* finishTurn(context, turnId, "completed");
          }
        }).pipe(
          Effect.tapError((cause) =>
            finishTurn(
              context,
              turnId,
              controller.signal.aborted ? "cancelled" : "failed",
              controller.signal.aborted
                ? undefined
                : cause instanceof Error
                  ? cause.message
                  : String(cause),
            ),
          ),
          Effect.onInterrupt(() => finishTurn(context, turnId, "cancelled")),
          Effect.ensuring(
            Effect.sync(() => {
              controller.abort();
            }),
          ),
        );
        yield* runTurn.pipe(Effect.ignore, Effect.forkDetach);
        return { threadId: input.threadId, turnId } as ProviderTurnStartResult;
      });
    const interruptTurn = (threadId: ThreadId, turnId?: TurnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const activeTurnId = context.session.activeTurnId;
        if (turnId !== undefined && turnId !== activeTurnId) return;
        context.controller?.abort();
        if (activeTurnId) yield* finishTurn(context, activeTurnId, "cancelled");
      });
    const stopSession = (threadId: ThreadId) =>
      Effect.flatMap(requireSession(threadId), stopContext).pipe(Effect.asVoid);
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

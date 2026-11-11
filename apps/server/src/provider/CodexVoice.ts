/** Thread-scoped WebRTC signaling; audio stays between the client and OpenAI.
 * Client handoffs start Codex turns, then append their final answer to live speech. */
import type { ProviderVoiceSessionEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type * as CodexClient from "effect-codex-app-server/client";
import type * as CodexErrors from "effect-codex-app-server/errors";

const DELEGATION_OPEN = "<realtime_delegation>";
const DELEGATION_CLOSE = "</realtime_delegation>";
// Codex rejects speech over 1,000 tokens and may add its own prefix.
const MAX_SPEAKABLE_CHARS = 990 * 4;

function unescapeXmlText(text: string): string {
  return text.replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&");
}

/** The spoken request inside a Codex realtime delegation message, if `text` is one. */
export function readRealtimeDelegationInput(text: string): string | undefined {
  const trimmed = text.trim();
  if (!trimmed.startsWith(DELEGATION_OPEN) || !trimmed.endsWith(DELEGATION_CLOSE)) {
    return undefined;
  }
  const match = /<input>([\s\S]*?)<\/input>/.exec(trimmed);
  const input = match?.[1] ? unescapeXmlText(match[1]).trim() : "";
  return input.length > 0 ? input : undefined;
}

/** Reads the delegation input from a Codex `userMessage` item. */
export function readRealtimeDelegationFromItem(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as { type?: unknown; content?: unknown };
  if (record.type !== "userMessage" || !Array.isArray(record.content)) return undefined;
  const [only, ...rest] = record.content as ReadonlyArray<{ type?: unknown; text?: unknown }>;
  if (rest.length > 0 || only?.type !== "text" || typeof only.text !== "string") return undefined;
  return readRealtimeDelegationInput(only.text);
}

/**
 * Text worth speaking from a completed `agentMessage`. Commentary stays private
 * to the voice handoff, and oversized answers stay on screen only.
 */
export function readSpeakableAnswer(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as { type?: unknown; text?: unknown; phase?: unknown; questions?: unknown };
  if (record.type !== "agentMessage" || typeof record.text !== "string") return undefined;
  if (
    record.phase === "commentary" ||
    record.phase === "partial_answer" ||
    (Array.isArray(record.questions) && record.questions.length)
  )
    return undefined;
  const text = record.text.trim();
  if (
    record.phase !== "final_answer" &&
    (text.startsWith("[ANALYSIS]") || text.startsWith("[COMMENTARY]"))
  ) {
    return undefined;
  }
  const spoken = text.replace(/^\[FINAL\]\s*/, "");
  if (spoken.length === 0 || spoken.length > MAX_SPEAKABLE_CHARS) return undefined;
  return spoken;
}

function transcriptRole(role: string): "user" | "assistant" {
  return role === "user" ? "user" : "assistant";
}

/** Codex ended the realtime session with an error; `detail` is Codex's explanation for the user. */
export class CodexVoiceSessionError extends Schema.TaggedError<CodexVoiceSessionError>()(
  "CodexVoiceSessionError",
  { detail: Schema.String },
) {
  override get message(): string {
    return this.detail;
  }
}

type VoiceQueue = Queue.Queue<ProviderVoiceSessionEvent, CodexVoiceSessionError | Cause.Done>;

interface ActiveVoice {
  readonly providerThreadId: string;
  readonly queue: VoiceQueue;
  readonly stopConfirmed: Deferred.Deferred<void>;
  readonly delegatedTurns: Map<string, { readonly messageId?: string; answer: string | undefined }>;
  /** Handoff message identities survive native retries until successful completion. */
  readonly expectedHandoffs: Set<string>;
  closed: boolean;
  stopped: boolean;
}

export interface CodexVoiceStartInput {
  readonly providerThreadId: string;
  readonly offerSdp: string;
  readonly voice?: string | undefined;
}

export const makeCodexVoice = Effect.fn("makeCodexVoice")(function* (
  client: CodexClient.CodexAppServerClient["Service"],
  /** Outlives notification handlers, which must not block on requests. */
  runtimeScope: Scope.Scope,
) {
  const activeRef = yield* Ref.make<ActiveVoice | undefined>(undefined);
  const transition = yield* Semaphore.make(1);

  const withActive = (
    threadId: string,
    f: (active: ActiveVoice) => Effect.Effect<void, never>,
  ): Effect.Effect<void, never> =>
    Effect.flatMap(Ref.get(activeRef), (active) =>
      active && !active.closed && active.providerThreadId === threadId ? f(active) : Effect.void,
    );

  const offer = (active: ActiveVoice, event: ProviderVoiceSessionEvent) =>
    Queue.offer(active.queue, event).pipe(Effect.asVoid);

  const finish = (active: ActiveVoice, event: ProviderVoiceSessionEvent) =>
    Effect.suspend(() => {
      active.closed = true;
      return offer(active, event).pipe(Effect.andThen(Queue.end(active.queue)), Effect.asVoid);
    });

  yield* client.handleServerNotification("thread/realtime/started", (payload) =>
    withActive(payload.threadId, (active) => offer(active, { type: "started" })),
  );
  yield* client.handleServerNotification("thread/realtime/sdp", (payload) =>
    withActive(payload.threadId, (active) => offer(active, { type: "answer", sdp: payload.sdp })),
  );
  yield* client.handleServerNotification("thread/realtime/transcript/delta", (payload) =>
    withActive(payload.threadId, (active) =>
      offer(active, {
        type: "transcript.delta",
        role: transcriptRole(payload.role),
        delta: payload.delta,
      }),
    ),
  );
  yield* client.handleServerNotification("thread/realtime/transcript/done", (payload) =>
    withActive(payload.threadId, (active) =>
      offer(active, {
        type: "transcript.done",
        role: transcriptRole(payload.role),
        text: payload.text,
      }),
    ),
  );
  yield* client.handleServerNotification("thread/realtime/error", (payload) =>
    withActive(payload.threadId, (active) =>
      Effect.suspend(() => {
        active.closed = true;
        return Queue.fail(active.queue, new CodexVoiceSessionError({ detail: payload.message }));
      }).pipe(Effect.asVoid),
    ),
  );
  yield* client.handleServerNotification("thread/realtime/closed", (payload) =>
    Effect.flatMap(Ref.get(activeRef), (active) => {
      if (!active || active.providerThreadId !== payload.threadId) return Effect.void;
      active.stopped = true;
      return Deferred.succeed(active.stopConfirmed, undefined).pipe(
        Effect.andThen(
          active.closed
            ? Effect.void
            : finish(active, {
                type: "closed",
                ...(payload.reason ? { reason: payload.reason } : {}),
              }),
        ),
      );
    }),
  );

  yield* client.handleServerNotification("item/started", (payload) =>
    withActive(payload.threadId, (active) =>
      Effect.sync(() => {
        if (readRealtimeDelegationFromItem(payload.item) !== undefined) {
          if (!active.delegatedTurns.has(payload.turnId)) {
            active.delegatedTurns.set(payload.turnId, { answer: undefined });
          }
          return;
        }
      }),
    ),
  );
  yield* client.handleServerNotification("item/completed", (payload) =>
    withActive(payload.threadId, (active) =>
      Effect.sync(() => {
        const delegatedTurn = active.delegatedTurns.get(payload.turnId);
        if (delegatedTurn === undefined) return;
        const answer = readSpeakableAnswer(payload.item);
        if (answer !== undefined) delegatedTurn.answer = answer;
      }),
    ),
  );
  yield* client.handleServerNotification("turn/completed", (payload) =>
    withActive(payload.threadId, (active) =>
      Effect.suspend(() => {
        const delegatedTurn = active.delegatedTurns.get(payload.turn.id);
        active.delegatedTurns.delete(payload.turn.id);
        if (payload.turn.status !== "completed") return Effect.void;
        if (delegatedTurn?.messageId !== undefined) {
          active.expectedHandoffs.delete(delegatedTurn.messageId);
        }
        const answer = delegatedTurn?.answer;
        if (answer === undefined) return Effect.void;
        return transition
          .withPermit(
            Ref.get(activeRef).pipe(
              Effect.flatMap((current) =>
                current === active && !active.closed
                  ? client.raw
                      .request("thread/realtime/appendSpeech", {
                        threadId: active.providerThreadId,
                        text: answer,
                      })
                      .pipe(
                        Effect.timeoutOrElse({
                          duration: "10 seconds",
                          orElse: () =>
                            Effect.suspend(() => {
                              active.closed = true;
                              return Queue.fail(
                                active.queue,
                                new CodexVoiceSessionError({
                                  detail:
                                    "Codex did not acknowledge speech; ending the voice session.",
                                }),
                              ).pipe(Effect.asVoid);
                            }),
                        }),
                      )
                  : Effect.void,
              ),
            ),
          )
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Codex voice could not speak the delegated answer", { cause }),
            ),
            Effect.forkIn(runtimeScope),
            Effect.asVoid,
          );
      }),
    ),
  );

  const stop = Effect.fn("CodexVoice.stop")(function* (active: ActiveVoice) {
    if ((yield* Ref.get(activeRef)) !== active) return;
    active.closed = true;
    if (!active.stopped) {
      // A timed-out append may already be queued; stop confirmation is the replacement barrier.
      yield* Effect.raceFirst(
        client.raw.request("thread/realtime/stop", { threadId: active.providerThreadId }),
        Deferred.await(active.stopConfirmed),
      ).pipe(
        Effect.timeoutOrElse({
          duration: "10 seconds",
          orElse: () =>
            Effect.fail(
              new CodexVoiceSessionError({
                detail: "Codex did not confirm voice cleanup; retry after the session closes.",
              }),
            ),
        }),
      );
      active.stopped = true;
    }
    yield* Ref.set(activeRef, undefined);
  });

  /**
   * Starts a voice conversation. The stream ends when Codex closes the
   * session; interrupting it (client unsubscribe or disconnect) stops it.
   */
  const start = (
    input: CodexVoiceStartInput,
    onAcquired: Effect.Effect<void> = Effect.void,
  ): Stream.Stream<
    ProviderVoiceSessionEvent,
    CodexVoiceSessionError | CodexErrors.CodexAppServerError
  > =>
    Stream.unwrap(
      Effect.gen(function* () {
        const queue: VoiceQueue = yield* Queue.unbounded<
          ProviderVoiceSessionEvent,
          CodexVoiceSessionError | Cause.Done
        >();
        const active: ActiveVoice = {
          providerThreadId: input.providerThreadId,
          queue,
          stopConfirmed: yield* Deferred.make<void>(),
          delegatedTurns: new Map(),
          expectedHandoffs: new Set(),
          closed: false,
          stopped: false,
        };
        yield* Effect.addFinalizer(() =>
          transition
            .withPermit(stop(active))
            .pipe(
              Effect.catch((cause) =>
                Effect.logWarning("Codex voice could not stop the realtime session", { cause }),
              ),
            ),
        );
        yield* transition.withPermit(
          Effect.uninterruptibleMask((restore) =>
            Effect.gen(function* () {
              const previous = yield* Ref.get(activeRef);
              if (previous) {
                // The adapter supports one conversation per provider session, across native threads.
                if (!previous.closed)
                  yield* finish(previous, { type: "closed", reason: "replaced" });
                yield* restore(stop(previous));
              }
              yield* Ref.set(activeRef, active);
              yield* onAcquired;
              yield* restore(
                client.raw.request("thread/realtime/start", {
                  threadId: input.providerThreadId,
                  outputModality: "audio",
                  transport: { type: "webrtc", sdp: input.offerSdp },
                  version: "v3",
                  clientManagedHandoffs: true,
                  includeStartupContext: false,
                  ...(input.voice ? { voice: input.voice } : {}),
                }),
              );
            }),
          ),
        );
        return Stream.fromQueue(queue);
      }),
    );

  /** Registers the app message identity before its continuation is queued. */
  const expectSpokenTurn = (messageId: string) =>
    Effect.map(Ref.get(activeRef), (active) => {
      if (active && !active.closed) active.expectedHandoffs.add(messageId);
    });

  const registerTurn = (messageId: string, turnId: string) =>
    Effect.map(Ref.get(activeRef), (active) => {
      if (active && !active.closed && active.expectedHandoffs.has(messageId)) {
        active.delegatedTurns.set(turnId, { messageId, answer: undefined });
      }
    });

  return { start, expectSpokenTurn, registerTurn };
});

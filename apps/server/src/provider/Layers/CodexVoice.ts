/**
 * Codex voice conversations: a thread-scoped realtime session whose audio runs
 * over WebRTC between the client and OpenAI. The app-server only relays the
 * SDP handshake, captions, and lifecycle; this module owns that signaling.
 *
 * Handoffs are client-managed, matching the Codex TUI: the realtime model
 * delegates work by starting a Codex turn whose user message is wrapped in
 * `<realtime_delegation>`, and when that turn finishes we hand its final
 * answer back with `thread/realtime/appendSpeech` so the voice reads it out.
 */
import type { ProviderVoiceSessionEvent } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
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

function readUserMessageText(item: unknown): string | undefined {
  if (!item || typeof item !== "object") return undefined;
  const record = item as { type?: unknown; content?: unknown };
  if (record.type !== "userMessage" || !Array.isArray(record.content)) return undefined;
  return (record.content as ReadonlyArray<{ type?: unknown; text?: unknown }>)
    .flatMap((entry) =>
      entry.type === "text" && typeof entry.text === "string" ? [entry.text] : [],
    )
    .join("\n");
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
  if (record.phase === "commentary" || (Array.isArray(record.questions) && record.questions.length))
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
  /** Delegated turn id -> latest speakable answer in that turn. */
  readonly delegatedTurns: Map<string, string | undefined>;
  /** Handoffs resubmitted as ordinary runs, awaiting their native turn. */
  readonly expectedHandoffs: Array<string>;
  closed: boolean;
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
    withActive(payload.threadId, (active) =>
      finish(active, { type: "closed", ...(payload.reason ? { reason: payload.reason } : {}) }),
    ),
  );

  yield* client.handleServerNotification("item/started", (payload) =>
    withActive(payload.threadId, (active) =>
      Effect.sync(() => {
        if (readRealtimeDelegationFromItem(payload.item) !== undefined) {
          active.delegatedTurns.set(payload.turnId, undefined);
          return;
        }
        const text = readUserMessageText(payload.item);
        const expectedIndex =
          text === undefined
            ? -1
            : active.expectedHandoffs.findIndex((expected) => text.includes(expected));
        if (expectedIndex !== -1) {
          active.expectedHandoffs.splice(expectedIndex, 1);
          active.delegatedTurns.set(payload.turnId, undefined);
        }
      }),
    ),
  );
  yield* client.handleServerNotification("item/completed", (payload) =>
    withActive(payload.threadId, (active) =>
      Effect.sync(() => {
        if (!active.delegatedTurns.has(payload.turnId)) return;
        const answer = readSpeakableAnswer(payload.item);
        if (answer !== undefined) active.delegatedTurns.set(payload.turnId, answer);
      }),
    ),
  );
  yield* client.handleServerNotification("turn/completed", (payload) =>
    withActive(payload.threadId, (active) =>
      Effect.suspend(() => {
        const answer = active.delegatedTurns.get(payload.turn.id);
        active.delegatedTurns.delete(payload.turn.id);
        if (answer === undefined || payload.turn.status !== "completed") return Effect.void;
        return client.raw
          .request("thread/realtime/appendSpeech", {
            threadId: active.providerThreadId,
            text: answer,
          })
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

  const stop = (active: ActiveVoice) =>
    Effect.gen(function* () {
      yield* Ref.update(activeRef, (current) => (current === active ? undefined : current));
      if (active.closed) return;
      active.closed = true;
      yield* client.raw
        .request("thread/realtime/stop", { threadId: active.providerThreadId })
        .pipe(Effect.ignore);
    });

  /**
   * Starts a voice conversation. The stream ends when Codex closes the
   * session; interrupting it (client unsubscribe or disconnect) stops it.
   */
  const start = (
    input: CodexVoiceStartInput,
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
          delegatedTurns: new Map(),
          expectedHandoffs: [],
          closed: false,
        };
        const previous = yield* Ref.getAndSet(activeRef, active);
        if (previous && !previous.closed) {
          // One conversation per thread: a newer client takes over.
          yield* finish(previous, { type: "closed", reason: "replaced" });
          yield* client.raw
            .request("thread/realtime/stop", { threadId: previous.providerThreadId })
            .pipe(Effect.ignore);
        }
        yield* Effect.addFinalizer(() => stop(active));
        yield* client.raw.request("thread/realtime/start", {
          threadId: input.providerThreadId,
          outputModality: "audio",
          transport: { type: "webrtc", sdp: input.offerSdp },
          version: "v3",
          clientManagedHandoffs: true,
          includeStartupContext: false,
          ...(input.voice ? { voice: input.voice } : {}),
        });
        return Stream.fromQueue(queue);
      }),
    );

  /**
   * Marks the next turn whose user message carries `text` as a voice handoff,
   * for hosts that resubmit Codex's delegation as their own run.
   */
  const expectSpokenTurn = (text: string) =>
    Effect.map(Ref.get(activeRef), (active) => {
      if (active && !active.closed) active.expectedHandoffs.push(text);
    });

  return { start, expectSpokenTurn };
});

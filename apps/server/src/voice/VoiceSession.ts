import * as NodeCrypto from "node:crypto";
import WebSocket from "ws";
import { VoiceError, type OrchestrationEvent, type ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import {
  buildDelegationPrompt,
  buildLiveSessionRequest,
  buildLiveSidebandUrl,
  buildLiveUpdate,
  parseLiveServerEvent,
  parseLiveSessionResponse,
  type LiveTranscriptDelta,
} from "./liveProtocol.ts";

interface VoiceConnection {
  send: (event: unknown) => void;
  close: () => void;
}

export interface VoiceTransport {
  create: (
    sdp: string,
    context: string,
    signal: AbortSignal,
  ) => Promise<{
    sessionId: string;
    sdp: string;
  }>;
  connect: (
    sessionId: string,
    onEvent: (event: unknown) => void,
    onClose: () => void,
  ) => Promise<VoiceConnection>;
  hangup: (sessionId: string) => Promise<boolean>;
}

/** All credentials are read at call time on the environment host. */
export function makeVoiceTransport(client: HttpClient.HttpClient): VoiceTransport {
  const apiKey = () => {
    const key = process.env.OPENAI_API_KEY?.trim();
    if (!key) throw new Error("Set OPENAI_API_KEY on this T3 server to use live voice.");
    return key;
  };
  return {
    async create(sdp, context, signal) {
      const request = HttpClientRequest.post("https://api.openai.com/v1/live/sessions").pipe(
        HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey()}`),
        HttpClientRequest.bodyJsonUnsafe(buildLiveSessionRequest({ sdp, context })),
      );
      const response = await Effect.runPromise(
        Effect.gen(function* () {
          const response = yield* client
            .execute(request)
            .pipe(
              Effect.mapError(
                () => new VoiceError({ message: "Could not reach OpenAI live voice." }),
              ),
            );
          if (response.status < 200 || response.status >= 300) {
            return yield* Effect.fail(
              new VoiceError({
                message: `OpenAI could not start live voice (HTTP ${response.status}).`,
              }),
            );
          }
          return yield* response.json.pipe(
            Effect.mapError(
              () => new VoiceError({ message: "OpenAI returned an invalid live voice session." }),
            ),
          );
        }).pipe(Effect.scoped, Effect.timeout("30 seconds")),
        { signal },
      );
      const result = parseLiveSessionResponse(response);
      if (!result) throw new Error("OpenAI returned an invalid live voice session.");
      return { sessionId: result.session.id, sdp: result.transport.sdp };
    },
    connect(sessionId, onEvent, onClose) {
      return new Promise((resolve, reject) => {
        const socket = new WebSocket(buildLiveSidebandUrl(sessionId), {
          headers: { Authorization: `Bearer ${apiKey()}` },
          handshakeTimeout: 15_000,
        });
        socket.on("message", (data) => {
          try {
            onEvent(JSON.parse(data.toString()));
          } catch {
            // Malformed upstream messages never reach command dispatch.
          }
        });
        socket.once("open", () =>
          resolve({
            send: (event) => {
              if (socket.readyState !== WebSocket.OPEN) throw new Error("Voice connection closed.");
              socket.send(JSON.stringify(event));
            },
            close: () => socket.close(),
          }),
        );
        socket.on("error", () => reject(new Error("Could not connect to live voice.")));
        socket.once("close", () => {
          reject(new Error("Live voice connection closed before opening."));
          onClose();
        });
      });
    },
    async hangup(sessionId) {
      // The reference describes SIP here; treat a failed WebRTC hangup as
      // unconfirmed cleanup, never as proof that billing or media ended.
      const request = HttpClientRequest.post(
        `https://api.openai.com/v1/live/sessions/${encodeURIComponent(sessionId)}/hangup`,
      ).pipe(HttpClientRequest.setHeader("Authorization", `Bearer ${apiKey()}`));
      return Effect.runPromise(
        client.execute(request).pipe(
          Effect.map((response) => response.status >= 200 && response.status < 300),
          Effect.scoped,
          Effect.timeout("5 seconds"),
        ),
      );
    },
  };
}

interface VoiceSessionDependencies {
  readonly transport: VoiceTransport;
  readonly context: (threadId: ThreadId) => Promise<string>;
  readonly dispatch: (
    threadId: ThreadId,
    delegationId: string,
    prompt: string,
    signal: AbortSignal,
  ) => Promise<void>;
}

interface Call {
  readonly threadId: ThreadId;
  readonly abort: AbortController;
  sessionId?: string;
  connection?: VoiceConnection;
  stopped: boolean;
  closed: boolean;
  resolveClosed: () => void;
  readonly didClose: Promise<void>;
  readonly transcript: LiveTranscriptDelta[];
  readonly delegations: Set<string>;
  delegationId?: string;
  readonly assistantMessages: Map<string, string>;
  work: Promise<void>;
  stopping?: Promise<void>;
  lastStatus?: string;
}

/** One instance belongs to one authenticated RPC socket, never the whole server. */
export function makeVoiceSession(dependencies: VoiceSessionDependencies) {
  let call: Call | undefined;
  let disposed = false;
  let unconfirmedSessionId: string | undefined;

  const retryUnconfirmedSession = async () => {
    const sessionId = unconfirmedSessionId;
    if (!sessionId) return;
    if (!(await dependencies.transport.hangup(sessionId).catch(() => false))) {
      throw new Error("OpenAI did not confirm the previous voice session ended. Please try again.");
    }
    if (unconfirmedSessionId === sessionId) unconfirmedSessionId = undefined;
  };

  const send = (active: Call, event: unknown) => {
    if (!active.stopped && !active.closed) active.connection?.send(event);
  };
  const append = (
    active: Call,
    content: string,
    kind: "thinking" | "commentary",
    delegationId: string | null = active.delegationId ?? null,
  ) => {
    send(
      active,
      buildLiveUpdate({
        kind,
        eventId: NodeCrypto.randomUUID(),
        delegationId,
        content,
      }),
    );
  };
  const stopCall = (active: Call): Promise<void> => {
    if (active.stopping) return active.stopping;
    active.stopped = true;
    active.abort.abort();
    active.stopping = Promise.resolve().then(async () => {
      try {
        if (active.connection && !active.closed) {
          try {
            active.connection.send({ type: "session.close", event_id: NodeCrypto.randomUUID() });
            await Effect.runPromise(
              Effect.promise(() => active.didClose).pipe(Effect.timeoutOption("3 seconds")),
            );
          } catch {
            // Losing the sideband does not close independent WebRTC media.
            // Still attempt the server hangup below when sending close fails.
          }
        }
        if (!active.closed && active.sessionId) {
          const confirmed = await dependencies.transport
            .hangup(active.sessionId)
            .catch(() => false);
          if (!confirmed) {
            unconfirmedSessionId = active.sessionId;
            throw new Error(
              "Voice media was released, but OpenAI did not confirm the session ended.",
            );
          }
        }
      } finally {
        active.connection?.close();
        if (call === active) call = undefined;
        active.transcript.length = 0;
        active.assistantMessages.clear();
      }
    });
    return active.stopping;
  };
  const enqueue = (active: Call, work: () => Promise<void>) => {
    active.work = active.work
      .then(async () => {
        if (active.stopped || active.closed) return;
        await work();
      })
      .catch(() => {
        // Never forward arbitrary provider errors, which can contain local data.
        try {
          append(
            active,
            "The coding request could not be completed. Check the thread for details.",
            "commentary",
          );
        } catch {
          void stopCall(active).catch(() => undefined);
        }
      });
  };
  const receive = (active: Call, value: unknown) => {
    const event = parseLiveServerEvent(value);
    if (!event) return;
    if (event.type === "session.closed") {
      active.closed = true;
      active.resolveClosed();
      if (!active.stopped) void stopCall(active).catch(() => undefined);
      return;
    }
    if (active.stopped) return;
    if (
      event.type === "session.input_transcript.delta" ||
      event.type === "session.output_transcript.delta"
    ) {
      if (active.transcript.some((item) => item.event_id === event.event_id)) return;
      active.transcript.push(event);
      // Recent exact fragments retain their time offsets for delegation snapshots.
      while (active.transcript.length > 256) active.transcript.shift();
      while (
        active.transcript.reduce(
          (bytes, fragment) => bytes + Buffer.byteLength(fragment.delta),
          0,
        ) > 32_000
      )
        active.transcript.shift();
    } else if (event.type === "error") {
      void stopCall(active).catch(() => undefined);
    } else if (event.type === "session.delegation.created") {
      if (active.delegations.has(event.delegation.id)) return;
      active.delegations.add(event.delegation.id);
      const transcript = [...active.transcript];
      enqueue(active, async () => {
        const context = await dependencies.context(active.threadId);
        if (active.stopped || active.closed) return;
        const prompt = buildDelegationPrompt({ transcript, offsetMs: event.offset_ms, context });
        if (
          !transcript.some(
            (fragment) =>
              fragment.type === "session.input_transcript.delta" &&
              fragment.start_ms <= event.offset_ms,
          )
        ) {
          active.delegationId = event.delegation.id;
          append(active, "I did not receive the spoken request. Please repeat it.", "commentary");
          return;
        }
        active.delegationId = event.delegation.id;
        await dependencies.dispatch(
          active.threadId,
          event.delegation.id,
          prompt,
          active.abort.signal,
        );
        append(
          active,
          "The instruction was submitted to the coding agent. Work and any permission requests remain in the current thread.",
          "thinking",
        );
      });
    }
  };

  return {
    async start(input: { threadId: ThreadId; sdp: string }, signal?: AbortSignal) {
      if (disposed) throw new Error("Voice connection closed.");
      if (unconfirmedSessionId) await retryUnconfirmedSession();
      // Cleanup can await the network; the socket may close or another start win meanwhile.
      if (disposed) throw new Error("Voice connection closed.");
      if (call) throw new Error("A voice call is already active on this connection.");
      let resolveClosed = () => {};
      const didClose = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const active: Call = {
        threadId: input.threadId,
        abort: new AbortController(),
        stopped: false,
        closed: false,
        resolveClosed,
        didClose,
        transcript: [],
        delegations: new Set(),
        assistantMessages: new Map(),
        work: Promise.resolve(),
      };
      call = active;
      const cancel = () => {
        void stopCall(active).catch(() => undefined);
      };
      signal?.addEventListener("abort", cancel, { once: true });
      try {
        if (signal?.aborted) throw new Error("Voice start cancelled.");
        const context = await dependencies.context(input.threadId);
        if (active.stopped) throw new Error("Voice start cancelled.");
        const result = await dependencies.transport.create(input.sdp, context, active.abort.signal);
        active.sessionId = result.sessionId;
        active.connection = await dependencies.transport.connect(
          result.sessionId,
          (event) => receive(active, event),
          () => {
            active.resolveClosed();
            void stopCall(active).catch(() => undefined);
          },
        );
        if (active.stopped || active.closed || disposed) {
          // A late handshake still owns an upstream session; close it before returning.
          delete active.stopping;
          await stopCall(active);
          throw new Error("Voice start cancelled.");
        }
        return result;
      } catch (error) {
        await stopCall(active);
        throw error;
      } finally {
        signal?.removeEventListener("abort", cancel);
      }
    },
    async stop(sessionId: string) {
      if (unconfirmedSessionId === sessionId) {
        await retryUnconfirmedSession();
        return;
      }
      if (!call) return;
      if (call.sessionId !== sessionId)
        throw new Error("This voice session belongs to another connection.");
      await stopCall(call);
    },
    observe(event: OrchestrationEvent) {
      const active = call;
      if (!active || active.stopped || event.aggregateId !== active.threadId) return;
      if (event.type === "thread.deleted" || event.type === "thread.archived") {
        void stopCall(active).catch(() => undefined);
      } else if (event.type === "thread.message-sent" && event.payload.role === "assistant") {
        const { messageId, text, streaming } = event.payload;
        const combined = `${active.assistantMessages.get(messageId) ?? ""}${text}`.slice(-8_000);
        if (streaming) {
          active.assistantMessages.set(messageId, combined);
          if (active.assistantMessages.size > 16)
            active.assistantMessages.delete(active.assistantMessages.keys().next().value!);
        } else {
          active.assistantMessages.delete(messageId);
          if (combined.trim())
            enqueue(active, async () => {
              append(active, `Coding agent update in this thread: ${combined}`, "commentary", null);
            });
        }
      } else if (
        event.type === "thread.activity-appended" &&
        (event.payload.activity.kind === "approval.requested" ||
          event.payload.activity.kind === "user-input.requested")
      ) {
        enqueue(active, async () => {
          append(
            active,
            "The coding agent needs your input. Review the request in the thread; voice cannot approve it.",
            "commentary",
            null,
          );
        });
      } else if (event.type === "thread.session-set") {
        const status = event.payload.session.status;
        if (active.lastStatus !== status) {
          active.lastStatus = status;
          enqueue(active, async () => {
            append(active, `Current coding agent session status: ${status}.`, "thinking", null);
          });
        }
      }
    },
    async dispose() {
      disposed = true;
      if (call) await stopCall(call);
      await retryUnconfirmedSession();
    },
    /** Wait for callbacks already received, used by focused lifecycle tests. */
    drain: () => call?.work ?? Promise.resolve(),
  };
}

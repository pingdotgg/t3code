import {
  SPEECH_STREAM_MAX_CHUNK_BYTES,
  SPEECH_STREAM_MAX_QUEUED_BYTES,
  SpeechStreamEvent,
  type SpeechStreamText,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeEvent = Schema.decodeUnknownSync(Schema.fromJsonString(SpeechStreamEvent));

/** Audio stays bounded while the environment acknowledges one chunk at a time. */
export async function openSpeechStream(input: {
  readonly url: string;
  readonly signal: AbortSignal;
  readonly onText: (text: SpeechStreamText) => void;
  readonly onError: (error: Error) => void;
  readonly createSocket?: (url: string) => WebSocket;
}) {
  input.signal.throwIfAborted();
  const socket = (input.createSocket ?? ((url) => new WebSocket(url)))(input.url);
  const ready = Promise.withResolvers<void>();
  const final = Promise.withResolvers<string>();
  // A capture failure can precede stop(), when nobody is awaiting the final result yet.
  void final.promise.catch(() => undefined);
  let queue: Uint8Array[] = [];
  let queuedBytes = 0;
  let inFlight = 0;
  let finishing = false;
  let finishSent = false;
  let closed = false;
  let isReady = false;
  let revision = -1;
  let timer: ReturnType<typeof setTimeout>;
  const cleanup = () => {
    clearTimeout(timer);
    input.signal.removeEventListener("abort", abort);
    queue = [];
    queuedBytes = 0;
  };
  const fail = (error: Error, notify = true) => {
    if (closed) return;
    closed = true;
    cleanup();
    ready.reject(error);
    final.reject(error);
    socket.close();
    if (notify && isReady) input.onError(error);
  };
  const armTimeout = () => {
    clearTimeout(timer);
    timer = setTimeout(() => fail(new Error("Live transcription stopped responding.")), 120_000);
  };
  const abort = () => fail(new Error("Voice transcription was cancelled."), false);
  const pump = () => {
    if (!isReady || closed || inFlight || finishSent) return;
    const chunk = queue.shift();
    if (chunk) {
      inFlight = chunk.byteLength;
      queuedBytes -= chunk.byteLength;
      socket.send(chunk);
      armTimeout();
    } else if (finishing) {
      finishSent = true;
      socket.send(JSON.stringify({ type: "finish" }));
      armTimeout();
    }
  };
  socket.addEventListener("message", (event) => {
    if (closed) return;
    try {
      const message = decodeEvent(event.data);
      switch (message.type) {
        case "ready":
          if (isReady) throw new Error("Unexpected speech stream response.");
          isReady = true;
          clearTimeout(timer);
          ready.resolve();
          break;
        case "update":
          if (!inFlight || message.revision < revision)
            throw new Error("Unexpected speech stream response.");
          revision = message.revision;
          inFlight = 0;
          clearTimeout(timer);
          if (message.text) input.onText(message.text);
          pump();
          break;
        case "finished":
          if (!finishSent) throw new Error("Unexpected speech stream response.");
          closed = true;
          cleanup();
          final.resolve(message.text);
          socket.close();
          break;
        case "error":
          fail(new Error(message.message));
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error("Invalid speech stream response."));
    }
  });
  socket.addEventListener("close", () =>
    fail(new Error("The voice connection closed. Please record again.")),
  );
  socket.addEventListener("error", () =>
    fail(new Error("Could not connect to live transcription.")),
  );
  input.signal.addEventListener("abort", abort, { once: true });
  armTimeout();
  if (input.signal.aborted) abort();
  await ready.promise;
  return {
    feed: (pcm: Float32Array) => {
      if (closed || finishing) return;
      const bytes = new Uint8Array(pcm.buffer, pcm.byteOffset, pcm.byteLength);
      if (queuedBytes + inFlight + bytes.byteLength > SPEECH_STREAM_MAX_QUEUED_BYTES) {
        fail(
          new Error(
            "This environment cannot keep up with live audio. Try a smaller streaming model.",
          ),
        );
        return;
      }
      for (let offset = 0; offset < bytes.length; offset += SPEECH_STREAM_MAX_CHUNK_BYTES) {
        const chunk = bytes.slice(offset, offset + SPEECH_STREAM_MAX_CHUNK_BYTES);
        queue.push(chunk);
        queuedBytes += chunk.length;
      }
      try {
        pump();
      } catch {
        fail(new Error("Could not send microphone audio."));
      }
    },
    finish: () => {
      finishing = true;
      try {
        pump();
      } catch {
        fail(new Error("Could not finish live transcription."));
      }
      return final.promise;
    },
    cancel: abort,
  };
}

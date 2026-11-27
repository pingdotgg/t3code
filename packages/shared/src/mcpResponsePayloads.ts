// @effect-diagnostics globalJsonInEffect:off
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const SSE_EVENT_SEPARATOR = /(?:\r\n|\r(?!\n)|\n){2}/u;
// A separator is at most four characters, so one that a new chunk completes starts within the
// last three characters already read. Scanning only those plus the chunk keeps parsing linear.
const SEPARATOR_OVERLAP = 3;

function sseEventData(rawEvent: string): string {
  return rawEvent
    .split(/\r\n|\r|\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice("data:".length).trimStart())
    .join("\n");
}

async function* sseDataLines(
  reader: ReadableStreamDefaultReader<Uint8Array>,
): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let eventParts: string[] = [];
  let unscanned = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return;
    let text = unscanned + decoder.decode(value, { stream: true });
    let separator = SSE_EVENT_SEPARATOR.exec(text);
    while (separator !== null) {
      eventParts.push(text.slice(0, separator.index));
      const data = sseEventData(eventParts.join(""));
      eventParts = [];
      text = text.slice(separator.index + separator[0].length);
      if (data.length > 0) yield data;
      separator = SSE_EVENT_SEPARATOR.exec(text);
    }
    const scannedLength = Math.max(0, text.length - SEPARATOR_OVERLAP);
    eventParts.push(text.slice(0, scannedLength));
    unscanned = text.slice(scannedLength);
  }
}

async function readText(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let text = "";
  while (true) {
    const { done, value } = await reader.read();
    if (done) return text + decoder.decode();
    text += decoder.decode(value, { stream: true });
  }
}

// Interrupting a read cannot settle the promise parked on read(), so the reader is cancelled
// from a finalizer instead; that settles the read and closes the body.
const scopedReader = (body: ReadableStream<Uint8Array>) =>
  Effect.acquireRelease(
    Effect.sync(() => body.getReader()),
    (reader) =>
      Effect.promise(() =>
        reader
          .cancel()
          .catch(() => undefined)
          .then(() => reader.releaseLock()),
      ),
  );

export const discardResponseBody = (response: Response): Effect.Effect<void> =>
  Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

export function responsePayloads<E>(
  response: Response,
  onError: (cause: unknown) => E,
): Stream.Stream<unknown, E> {
  if (response.status === 202 || response.status === 204) {
    return Stream.unwrap(discardResponseBody(response).pipe(Effect.as(Stream.empty)));
  }
  const body = response.body;
  if (body === null) return Stream.empty;
  const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim();
  if (mediaType.toLowerCase() === "text/event-stream") {
    return Stream.unwrap(
      scopedReader(body).pipe(
        Effect.map((reader) => Stream.fromAsyncIterable(sseDataLines(reader), onError)),
      ),
    ).pipe(Stream.mapEffect((data) => Effect.try({ try: () => JSON.parse(data), catch: onError })));
  }
  return Stream.unwrap(
    scopedReader(body).pipe(
      Effect.flatMap((reader) =>
        Effect.tryPromise({ try: () => readText(reader), catch: onError }),
      ),
      Effect.flatMap((text) =>
        text.trim().length === 0
          ? Effect.succeed(Stream.empty)
          : Effect.try({ try: () => JSON.parse(text) as unknown, catch: onError }).pipe(
              Effect.map((payload) => Stream.fromIterable([payload])),
            ),
      ),
    ),
  );
}

// @effect-diagnostics globalJsonInEffect:off
import * as Arr from "effect/Array";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const SSE_EVENT_SEPARATOR = /(?:\r\n|\r(?!\n)|\n){2}/u;

// Splits buffered SSE text into complete events' joined `data:` lines, returning the unparsed tail.
function takeSseData(buffered: string): readonly [rest: string, data: ReadonlyArray<string>] {
  const events: Array<string> = [];
  let separator = SSE_EVENT_SEPARATOR.exec(buffered);
  while (separator !== null) {
    const data = buffered
      .slice(0, separator.index)
      .split(/\r\n|\r|\n/u)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trimStart())
      .join("\n");
    if (data.length > 0) events.push(data);
    buffered = buffered.slice(separator.index + separator[0].length);
    separator = SSE_EVENT_SEPARATOR.exec(buffered);
  }
  return [buffered, events];
}

// Reads a body until it ends; on interruption it unlocks and cancels the body, so a stalled read ends.
const bodyChunks = <E>(
  body: ReadableStream<Uint8Array>,
  onError: (cause: unknown) => E,
): Stream.Stream<Uint8Array, E> =>
  Stream.unwrap(
    Effect.acquireRelease(
      Effect.sync(() => body.getReader()),
      (reader) =>
        Effect.promise(() => {
          reader.releaseLock();
          return body.cancel().catch(() => undefined);
        }),
    ).pipe(
      Effect.map((reader) =>
        Stream.fromPull(
          Effect.succeed(
            Effect.tryPromise({ try: () => reader.read(), catch: onError }).pipe(
              Effect.flatMap(({ done, value }) =>
                done ? Cause.done() : Effect.succeed(Arr.of(value)),
              ),
            ),
          ),
        ),
      ),
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
  const mediaType = (response.headers.get("content-type") ?? "").split(";", 1)[0]!.trim();
  if (mediaType.toLowerCase() === "text/event-stream") {
    const body = response.body;
    if (body === null) return Stream.empty;
    return bodyChunks(body, onError).pipe(
      Stream.decodeText,
      Stream.mapAccum(
        () => "",
        (buffered, text) => takeSseData(buffered + text),
      ),
      Stream.mapEffect((data) => Effect.try({ try: () => JSON.parse(data), catch: onError })),
    );
  }
  return Stream.unwrap(
    Effect.tryPromise({ try: () => response.text(), catch: onError }).pipe(
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

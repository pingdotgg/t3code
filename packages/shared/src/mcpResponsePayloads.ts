// @effect-diagnostics globalJsonInEffect:off
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

const SSE_EVENT_SEPARATOR = /(?:\r\n|\r(?!\n)|\n){2}/u;

async function* sseDataLines(response: Response): AsyncGenerator<string> {
  if (response.body === null) return;
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true });
    let separator = SSE_EVENT_SEPARATOR.exec(buffered);
    while (separator !== null) {
      const rawEvent = buffered.slice(0, separator.index);
      buffered = buffered.slice(separator.index + separator[0].length);
      const data = rawEvent
        .split(/\r\n|\r|\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data.length > 0) yield data;
      separator = SSE_EVENT_SEPARATOR.exec(buffered);
    }
  }
}

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
    return Stream.fromAsyncIterable(sseDataLines(response), onError).pipe(
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

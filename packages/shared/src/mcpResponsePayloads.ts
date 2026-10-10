// MCP responses carry opaque JSON-RPC that callers relay verbatim.
// @effect-diagnostics preferSchemaOverJson:off
/**
 * Reads the JSON-RPC payloads of a response from an MCP streamable-HTTP
 * endpoint. Used on the ACP bridge fast path, so it imports only effect core.
 *
 * @module mcpResponsePayloads
 */
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";

async function* sseDataLines(response: Response): AsyncGenerator<string> {
  if (response.body === null) return;
  const decoder = new TextDecoder();
  let buffered = "";
  for await (const chunk of response.body) {
    buffered += decoder.decode(chunk as Uint8Array, { stream: true });
    let separatorIndex = buffered.search(/\n\n|\r\n\r\n/u);
    while (separatorIndex !== -1) {
      const rawEvent = buffered.slice(0, separatorIndex);
      buffered = buffered.slice(separatorIndex).replace(/^(?:\r?\n){2}/u, "");
      const data = rawEvent
        .split(/\r?\n/u)
        .filter((line) => line.startsWith("data:"))
        .map((line) => line.slice("data:".length).trimStart())
        .join("\n");
      if (data.length > 0) yield data;
      separatorIndex = buffered.search(/\n\n|\r\n\r\n/u);
    }
  }
}

export const discardResponseBody = (response: Response): Effect.Effect<void> =>
  Effect.promise(() => response.body?.cancel().catch(() => undefined) ?? Promise.resolve());

/**
 * Every JSON-RPC payload carried by a response, in arrival order: nothing for
 * notification acknowledgements, each SSE `data:` event as it streams in, or
 * the single JSON body.
 */
export function responsePayloads<E>(
  response: Response,
  onError: (cause: unknown) => E,
): Stream.Stream<unknown, E> {
  if (response.status === 202 || response.status === 204) {
    return Stream.unwrap(discardResponseBody(response).pipe(Effect.as(Stream.empty)));
  }
  const contentType = response.headers.get("content-type") ?? "";
  if (contentType.includes("text/event-stream")) {
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

import { OpenCode, type OpenCodeClient } from "@opencode/client/effect";
import { OpenCodeEvent } from "@opencode/protocol/groups/event";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/unstable/encoding/Sse";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientError from "effect/unstable/http/HttpClientError";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

/** OpenCode 2 accepts only HTTP Basic auth, always with this user name. */
const OPENCODE_USERNAME = "opencode";

/**
 * An OpenCode 2 client plus a forward-compatible `/api/event` stream. The
 * client's own `event.subscribe` fails the whole stream on the first event a
 * newer server adds, so `events` decodes each frame on its own and skips the
 * ones this build does not know. `events` succeeds once the server accepted
 * the subscription: the stream is volatile, so callers subscribe before they
 * start work whose events they need.
 */
export interface OpenCode2Api {
  readonly client: OpenCodeClient;
  readonly events: Effect.Effect<
    Stream.Stream<OpenCodeEvent, HttpClientError.HttpClientError | Sse.Retry | Sse.SseError>,
    HttpClientError.HttpClientError
  >;
}

/** Builds clients for OpenCode 2 servers, one per base URL and password. */
export class OpenCode2Client extends Context.Service<
  OpenCode2Client,
  {
    readonly connect: (input: {
      readonly baseUrl: string;
      readonly password: string | Redacted.Redacted;
    }) => Effect.Effect<OpenCode2Api>;
  }
>()("t3/provider/opencode2/OpenCode2Client") {}

const decodeEvent = Schema.decodeUnknownResult(Schema.fromJsonString(OpenCodeEvent));
const unknownEventType = (data: string) => {
  const match = /"type"\s*:\s*"([^"]{1,80})"/.exec(data);
  return match?.[1] ?? "<unreadable>";
};

/** Subscribes to `/api/event`, then streams every frame this build can decode. */
const readEvents = (httpClient: HttpClient.HttpClient) =>
  httpClient.get("/api/event", { headers: { accept: "text/event-stream" } }).pipe(
    Effect.flatMap(HttpClientResponse.filterStatusOk),
    Effect.map((response) =>
      response.stream.pipe(
        Stream.decodeText,
        Stream.pipeThroughChannel(Sse.decode()),
        Stream.filterMapEffect((frame) => {
          const decoded = decodeEvent(frame.data);
          return Result.isSuccess(decoded)
            ? Effect.succeed(Result.succeed(decoded.success))
            : Effect.logDebug("Skipped an OpenCode event this build cannot decode.", {
                type: unknownEventType(frame.data),
              }).pipe(Effect.as(Result.failVoid));
        }),
      ),
    ),
  );

/**
 * OpenCode decodes Basic credentials as UTF-8. `HttpClientRequest.basicAuth`
 * encodes them as Latin-1 (`btoa`), which gets non-ASCII passwords rejected.
 */
const basicAuthorization = (password: string | Redacted.Redacted) => {
  const plain = Redacted.isRedacted(password) ? Redacted.value(password) : password;
  return `Basic ${Buffer.from(`${OPENCODE_USERNAME}:${plain}`, "utf8").toString("base64")}`;
};

/** @public Service construction is part of the canonical Effect module API. */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  return OpenCode2Client.of({
    connect: ({ baseUrl, password }) => {
      const authenticated = HttpClient.mapRequest(
        httpClient,
        HttpClientRequest.setHeader("Authorization", basicAuthorization(password)),
      );
      return OpenCode.make({ baseUrl }).pipe(
        Effect.provideService(HttpClient.HttpClient, authenticated),
        Effect.map((client) => ({
          client,
          events: readEvents(
            HttpClient.mapRequest(authenticated, HttpClientRequest.prependUrl(baseUrl)),
          ),
        })),
      );
    },
  });
});

export const layer = Layer.effect(OpenCode2Client, make);

/**
 * Streams every item of a cursor-paged OpenCode 2 list. The first request
 * carries the caller's input (including `order`); later requests send only
 * the cursor, because OpenCode rejects a cursor combined with `order`.
 */
export const paginate = <Input extends { readonly cursor?: unknown }, Item, E, R>(
  input: Input,
  list: (
    input: Input,
  ) => Effect.Effect<
    { readonly data: ReadonlyArray<Item>; readonly cursor: { readonly next?: Input["cursor"] } },
    E,
    R
  >,
): Stream.Stream<Item, E, R> =>
  Stream.paginate(input, (request) =>
    list(request).pipe(
      Effect.map(
        (page) =>
          [
            page.data,
            page.data.length === 0 || page.cursor.next === undefined
              ? Option.none()
              : Option.some({ ...request, order: undefined, cursor: page.cursor.next }),
          ] as const,
      ),
    ),
  );

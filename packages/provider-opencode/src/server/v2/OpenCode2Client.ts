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
import * as Sse from "effect/encoding/Sse";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientError from "effect/http/HttpClientError";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/** OpenCode 2 accepts only HTTP Basic auth, always with this user name. */
const OPENCODE_USERNAME = "opencode";

export interface OpenCode2UnreadableTerminal {
  readonly type: "unreadable.execution.ended";
  readonly executionType: (typeof EXECUTION_ENDS)[number];
  readonly sessionID: string;
}

export interface OpenCode2UnreadableStart {
  readonly type: "unreadable.execution.started";
  readonly sessionID: string;
}

const EXECUTION_ENDS = [
  "session.execution.succeeded",
  "session.execution.failed",
  "session.execution.interrupted",
] as const;
const isExecutionEnd = (type: string): type is (typeof EXECUTION_ENDS)[number] =>
  (EXECUTION_ENDS as ReadonlyArray<string>).includes(type);

export class OpenCode2SilentStreamError extends Schema.TaggedError<OpenCode2SilentStreamError>()(
  "OpenCode2SilentStreamError",
  {},
) {
  override get message(): string {
    return "The OpenCode server stopped sending events.";
  }
}

export type OpenCode2StreamEvent =
  | OpenCodeEvent
  | OpenCode2UnreadableTerminal
  | OpenCode2UnreadableStart;

/** events resolves on subscription acceptance; subscribe before work because the stream is volatile. */
export interface OpenCode2Api {
  readonly client: OpenCodeClient;
  readonly events: Effect.Effect<
    Stream.Stream<
      OpenCode2StreamEvent,
      HttpClientError.HttpClientError | Sse.Retry | Sse.SseError | OpenCode2SilentStreamError
    >,
    HttpClientError.HttpClientError
  >;
}

export class OpenCode2Client extends Context.Service<
  OpenCode2Client,
  {
    readonly connect: (input: {
      readonly baseUrl: string;
      readonly password: string | Redacted.Redacted;
    }) => Effect.Effect<OpenCode2Api>;
  }
>()("@t3tools/provider-opencode/server/v2/OpenCode2Client") {}

// Heartbeats arrive every 10-15 seconds; longer silence means stuck, not idle.
const SILENT_STREAM_TIMEOUT = "45 seconds";

const decodeEvent = Schema.decodeUnknownResult(Schema.fromJsonString(OpenCodeEvent));
const decodeEnvelope = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      type: Schema.String,
      data: Schema.optional(Schema.Struct({ sessionID: Schema.optional(Schema.String) })),
    }),
  ),
);

// Rejected stream frames can be frequent when the server introduces new event types.
const undecodable = Effect.fnUntraced(function* (data: string) {
  const envelope = decodeEnvelope(data);
  const type = envelope._tag === "Some" ? envelope.value.type.slice(0, 80) : "<unreadable>";
  const sessionID = envelope._tag === "Some" ? envelope.value.data?.sessionID : undefined;
  if (isExecutionEnd(type) && sessionID !== undefined) {
    yield* Effect.logWarning(
      "Ended an OpenCode execution from an event this build cannot decode.",
      {
        type,
      },
    );
    return Result.succeed<OpenCode2StreamEvent>({
      type: "unreadable.execution.ended",
      executionType: type,
      sessionID,
    });
  }
  if (type === "session.execution.started" && sessionID !== undefined) {
    yield* Effect.logDebug("Read an OpenCode execution start this build cannot decode.");
    return Result.succeed<OpenCode2StreamEvent>({
      type: "unreadable.execution.started",
      sessionID,
    });
  }
  yield* Effect.logDebug("Skipped an OpenCode event this build cannot decode.", { type });
  return Result.failVoid;
});

const readEvents = HttpClient.get("/api/event", {
  headers: { accept: "text/event-stream" },
}).pipe(
  Effect.flatMap(HttpClientResponse.filterStatusOk),
  Effect.map((response) =>
    response.stream.pipe(
      Stream.timeoutOrElse({
        duration: SILENT_STREAM_TIMEOUT,
        orElse: () => Stream.fail(new OpenCode2SilentStreamError()),
      }),
      Stream.decodeText,
      Stream.pipeThroughChannel(Sse.decode()),
      Stream.filterMapEffect((frame) => {
        const decoded = decodeEvent(frame.data);
        return Result.isSuccess(decoded)
          ? Effect.succeed(Result.succeed<OpenCode2StreamEvent>(decoded.success))
          : undecodable(frame.data);
      }),
    ),
  ),
);

// OpenCode requires UTF-8 Basic credentials; HttpClientRequest.basicAuth uses Latin-1.
const basicAuthorization = (password: string | Redacted.Redacted) => {
  const plain = Redacted.isRedacted(password) ? Redacted.value(password) : password;
  return `Basic ${Buffer.from(`${OPENCODE_USERNAME}:${plain}`, "utf8").toString("base64")}`;
};

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  return OpenCode2Client.of({
    connect: Effect.fn("OpenCode2Client.connect")(function ({ baseUrl, password }) {
      const authenticated = HttpClient.mapRequest(
        httpClient,
        HttpClientRequest.setHeader("Authorization", basicAuthorization(password)),
      );
      return OpenCode.make({ baseUrl }).pipe(
        Effect.provideService(HttpClient.HttpClient, authenticated),
        Effect.map((client) => ({
          client,
          events: readEvents.pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.mapRequest(authenticated, HttpClientRequest.prependUrl(baseUrl)),
            ),
          ),
        })),
      );
    }),
  });
});

export const layer = Layer.effect(OpenCode2Client, make);

/** Send input only initially; cursor pages must omit order or OpenCode rejects them. */
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

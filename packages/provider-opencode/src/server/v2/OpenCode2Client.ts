import * as Path from "effect/Path";
import { PROVIDER_SEND_TURN_MAX_IMAGE_BYTES } from "@t3tools/contracts";
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

const ShellJobs = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      kind: Schema.Literal("shell"),
      shellID: Schema.String,
      sessionID: Schema.String,
      command: Schema.String,
      status: Schema.Literals(["running", "completed", "error", "cancelled"]),
    }),
  ),
});
export class OpenCode2ImageError extends Schema.TaggedError<OpenCode2ImageError>()(
  "OpenCode2ImageError",
  { cause: Schema.Defect() },
) {}

const IMAGE_MIME: Readonly<Record<string, string>> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".gif": "image/gif",
};
export const imagePreviewMime = (extension: string) => IMAGE_MIME[extension.toLowerCase()];

const NativeImageJob = Schema.Struct({
  kind: Schema.Literal("image"),
  id: Schema.String,
  sessionID: Schema.String,
  status: Schema.Literals(["running", "completed", "error", "cancelled"]),
  path: Schema.String,
  model: Schema.String,
});
const decodeJobs = Schema.decodeUnknownEffect(
  Schema.Struct({ data: Schema.Array(Schema.Unknown) }),
);
const decodeImageJob = Schema.decodeUnknownOption(NativeImageJob);

/** events resolves on subscription acceptance; subscribe before work because the stream is volatile. */
export interface OpenCode2Api {
  readonly client: OpenCodeClient;
  readonly shellJobs?: (
    sessionID: string,
  ) => Effect.Effect<typeof ShellJobs.Type, HttpClientError.HttpClientError | Schema.SchemaError>;
  readonly imageJobs: (
    sessionID: string,
  ) => Effect.Effect<ReadonlyArray<typeof NativeImageJob.Type>, OpenCode2ImageError>;
  readonly readImage: (
    path: string,
    directory: string,
  ) => Effect.Effect<{ uri: string; mime: string }, OpenCode2ImageError>;
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
const SUBSCRIPTION_TIMEOUT = "10 seconds";

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

const MESSAGE_LIST_URL = /\/api\/session\/[^/?#]+\/message(?:[?#]|$)/;

/** Reads only the page's shape; each message stays opaque for the real schema to judge. */
const MessagePage = Schema.fromJsonString(
  Schema.StructWithRest(Schema.Struct({ data: Schema.Array(Schema.Unknown) }), [
    Schema.Record(Schema.String, Schema.Unknown),
  ]),
);
const decodePage = Schema.decodeUnknownOption(MessagePage);
const encodePage = Schema.encodeSync(MessagePage);

const CompactionWithRecent = Schema.Struct({
  type: Schema.Literal("compaction"),
  status: Schema.Literals(["running", "completed"]),
  metadata: Schema.optionalKey(Schema.Unknown),
});
const isCompactionWithRecent = Schema.is(CompactionWithRecent);
const isLegacyMetadata = Schema.is(Schema.Struct({ recent: Schema.String }));

const fillCompactionRecent = (message: unknown) =>
  isCompactionWithRecent(message) && !("recent" in message)
    ? { ...message, recent: isLegacyMetadata(message.metadata) ? message.metadata.recent : "" }
    : message;

/**
 * OpenCode 2.1 dropped a compaction's `recent`, which the bundled 2.0.28 schema requires.
 * Migrated pre-2.1 compactions keep it under `metadata.recent`; native 2.1 ones have none.
 * T3 never reads it, so fill the gap; every other field still validates downstream.
 */
const fillCompactionRecents = HttpClient.transformResponse(
  Effect.fnUntraced(function* (
    pending: Effect.Effect<HttpClientResponse.HttpClientResponse, HttpClientError.HttpClientError>,
  ) {
    const response = yield* pending;
    const { request } = response;
    if (
      request.method !== "GET" ||
      response.status !== 200 ||
      !MESSAGE_LIST_URL.test(request.url)
    ) {
      return response;
    }
    const text = yield* response.text;
    const page = decodePage(text);
    // The response caches its body, so the untouched one still decodes downstream.
    if (Option.isNone(page)) return response;
    const filled = encodePage({ ...page.value, data: page.value.data.map(fillCompactionRecent) });
    // The filled body is longer than the one the server measured.
    const { "content-length": _, ...headers } = response.headers;
    return HttpClientResponse.fromWeb(
      request,
      new Response(filled, { status: response.status, headers }),
    );
  }),
);

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const paths = yield* Path.Path.pipe(Effect.provide(Path.layer));
  return OpenCode2Client.of({
    connect: Effect.fn("OpenCode2Client.connect")(function ({ baseUrl, password }) {
      const authenticated = HttpClient.mapRequest(
        httpClient,
        HttpClientRequest.setHeader("Authorization", basicAuthorization(password)),
      );
      return OpenCode.make({ baseUrl }).pipe(
        Effect.provideService(HttpClient.HttpClient, fillCompactionRecents(authenticated)),
        Effect.map((client) => ({
          client,
          shellJobs: Effect.fn("OpenCode2Client.shellJobs")(function (sessionID: string) {
            return authenticated
              .get(`${baseUrl}/api/experimental/job`, {
                urlParams: { sessionID, kind: "shell", descendants: "true" },
              })
              .pipe(
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.flatMap(HttpClientResponse.schemaBodyJson(ShellJobs)),
              );
          }),
          imageJobs: (sessionID: string) =>
            authenticated
              .get(`${baseUrl}/api/experimental/job`, {
                urlParams: { sessionID, kind: "image" },
              })
              .pipe(
                Effect.flatMap(HttpClientResponse.filterStatusOk),
                Effect.flatMap((response) => response.json),
                Effect.flatMap(decodeJobs),
                Effect.map((page) =>
                  page.data.flatMap((item) => {
                    const job = decodeImageJob(item);
                    return Option.isSome(job) && job.value.sessionID === sessionID
                      ? [job.value]
                      : [];
                  }),
                ),
                Effect.mapError((cause) => new OpenCode2ImageError({ cause })),
              ),
          readImage: Effect.fn("OpenCode2Client.readImage")(
            function* (path: string, directory: string) {
              const mime = imagePreviewMime(paths.extname(path));
              if (mime === undefined)
                return yield* new OpenCode2ImageError({ cause: "Unsupported image format" });
              const relative = paths.relative(directory, path);
              // OpenCode confines reads to the requested location, including its own temp images.
              const outside =
                relative === ".." ||
                relative.startsWith(`..${paths.sep}`) ||
                paths.isAbsolute(relative);
              const location = outside ? paths.dirname(path) : directory;
              const file = outside ? paths.basename(path) : relative;
              const response = yield* authenticated
                .get(`${baseUrl}/api/fs/read/${encodeURIComponent(file)}`, {
                  urlParams: { "location[directory]": location },
                })
                .pipe(Effect.flatMap(HttpClientResponse.filterStatusOk));
              const bytes = yield* response.arrayBuffer;
              if (bytes.byteLength > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES)
                return yield* new OpenCode2ImageError({ cause: "Image exceeds preview limit" });
              return { uri: `data:${mime};base64,${Buffer.from(bytes).toString("base64")}`, mime };
            },
            Effect.timeout("10 seconds"),
            Effect.mapError((cause) => new OpenCode2ImageError({ cause })),
          ),
          events: readEvents.pipe(
            Effect.provideService(
              HttpClient.HttpClient,
              HttpClient.mapRequest(authenticated, HttpClientRequest.prependUrl(baseUrl)).pipe(
                HttpClient.timeout(SUBSCRIPTION_TIMEOUT),
              ),
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

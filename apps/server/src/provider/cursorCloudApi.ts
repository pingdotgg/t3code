/**
 * Minimal client for the Cursor Cloud Agents API (v1).
 *
 * An agent is a durable conversation plus a Cursor-hosted workspace; each
 * prompt is a run on it, and only one run can be active per agent. Run
 * progress arrives as Server-Sent Events that resume from `Last-Event-ID`.
 * See https://cursor.com/docs/cloud-agent/api/endpoints.
 *
 * @module provider/cursorCloudApi
 */
import * as Effect from "effect/Effect";
import * as Filter from "effect/Filter";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as Sse from "effect/unstable/encoding/Sse";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const CURSOR_CLOUD_API_URL = "https://api.cursor.com";
export const CURSOR_CLOUD_API_KEY_ENV = "CURSOR_API_KEY";
const STREAM_IDLE_TIMEOUT = "90 seconds";

export class CursorCloudApiError extends Schema.TaggedError<CursorCloudApiError>()(
  "CursorCloudApiError",
  {
    operation: Schema.String,
    status: Schema.optional(Schema.Number),
    code: Schema.optional(Schema.String),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const status = this.status === undefined ? "" : ` (HTTP ${this.status})`;
    return `Cursor Cloud ${this.operation} failed${status}: ${this.detail}`;
  }
}

const optionalNullable = <S extends Schema.Top>(schema: S) =>
  Schema.optional(Schema.NullOr(schema));

const CursorCloudModelParameter = Schema.Struct({
  id: Schema.String,
  displayName: optionalNullable(Schema.String),
  values: Schema.Array(
    Schema.Struct({ value: Schema.String, displayName: optionalNullable(Schema.String) }),
  ),
});

const CursorCloudModelParam = Schema.Struct({ id: Schema.String, value: Schema.String });
type CursorCloudModelParam = typeof CursorCloudModelParam.Type;

const CursorCloudModel = Schema.Struct({
  id: Schema.String,
  displayName: optionalNullable(Schema.String),
  parameters: optionalNullable(Schema.Array(CursorCloudModelParameter)),
  variants: optionalNullable(
    Schema.Array(
      Schema.Struct({
        params: Schema.Array(CursorCloudModelParam),
        isDefault: optionalNullable(Schema.Boolean),
      }),
    ),
  ),
});
export type CursorCloudModel = typeof CursorCloudModel.Type;

const CursorCloudModelList = Schema.Struct({ items: Schema.Array(CursorCloudModel) });

const CursorCloudMe = Schema.Struct({
  apiKeyName: optionalNullable(Schema.String),
  userEmail: optionalNullable(Schema.String),
});
type CursorCloudMe = typeof CursorCloudMe.Type;

const CursorCloudGit = Schema.Struct({
  branches: Schema.Array(
    Schema.Struct({
      repoUrl: Schema.String,
      branch: optionalNullable(Schema.String),
      prUrl: optionalNullable(Schema.String),
    }),
  ),
});
export type CursorCloudGit = typeof CursorCloudGit.Type;

const CursorCloudRun = Schema.Struct({
  id: Schema.String,
  agentId: Schema.String,
  status: Schema.String,
  result: optionalNullable(Schema.String),
  git: optionalNullable(CursorCloudGit),
});
type CursorCloudRun = typeof CursorCloudRun.Type;

const CursorCloudAgent = Schema.Struct({
  id: Schema.String,
  url: optionalNullable(Schema.String),
  status: Schema.String,
  latestRunId: optionalNullable(Schema.String),
});
type CursorCloudAgent = typeof CursorCloudAgent.Type;

const CursorCloudCreateAgentResponse = Schema.Struct({
  agent: CursorCloudAgent,
  run: CursorCloudRun,
});
const CursorCloudCreateRunResponse = Schema.Struct({ run: CursorCloudRun });

const CursorCloudErrorBody = Schema.Struct({
  code: optionalNullable(Schema.String),
  message: optionalNullable(Schema.String),
  error: optionalNullable(
    Schema.Union([
      Schema.String,
      Schema.Struct({
        code: optionalNullable(Schema.String),
        message: optionalNullable(Schema.String),
      }),
    ]),
  ),
});
const decodeErrorBody = Schema.decodeOption(Schema.fromJsonString(CursorCloudErrorBody));

/** Terminal run states. Anything else (`CREATING`, `RUNNING`, …) is still in flight. */
const TERMINAL_RUN_STATUSES = new Set(["FINISHED", "ERROR", "CANCELLED", "EXPIRED"]);
export const isTerminalRunStatus = (status: string): boolean =>
  TERMINAL_RUN_STATUSES.has(status.toUpperCase());

export interface CursorCloudPrompt {
  readonly text: string;
  readonly images?: ReadonlyArray<{ readonly data: string; readonly mimeType: string }>;
}

interface CursorCloudCreateAgentBody {
  readonly prompt: CursorCloudPrompt;
  readonly model?: {
    readonly id: string;
    readonly params?: ReadonlyArray<CursorCloudModelParam>;
  };
  readonly repos: ReadonlyArray<{ readonly url: string; readonly startingRef: string }>;
  readonly autoCreatePR: boolean;
  readonly mode: "agent" | "plan";
}

interface CursorCloudCreateRunBody {
  readonly prompt: CursorCloudPrompt;
  readonly mode: "agent" | "plan";
}

const ToolCallData = Schema.Struct({
  callId: Schema.String,
  name: Schema.String,
  status: Schema.String,
  args: Schema.optional(Schema.Unknown),
  result: Schema.optional(Schema.Unknown),
});
const ResultData = Schema.Struct({
  status: Schema.String,
  text: optionalNullable(Schema.String),
  git: optionalNullable(CursorCloudGit),
});
const TextData = Schema.Struct({ text: Schema.String });
const StatusData = Schema.Struct({ status: Schema.String });
const ErrorData = Schema.Struct({
  code: optionalNullable(Schema.String),
  message: optionalNullable(Schema.String),
});

export type CursorCloudStreamEvent =
  | { readonly type: "status"; readonly status: string }
  | { readonly type: "assistant"; readonly text: string }
  | { readonly type: "thinking"; readonly text: string }
  | { readonly type: "tool_call"; readonly call: typeof ToolCallData.Type }
  | { readonly type: "result"; readonly result: typeof ResultData.Type }
  | { readonly type: "error"; readonly code: string | undefined; readonly message: string }
  | { readonly type: "done" };

interface CursorCloudStreamItem {
  /** Opaque resume position; absent on the sticky `status` framing event. */
  readonly id: string | undefined;
  readonly event: CursorCloudStreamEvent;
}

const decodeData =
  <S extends Schema.Codec<unknown, unknown>>(schema: S) =>
  (data: string) =>
    Schema.decodeOption(Schema.fromJsonString(schema))(data);

const decodeToolCall = decodeData(ToolCallData);
const decodeResult = decodeData(ResultData);
const decodeText = decodeData(TextData);
const decodeStatus = decodeData(StatusData);
const decodeError = decodeData(ErrorData);

/** Heartbeats, `interaction_update` (a richer duplicate of the simple events), and unknown events decode to `undefined`. */
function decodeCursorCloudStreamEvent(
  event: Pick<Sse.Event, "event" | "data">,
): CursorCloudStreamEvent | undefined {
  switch (event.event) {
    case "status":
      return Option.getOrUndefined(
        Option.map(decodeStatus(event.data), ({ status }) => ({ type: "status", status }) as const),
      );
    case "assistant":
    case "thinking": {
      const type = event.event;
      return Option.getOrUndefined(
        Option.map(decodeText(event.data), ({ text }) => ({ type, text }) as const),
      );
    }
    case "tool_call":
      return Option.getOrUndefined(
        Option.map(decodeToolCall(event.data), (call) => ({ type: "tool_call", call }) as const),
      );
    case "result":
      return Option.getOrUndefined(
        Option.map(decodeResult(event.data), (result) => ({ type: "result", result }) as const),
      );
    case "error": {
      const decoded = Option.getOrUndefined(decodeError(event.data));
      return {
        type: "error",
        code: decoded?.code ?? undefined,
        message: decoded?.message ?? "Cursor reported a stream error.",
      };
    }
    case "done":
      return { type: "done" };
    default:
      return undefined;
  }
}

export interface CursorCloudApi {
  readonly me: Effect.Effect<CursorCloudMe, CursorCloudApiError>;
  readonly listModels: Effect.Effect<ReadonlyArray<CursorCloudModel>, CursorCloudApiError>;
  readonly createAgent: (
    body: CursorCloudCreateAgentBody,
  ) => Effect.Effect<
    { readonly agent: CursorCloudAgent; readonly run: CursorCloudRun },
    CursorCloudApiError
  >;
  readonly createRun: (
    agentId: string,
    body: CursorCloudCreateRunBody,
  ) => Effect.Effect<CursorCloudRun, CursorCloudApiError>;
  readonly getRun: (
    agentId: string,
    runId: string,
  ) => Effect.Effect<CursorCloudRun, CursorCloudApiError>;
  readonly cancelRun: (agentId: string, runId: string) => Effect.Effect<void, CursorCloudApiError>;
  /**
   * One connection to a run's event stream. It ends when the server closes
   * the connection; callers reconnect with the last received id until they
   * see a terminal `result`.
   */
  readonly streamRun: (
    agentId: string,
    runId: string,
    lastEventId: string | undefined,
  ) => Stream.Stream<CursorCloudStreamItem, CursorCloudApiError>;
}

export function makeCursorCloudApi(input: {
  readonly apiKey: string;
  readonly httpClient: HttpClient.HttpClient;
}): CursorCloudApi {
  const segment = encodeURIComponent;

  const failedResponse = (operation: string, response: HttpClientResponse.HttpClientResponse) =>
    response.text.pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((text) => {
        const body = Option.getOrUndefined(decodeErrorBody(text));
        const nested = typeof body?.error === "object" ? body.error : undefined;
        const code = body?.code ?? nested?.code ?? undefined;
        const detail =
          body?.message ??
          nested?.message ??
          (typeof body?.error === "string" ? body.error : undefined) ??
          `Unexpected response status ${response.status}.`;
        return Effect.fail(
          new CursorCloudApiError({
            operation,
            status: response.status,
            ...(code ? { code } : {}),
            detail,
          }),
        );
      }),
    );

  const send = (operation: string, request: HttpClientRequest.HttpClientRequest) =>
    input.httpClient
      .execute(
        request.pipe(
          HttpClientRequest.prependUrl(CURSOR_CLOUD_API_URL),
          HttpClientRequest.bearerToken(input.apiKey),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new CursorCloudApiError({
              operation,
              detail: "Could not reach the Cursor API.",
              cause,
            }),
        ),
      );

  const json = <S extends Schema.Codec<unknown, unknown>>(
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], CursorCloudApiError> =>
    send(operation, request.pipe(HttpClientRequest.acceptJson)).pipe(
      Effect.flatMap(
        HttpClientResponse.matchStatus({
          "2xx": (success) =>
            HttpClientResponse.schemaBodyJson(schema)(success).pipe(
              Effect.mapError(
                (cause) =>
                  new CursorCloudApiError({
                    operation,
                    status: success.status,
                    detail: "Cursor returned an unexpected response.",
                    cause,
                  }),
              ),
            ),
          orElse: (failed) => failedResponse(operation, failed),
        }),
      ),
    );

  const streamRun: CursorCloudApi["streamRun"] = (agentId, runId, lastEventId) =>
    send(
      "stream run",
      HttpClientRequest.get(`/v1/agents/${segment(agentId)}/runs/${segment(runId)}/stream`).pipe(
        HttpClientRequest.accept("text/event-stream"),
        lastEventId === undefined
          ? (request) => request
          : HttpClientRequest.setHeader("Last-Event-ID", lastEventId),
      ),
    ).pipe(
      Effect.filterOrElse(
        (response) => response.status >= 200 && response.status < 300,
        (response) => failedResponse("stream run", response),
      ),
      Effect.map((response) =>
        response.stream.pipe(
          Stream.decodeText(),
          Stream.pipeThroughChannel(Sse.decode()),
          // Heartbeats still count here, so only a dead connection goes quiet this long.
          Stream.timeout(STREAM_IDLE_TIMEOUT),
          Stream.filterMap(
            Filter.fromPredicateOption((event: Sse.Event) =>
              Option.map(
                Option.fromUndefinedOr(decodeCursorCloudStreamEvent(event)),
                (decoded): CursorCloudStreamItem => ({ id: event.id, event: decoded }),
              ),
            ),
          ),
          Stream.mapError(
            (cause) =>
              new CursorCloudApiError({
                operation: "stream run",
                detail: "The run stream disconnected.",
                cause,
              }),
          ),
        ),
      ),
      Stream.unwrap,
    );

  return {
    me: json("read API key", HttpClientRequest.get("/v1/me"), CursorCloudMe),
    listModels: json("list models", HttpClientRequest.get("/v1/models"), CursorCloudModelList).pipe(
      Effect.map((response) => response.items),
    ),
    createAgent: (body) =>
      json(
        "create agent",
        HttpClientRequest.post("/v1/agents").pipe(HttpClientRequest.bodyJsonUnsafe(body)),
        CursorCloudCreateAgentResponse,
      ),
    createRun: (agentId, body) =>
      json(
        "create run",
        HttpClientRequest.post(`/v1/agents/${segment(agentId)}/runs`).pipe(
          HttpClientRequest.bodyJsonUnsafe(body),
        ),
        CursorCloudCreateRunResponse,
      ).pipe(Effect.map((response) => response.run)),
    getRun: (agentId, runId) =>
      json(
        "read run",
        HttpClientRequest.get(`/v1/agents/${segment(agentId)}/runs/${segment(runId)}`),
        CursorCloudRun,
      ),
    cancelRun: (agentId, runId) =>
      json(
        "cancel run",
        HttpClientRequest.post(`/v1/agents/${segment(agentId)}/runs/${segment(runId)}/cancel`),
        Schema.Unknown,
      ).pipe(Effect.asVoid),
    streamRun,
  };
}

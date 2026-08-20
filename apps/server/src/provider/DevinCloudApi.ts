import type { DevinCloudSettings } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

const API_BASE_URL = "https://api.devin.ai/v3";

export const DevinCloudSessionStatus = Schema.Literals([
  "new",
  "claimed",
  "running",
  "exit",
  "error",
  "suspended",
  "resuming",
]);
export type DevinCloudSessionStatus = typeof DevinCloudSessionStatus.Type;

export const DevinCloudSession = Schema.Struct({
  session_id: Schema.String,
  status: DevinCloudSessionStatus,
  url: Schema.String,
  status_detail: Schema.optional(Schema.NullOr(Schema.String)),
  title: Schema.optional(Schema.NullOr(Schema.String)),
});
export type DevinCloudSession = typeof DevinCloudSession.Type;

export const DevinCloudMessagesPage = Schema.Struct({
  items: Schema.Array(
    Schema.Struct({
      created_at: Schema.Number,
      event_id: Schema.String,
      message: Schema.String,
    }),
  ),
  end_cursor: Schema.NullOr(Schema.String),
  has_next_page: Schema.Boolean,
  total: Schema.optional(Schema.NullOr(Schema.Number)),
});
export type DevinCloudMessagesPage = typeof DevinCloudMessagesPage.Type;

const DevinCloudSelf = Schema.Unknown;

export const DevinCloudApiOperation = Schema.Literals([
  "getSelf",
  "createSession",
  "getSession",
  "listMessages",
  "sendMessage",
]);
export type DevinCloudApiOperation = typeof DevinCloudApiOperation.Type;

export class DevinCloudApiError extends Schema.TaggedErrorClass<DevinCloudApiError>()(
  "DevinCloudApiError",
  {
    operation: DevinCloudApiOperation,
    status: Schema.optional(Schema.Number),
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    const status = this.status === undefined ? "" : ` (HTTP ${this.status})`;
    return `Devin Cloud ${this.operation} failed${status}: ${this.detail}`;
  }
}

export interface DevinCloudApi {
  readonly getSelf: Effect.Effect<unknown, DevinCloudApiError>;
  readonly createSession: (input: {
    readonly prompt: string;
    readonly bypassApproval: boolean;
    readonly repos: ReadonlyArray<string>;
    readonly tags: ReadonlyArray<string>;
    readonly devinMode?: string | undefined;
  }) => Effect.Effect<DevinCloudSession, DevinCloudApiError>;
  readonly getSession: (sessionId: string) => Effect.Effect<DevinCloudSession, DevinCloudApiError>;
  readonly listMessages: (
    sessionId: string,
    after?: string,
  ) => Effect.Effect<DevinCloudMessagesPage, DevinCloudApiError>;
  readonly sendMessage: (
    sessionId: string,
    message: string,
  ) => Effect.Effect<DevinCloudSession, DevinCloudApiError>;
}

export const makeDevinCloudApi = Effect.fn("makeDevinCloudApi")(function* (
  settings: DevinCloudSettings,
): Effect.fn.Return<DevinCloudApi, never, HttpClient.HttpClient> {
  const httpClient = yield* HttpClient.HttpClient;
  const orgPath = `${API_BASE_URL}/organizations/${encodeURIComponent(settings.organizationId)}`;

  const executeJson = <S extends Schema.Top>(
    operation: DevinCloudApiOperation,
    request: HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], DevinCloudApiError, S["DecodingServices"]> =>
    httpClient
      .execute(
        request.pipe(HttpClientRequest.acceptJson, HttpClientRequest.bearerToken(settings.apiKey)),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new DevinCloudApiError({
              operation,
              detail: "The request could not reach api.devin.ai.",
              cause,
            }),
        ),
        Effect.flatMap((response) => decodeResponse(operation, response, schema)),
      );

  const sessionPath = (sessionId: string) => `${orgPath}/sessions/${encodeURIComponent(sessionId)}`;

  return {
    getSelf: executeJson("getSelf", HttpClientRequest.get(`${API_BASE_URL}/self`), DevinCloudSelf),
    createSession: (input) => {
      // No `platform` field: the API defines it as the VM platform / outpost
      // pool selector and rejects unrecognized values with a 400.
      const body = {
        prompt: input.prompt,
        resumable: true,
        bypass_approval: input.bypassApproval,
        ...(input.devinMode ? { devin_mode: input.devinMode } : {}),
        ...(input.repos.length > 0 ? { repos: input.repos } : {}),
        ...(input.tags.length > 0 ? { tags: input.tags } : {}),
        ...(settings.createAsUserId ? { create_as_user_id: settings.createAsUserId } : {}),
      };
      return executeJson(
        "createSession",
        HttpClientRequest.post(`${orgPath}/sessions`).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
        DevinCloudSession,
      );
    },
    getSession: (sessionId) =>
      executeJson("getSession", HttpClientRequest.get(sessionPath(sessionId)), DevinCloudSession),
    listMessages: (sessionId, after) => {
      let request = HttpClientRequest.get(`${sessionPath(sessionId)}/messages`).pipe(
        HttpClientRequest.setUrlParam("first", "200"),
      );
      if (after) request = request.pipe(HttpClientRequest.setUrlParam("after", after));
      return executeJson("listMessages", request, DevinCloudMessagesPage);
    },
    sendMessage: (sessionId, message) =>
      executeJson(
        "sendMessage",
        HttpClientRequest.post(`${sessionPath(sessionId)}/messages`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            message,
            ...(settings.createAsUserId ? { message_as_user_id: settings.createAsUserId } : {}),
          }),
        ),
        DevinCloudSession,
      ),
  } satisfies DevinCloudApi;
});

function decodeResponse<S extends Schema.Top>(
  operation: DevinCloudApiOperation,
  response: HttpClientResponse.HttpClientResponse,
  schema: S,
): Effect.Effect<S["Type"], DevinCloudApiError, S["DecodingServices"]> {
  if (response.status < 200 || response.status >= 300) {
    const detail =
      response.status === 401 || response.status === 403
        ? "Check the service-user token and its organization permissions."
        : "The Devin API rejected the request.";
    return Effect.fail(new DevinCloudApiError({ operation, status: response.status, detail }));
  }
  return response.pipe(
    HttpClientResponse.schemaBodyJson(schema),
    Effect.mapError(
      (cause) =>
        new DevinCloudApiError({
          operation,
          status: response.status,
          detail: "The response did not match the documented Devin API schema.",
          cause,
        }),
    ),
  );
}

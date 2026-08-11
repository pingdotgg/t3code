/**
 * Aether REST task client — the driver's only REST transport.
 *
 * Thin, fully typed wrapper over `HttpClient` for the Aether task surface:
 * create/respond/stop/remove-from-queue/update/get, the conversation
 * messages page + delta, the projects list, and the profile probe. Every
 * response parses at this boundary through the loose schemas in
 * `restSchemas.ts`; every failure is a typed tagged error from the
 * `AetherRestError` union — never a thrown string, never a silent fallback.
 *
 * Error mapping (apps/api/router/tasks_openapi.go taskErrorResponse):
 *   - 401 → `AetherApiAuthError` (bad API key — distinct from transport)
 *   - 402 → `AetherApiPaymentRequiredError`
 *   - 404 → `AetherApiNotFoundError`
 *   - 409 → `AetherApiConflictError` carrying the structured body's
 *     `code` + `awaiting_input_kind` when present
 *   - other 4xx → `AetherApiRequestError` (status preserved)
 *   - 5xx, network failures, timeouts → `AetherApiTransportError`
 *   - malformed 2xx payloads → `AetherApiDecodeError`
 *
 * Requests carry a bearer token and a per-request timeout (no automatic
 * retries: create/respond are non-idempotent — `client_message_id` exists so
 * CALLERS can retry a respond safely).
 *
 * @module provider/Layers/aether/restClient
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";

import { AetherProfileResponse } from "../AetherProvider.ts";
import {
  AetherConversationDeltaEnvelope,
  AetherConversationMessagesPageEnvelope,
  AetherCreateTaskResponse,
  AetherProjectListResponse,
  AetherRespondToTaskResponse,
  decodeAetherConnectConflict,
  decodeAetherConnectResponse,
  decodeAetherTask,
  type AetherConversationDelta,
  type AetherConversationMessagesPage,
  type AetherCreateTaskRequest,
  type AetherProject,
  type AetherRespondToTaskRequest,
  type AetherTask,
  type AetherUpdateTaskRequest,
  type AetherWorkspaceConnectOutcome,
} from "./restSchemas.ts";

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** 401 — the API key is missing, revoked, or wrong. */
export class AetherApiAuthError extends Schema.TaggedErrorClass<AetherApiAuthError>()(
  "AetherApiAuthError",
  {
    endpoint: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Aether API authentication failed (${this.endpoint}): ${this.detail}`;
  }
}

/** 402 — out of credits / plan does not allow the operation. */
export class AetherApiPaymentRequiredError extends Schema.TaggedErrorClass<AetherApiPaymentRequiredError>()(
  "AetherApiPaymentRequiredError",
  {
    endpoint: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Aether API payment required (${this.endpoint}): ${this.detail}`;
  }
}

/** 404 — the task/project does not exist (or is not visible to this key). */
export class AetherApiNotFoundError extends Schema.TaggedErrorClass<AetherApiNotFoundError>()(
  "AetherApiNotFoundError",
  {
    endpoint: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Aether API resource not found (${this.endpoint}): ${this.detail}`;
  }
}

/**
 * 409 — state conflict. The respond endpoint's structured body carries
 * `code` and, for pending-input conflicts, `awaiting_input_kind`
 * (message | questions | plan) so callers can re-sync instead of blind-retry.
 */
export class AetherApiConflictError extends Schema.TaggedErrorClass<AetherApiConflictError>()(
  "AetherApiConflictError",
  {
    endpoint: Schema.String,
    detail: Schema.String,
    code: Schema.optional(Schema.String),
    awaitingInputKind: Schema.optional(Schema.String),
  },
) {
  override get message(): string {
    return `Aether API conflict (${this.endpoint}): ${this.detail}`;
  }
}

/** Any other 4xx (400 bad request, 422 validation, …). */
export class AetherApiRequestError extends Schema.TaggedErrorClass<AetherApiRequestError>()(
  "AetherApiRequestError",
  {
    endpoint: Schema.String,
    status: Schema.Number,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Aether API request failed (${this.endpoint}, HTTP ${this.status}): ${this.detail}`;
  }
}

/** 5xx, network failure, or request timeout — the transport, not the caller. */
export class AetherApiTransportError extends Schema.TaggedErrorClass<AetherApiTransportError>()(
  "AetherApiTransportError",
  {
    endpoint: Schema.String,
    detail: Schema.String,
    status: Schema.optional(Schema.Number),
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Aether API transport error (${this.endpoint}): ${this.detail}`;
  }
}

/** A 2xx body that failed to parse — a contract break, surfaced loudly. */
export class AetherApiDecodeError extends Schema.TaggedErrorClass<AetherApiDecodeError>()(
  "AetherApiDecodeError",
  {
    endpoint: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Aether API returned an unexpected payload (${this.endpoint}): ${this.detail}`;
  }
}

export type AetherRestError =
  | AetherApiAuthError
  | AetherApiPaymentRequiredError
  | AetherApiNotFoundError
  | AetherApiConflictError
  | AetherApiRequestError
  | AetherApiTransportError
  | AetherApiDecodeError;

// ---------------------------------------------------------------------------
// Client
// ---------------------------------------------------------------------------

const REQUEST_TIMEOUT_MS = 30_000;

// Structured error body written by the task/project routers. Loose: `error`
// itself is optional so a bare or non-JSON body still maps to a typed error.
const AetherErrorBody = Schema.Struct({
  error: Schema.optional(Schema.String),
  code: Schema.optional(Schema.String),
  awaiting_input_kind: Schema.optional(Schema.String),
});
const decodeErrorBody = Schema.decodeUnknownEffect(AetherErrorBody);

const decodeCreateTaskResponse = Schema.decodeUnknownEffect(AetherCreateTaskResponse);
const decodeRespondToTaskResponse = Schema.decodeUnknownEffect(AetherRespondToTaskResponse);
const decodeProjectListResponse = Schema.decodeUnknownEffect(AetherProjectListResponse);
const decodeProfileResponse = Schema.decodeUnknownEffect(AetherProfileResponse);
const decodeMessagesPageEnvelope = Schema.decodeUnknownEffect(
  AetherConversationMessagesPageEnvelope,
);
const decodeDeltaEnvelope = Schema.decodeUnknownEffect(AetherConversationDeltaEnvelope);

export interface AetherRestClientOptions {
  /** Aether API origin, e.g. `https://api.runaether.dev` (trailing slashes tolerated). */
  readonly apiBaseUrl: string;
  /** The instance's `AETHER_API_KEY`, sent as a bearer token. */
  readonly apiKey: string;
  readonly httpClient: HttpClient.HttpClient;
  /** Per-request timeout override; defaults to 30s. */
  readonly timeoutMs?: number;
}

export interface AetherRestClient {
  /** `POST /tasks` → 202 `{id, name}`. */
  readonly createTask: (
    request: AetherCreateTaskRequest,
  ) => Effect.Effect<AetherCreateTaskResponse, AetherRestError>;
  /** `POST /tasks/{id}/respond` → 202 `{message_id}`. */
  readonly respondToTask: (
    taskId: string,
    request: AetherRespondToTaskRequest,
  ) => Effect.Effect<AetherRespondToTaskResponse, AetherRestError>;
  /** `POST /tasks/{id}/stop` — discarding queued messages is an explicit choice. */
  readonly stopTask: (
    taskId: string,
    input: { readonly discardQueuedMessages: boolean },
  ) => Effect.Effect<void, AetherRestError>;
  /** `POST /tasks/{id}/remove-from-queue`. */
  readonly removeFromQueue: (
    taskId: string,
    messageId: string,
  ) => Effect.Effect<void, AetherRestError>;
  /** `PUT /tasks/{id}` — FULL settings replace (see AetherUpdateTaskRequest). */
  readonly updateTask: (
    taskId: string,
    request: AetherUpdateTaskRequest,
  ) => Effect.Effect<AetherTask, AetherRestError>;
  /** `GET /tasks/{id}` → the status-discriminated task union. */
  readonly getTask: (taskId: string) => Effect.Effect<AetherTask, AetherRestError>;
  /**
   * `GET /tasks/{id}/conversation/messages` — the latest page, or the page
   * older than `before`. The server requires the cursor's `before` sequence
   * and `beforeSortTimestamp` together (tasks_openapi.go
   * conversationPageCursorFromParams); a page's own
   * `oldestSequenceLoaded`/`oldestSortTimestampLoaded` is the next cursor.
   */
  readonly getConversationMessages: (
    taskId: string,
    before?: { readonly sequence: number; readonly sortTimestamp: string },
  ) => Effect.Effect<AetherConversationMessagesPage, AetherRestError>;
  /** `GET /tasks/{id}/conversation/delta?after={sequence}`. */
  readonly getConversationDelta: (
    taskId: string,
    after: number,
  ) => Effect.Effect<AetherConversationDelta, AetherRestError>;
  /**
   * `POST /workspaces/{id}/connect?start=...` → the state-discriminated
   * connect union. `start` is the POSITIVE permission to boot the workspace
   * (a query flag on the aether router, workspaces_openapi.go:69-78):
   * `start:false` is the passive attach that treats a not-running workspace
   * as durable-only and NEVER boots a VM just to view; `start:true` is
   * reserved for user-initiated turns (T6). The 409 conflict union decodes
   * into the `conflict` outcome variant — it is a state to branch on, not an
   * error.
   */
  readonly connectWorkspace: (
    workspaceId: string,
    input: { readonly start: boolean },
  ) => Effect.Effect<AetherWorkspaceConnectOutcome, AetherRestError>;
  /** `GET /projects` → the caller's linked projects. */
  readonly listProjects: () => Effect.Effect<ReadonlyArray<AetherProject>, AetherRestError>;
  /** `GET /profile` — identity probe (same schema the provider probe uses). */
  readonly getProfile: () => Effect.Effect<AetherProfileResponse, AetherRestError>;
}

export function makeAetherRestClient(options: AetherRestClientOptions): AetherRestClient {
  const baseUrl = options.apiBaseUrl.replace(/\/+$/, "");
  const timeoutMs = options.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const httpClient = options.httpClient;

  const prepare = (request: HttpClientRequest.HttpClientRequest) =>
    request.pipe(
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.bearerToken(options.apiKey),
    );

  /**
   * The 409/402/… bodies are informative but optional: a non-JSON error body
   * degrades to the HTTP status text instead of masking the real failure
   * with a decode error.
   */
  const readErrorBody = (response: HttpClientResponse.HttpClientResponse) =>
    response.json.pipe(
      Effect.flatMap(decodeErrorBody),
      Effect.orElseSucceed(() => ({}) as typeof AetherErrorBody.Type),
    );

  const mapErrorStatus = (
    endpoint: string,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<never, AetherRestError> =>
    Effect.gen(function* () {
      const body = yield* readErrorBody(response);
      const detail = body.error ?? `HTTP ${response.status}`;
      switch (response.status) {
        case 401:
          return yield* new AetherApiAuthError({ endpoint, detail });
        case 402:
          return yield* new AetherApiPaymentRequiredError({ endpoint, detail });
        case 404:
          return yield* new AetherApiNotFoundError({ endpoint, detail });
        case 409:
          return yield* new AetherApiConflictError({
            endpoint,
            detail,
            ...(body.code !== undefined ? { code: body.code } : {}),
            ...(body.awaiting_input_kind !== undefined
              ? { awaitingInputKind: body.awaiting_input_kind }
              : {}),
          });
        default:
          if (response.status >= 500) {
            return yield* new AetherApiTransportError({
              endpoint,
              detail,
              status: response.status,
            });
          }
          return yield* new AetherApiRequestError({
            endpoint,
            status: response.status,
            detail,
          });
      }
    });

  /** Execute with timeout, then map every non-2xx status to its typed error. */
  const execute = (
    endpoint: string,
    request: HttpClientRequest.HttpClientRequest,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, AetherRestError> =>
    httpClient.execute(prepare(request)).pipe(
      Effect.timeout(timeoutMs),
      Effect.mapError(
        (cause) =>
          new AetherApiTransportError({
            endpoint,
            detail: `Request failed before a response arrived: ${String(cause)}`,
            cause,
          }),
      ),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? Effect.succeed(response)
          : mapErrorStatus(endpoint, response),
      ),
    );

  const readJson = (
    endpoint: string,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<unknown, AetherApiDecodeError> =>
    response.json.pipe(
      Effect.mapError(
        (cause) =>
          new AetherApiDecodeError({
            endpoint,
            detail: "Response body is not valid JSON.",
            cause,
          }),
      ),
    );

  const decodeWith =
    <A>(endpoint: string, decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>) =>
    (input: unknown): Effect.Effect<A, AetherApiDecodeError> =>
      decode(input).pipe(
        Effect.mapError(
          (cause) =>
            new AetherApiDecodeError({
              endpoint,
              detail: "Response body did not match the expected schema.",
              cause,
            }),
        ),
      );

  const getJson = <A>(
    endpoint: string,
    url: string,
    decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ): Effect.Effect<A, AetherRestError> =>
    execute(endpoint, HttpClientRequest.get(url)).pipe(
      Effect.flatMap((response) => readJson(endpoint, response)),
      Effect.flatMap(decodeWith(endpoint, decode)),
    );

  const requestWithJsonBody = (
    endpoint: string,
    request: HttpClientRequest.HttpClientRequest,
    body: unknown,
  ): Effect.Effect<HttpClientResponse.HttpClientResponse, AetherRestError> =>
    request.pipe(
      HttpClientRequest.bodyJson(body),
      Effect.mapError(
        (cause) =>
          new AetherApiRequestError({
            endpoint,
            status: 0,
            detail: `Request body could not be encoded as JSON: ${String(cause)}`,
            cause,
          }),
      ),
      Effect.flatMap((prepared) => execute(endpoint, prepared)),
    );

  const postJson = <A>(
    endpoint: string,
    url: string,
    body: unknown,
    decode: (input: unknown) => Effect.Effect<A, Schema.SchemaError>,
  ): Effect.Effect<A, AetherRestError> =>
    requestWithJsonBody(endpoint, HttpClientRequest.post(url), body).pipe(
      Effect.flatMap((response) => readJson(endpoint, response)),
      Effect.flatMap(decodeWith(endpoint, decode)),
    );

  const postJsonVoid = (
    endpoint: string,
    url: string,
    body: unknown,
  ): Effect.Effect<void, AetherRestError> =>
    requestWithJsonBody(endpoint, HttpClientRequest.post(url), body).pipe(Effect.asVoid);

  // The task union needs a two-stage decode (envelope, then status-probe
  // dispatch); these wrap `decodeAetherTask` for the flattened
  // GET/PUT /tasks/{id} responses and the conversation envelopes.
  const decodeTaskResponse = (endpoint: string) => (input: unknown) =>
    decodeWith(endpoint, decodeAetherTask)(input);

  const decodeMessagesPage =
    (endpoint: string) =>
    (input: unknown): Effect.Effect<AetherConversationMessagesPage, AetherApiDecodeError> =>
      decodeWith(
        endpoint,
        decodeMessagesPageEnvelope,
      )(input).pipe(
        Effect.flatMap((envelope) =>
          decodeWith(
            endpoint,
            decodeAetherTask,
          )(envelope.task).pipe(Effect.map((task) => ({ ...envelope, task }))),
        ),
      );

  const decodeDelta =
    (endpoint: string) =>
    (input: unknown): Effect.Effect<AetherConversationDelta, AetherApiDecodeError> =>
      decodeWith(
        endpoint,
        decodeDeltaEnvelope,
      )(input).pipe(
        Effect.flatMap((envelope) =>
          decodeWith(
            endpoint,
            decodeAetherTask,
          )(envelope.task).pipe(Effect.map((task) => ({ ...envelope, task }))),
        ),
      );

  return {
    createTask: (request) =>
      postJson("POST /tasks", `${baseUrl}/tasks`, request, decodeCreateTaskResponse),

    respondToTask: (taskId, request) =>
      postJson(
        "POST /tasks/{id}/respond",
        `${baseUrl}/tasks/${taskId}/respond`,
        request,
        decodeRespondToTaskResponse,
      ),

    stopTask: (taskId, input) =>
      postJsonVoid("POST /tasks/{id}/stop", `${baseUrl}/tasks/${taskId}/stop`, {
        discard_queued_messages: input.discardQueuedMessages,
      }),

    removeFromQueue: (taskId, messageId) =>
      postJsonVoid(
        "POST /tasks/{id}/remove-from-queue",
        `${baseUrl}/tasks/${taskId}/remove-from-queue`,
        { message_id: messageId },
      ),

    updateTask: (taskId, request) => {
      const endpoint = "PUT /tasks/{id}";
      return requestWithJsonBody(
        endpoint,
        HttpClientRequest.put(`${baseUrl}/tasks/${taskId}`),
        request,
      ).pipe(
        Effect.flatMap((response) => readJson(endpoint, response)),
        Effect.flatMap(decodeTaskResponse(endpoint)),
      );
    },

    getTask: (taskId) =>
      execute("GET /tasks/{id}", HttpClientRequest.get(`${baseUrl}/tasks/${taskId}`)).pipe(
        Effect.flatMap((response) => readJson("GET /tasks/{id}", response)),
        Effect.flatMap(decodeTaskResponse("GET /tasks/{id}")),
      ),

    getConversationMessages: (taskId, before) => {
      const endpoint = "GET /tasks/{id}/conversation/messages";
      const query =
        before === undefined
          ? ""
          : `?before=${encodeURIComponent(before.sequence)}&beforeSortTimestamp=${encodeURIComponent(before.sortTimestamp)}`;
      return execute(
        endpoint,
        HttpClientRequest.get(`${baseUrl}/tasks/${taskId}/conversation/messages${query}`),
      ).pipe(
        Effect.flatMap((response) => readJson(endpoint, response)),
        Effect.flatMap(decodeMessagesPage(endpoint)),
      );
    },

    getConversationDelta: (taskId, after) => {
      const endpoint = "GET /tasks/{id}/conversation/delta";
      return execute(
        endpoint,
        HttpClientRequest.get(
          `${baseUrl}/tasks/${taskId}/conversation/delta?after=${encodeURIComponent(after)}`,
        ),
      ).pipe(
        Effect.flatMap((response) => readJson(endpoint, response)),
        Effect.flatMap(decodeDelta(endpoint)),
      );
    },

    connectWorkspace: (workspaceId, input) => {
      const endpoint = "POST /workspaces/{id}/connect";
      const url = `${baseUrl}/workspaces/${workspaceId}/connect?start=${input.start ? "true" : "false"}`;
      // The 409 conflict union is a decoded OUTCOME here, so this request
      // cannot go through `execute` (which maps every non-2xx to an error).
      return httpClient.execute(prepare(HttpClientRequest.post(url))).pipe(
        Effect.timeout(timeoutMs),
        Effect.mapError(
          (cause) =>
            new AetherApiTransportError({
              endpoint,
              detail: `Request failed before a response arrived: ${String(cause)}`,
              cause,
            }),
        ),
        Effect.flatMap((response) => {
          if (response.status >= 200 && response.status < 300) {
            return readJson(endpoint, response).pipe(
              Effect.flatMap(decodeWith(endpoint, decodeAetherConnectResponse)),
            );
          }
          if (response.status === 409) {
            return readJson(endpoint, response).pipe(
              Effect.flatMap(decodeWith(endpoint, decodeAetherConnectConflict)),
              Effect.map((conflict) => ({ state: "conflict", conflict }) as const),
            );
          }
          return mapErrorStatus(endpoint, response);
        }),
      );
    },

    listProjects: () =>
      getJson("GET /projects", `${baseUrl}/projects`, decodeProjectListResponse).pipe(
        Effect.map((response) => response.projects),
      ),

    getProfile: () => getJson("GET /profile", `${baseUrl}/profile`, decodeProfileResponse),
  } satisfies AetherRestClient;
}

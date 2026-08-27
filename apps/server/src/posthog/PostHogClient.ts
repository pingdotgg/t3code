/**
 * PostHogClient - server-side proxy for the PostHog self-driving reports API.
 *
 * The personal API key never reaches a client: it is read from the secret
 * store per request and only the decoded report data goes back over RPC.
 *
 * @module PostHogClient
 */
import {
  type PostHogCurrentUserInput,
  type PostHogCurrentUserResult,
  PostHogCloudCommandResult,
  PostHogCloudModel,
  PostHogCloudRun,
  PostHogCloudRunArtifact,
  type PostHogCloudRunId,
  type PostHogCloudStreamEvent,
  PostHogCloudTask,
  type PostHogCloudTaskId,
  PostHogNotConfiguredError,
  PostHogReport,
  PostHogReportArtefact,
  type PostHogReportArtefactsInput,
  type PostHogReportArtefactsResult,
  type PostHogReportsListInput,
  type PostHogReportsListResult,
  type PostHogReportSignalsInput,
  type PostHogReportSignalsResult,
  PostHogSignal,
  PostHogRequestError,
  type PostHogRpcError,
  type PostHogSetReportStateInput,
  type PostHogSetReportStateResult,
  type PostHogSetReviewersInput,
  type PostHogSetReviewersResult,
  PostHogUnauthorizedError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { POSTHOG_API_KEY_SECRET_NAME, ServerSettingsService } from "../serverSettings.ts";
import { decodePostHogSse } from "./PostHogSse.ts";

const DEFAULT_LIST_LIMIT = 50;
const ARTEFACTS_LIST_LIMIT = 200;

const textDecoder = new TextDecoder();

// PostHog paginates with DRF's LimitOffsetPagination.
const PaginatedReports = Schema.Struct({
  count: Schema.Number,
  results: Schema.Array(PostHogReport),
});
const PaginatedArtefacts = Schema.Struct({
  results: Schema.Array(PostHogReportArtefact),
});
const decodePaginatedReports = Schema.decodeUnknownEffect(PaginatedReports);
const decodePaginatedArtefacts = Schema.decodeUnknownEffect(PaginatedArtefacts);
// The signals endpoint answers with the report plus its full signal list, not
// a paginated envelope.
const ReportSignalsBody = Schema.Struct({
  signals: Schema.Array(PostHogSignal),
});
const decodeReportSignals = Schema.decodeUnknownEffect(ReportSignalsBody);
const decodeReport = Schema.decodeUnknownEffect(PostHogReport);
// Account-scoped, and its own serializer: `/api/users/@me/` does not carry the
// GitHub login, only this sub-resource does.
const CurrentUserBody = Schema.Struct({
  github_login: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeCurrentUser = Schema.decodeUnknownEffect(CurrentUserBody);
const decodeArtefact = Schema.decodeUnknownEffect(PostHogReportArtefact);
const CloudModelsBody = Schema.Struct({ models: Schema.Array(PostHogCloudModel) });
const decodeCloudModels = Schema.decodeUnknownEffect(CloudModelsBody);
const decodeCloudTask = Schema.decodeUnknownEffect(PostHogCloudTask);
const decodeCloudRun = Schema.decodeUnknownEffect(PostHogCloudRun);
const decodeCloudCommandResult = Schema.decodeUnknownEffect(PostHogCloudCommandResult);
const CloudArtifactsBody = Schema.Struct({ artifacts: Schema.Array(PostHogCloudRunArtifact) });
const decodeCloudArtifacts = Schema.decodeUnknownEffect(CloudArtifactsBody);

interface CreateCloudTaskInput {
  readonly title: string;
  readonly description: string;
  readonly repository?: string;
  readonly signalReportId?: string;
}

interface RunCloudTaskInput {
  readonly taskId: PostHogCloudTaskId;
  readonly message: string;
  readonly resumeFromRunId?: PostHogCloudRunId;
  readonly runtimeAdapter: "claude" | "codex";
  readonly model: string;
  readonly reasoningEffort?: string;
  readonly artifactIds?: ReadonlyArray<string>;
}

interface CloudRunInput {
  readonly taskId: PostHogCloudTaskId;
  readonly runId: PostHogCloudRunId;
}

interface CloudCommandInput extends CloudRunInput {
  readonly method: string;
  readonly params?: Readonly<Record<string, unknown>>;
  readonly id?: string;
}

interface CloudArtifactUploadInput extends CloudRunInput {
  readonly artifacts: ReadonlyArray<{
    readonly name: string;
    readonly contentType: string;
    readonly base64: string;
  }>;
}

interface CloudStreamInput extends CloudRunInput {
  readonly lastEventId?: string;
  readonly startLatest?: boolean;
}

export class PostHogClient extends Context.Service<
  PostHogClient,
  {
    readonly listReports: (
      input: PostHogReportsListInput,
    ) => Effect.Effect<PostHogReportsListResult, PostHogRpcError>;
    readonly listReportArtefacts: (
      input: PostHogReportArtefactsInput,
    ) => Effect.Effect<PostHogReportArtefactsResult, PostHogRpcError>;
    readonly listReportSignals: (
      input: PostHogReportSignalsInput,
    ) => Effect.Effect<PostHogReportSignalsResult, PostHogRpcError>;
    readonly setReportState: (
      input: PostHogSetReportStateInput,
    ) => Effect.Effect<PostHogSetReportStateResult, PostHogRpcError>;
    readonly getCurrentUser: (
      input: PostHogCurrentUserInput,
    ) => Effect.Effect<PostHogCurrentUserResult, PostHogRpcError>;
    readonly setReviewers: (
      input: PostHogSetReviewersInput,
    ) => Effect.Effect<PostHogSetReviewersResult, PostHogRpcError>;
    readonly listCloudModels: () => Effect.Effect<
      ReadonlyArray<PostHogCloudModel>,
      PostHogRpcError
    >;
    readonly createCloudTask: (
      input: CreateCloudTaskInput,
    ) => Effect.Effect<PostHogCloudTask, PostHogRpcError>;
    readonly runCloudTask: (
      input: RunCloudTaskInput,
    ) => Effect.Effect<PostHogCloudTask, PostHogRpcError>;
    readonly getCloudRun: (input: CloudRunInput) => Effect.Effect<PostHogCloudRun, PostHogRpcError>;
    readonly commandCloudRun: (
      input: CloudCommandInput,
    ) => Effect.Effect<PostHogCloudCommandResult, PostHogRpcError>;
    readonly cancelCloudRun: (
      input: CloudRunInput,
    ) => Effect.Effect<PostHogCloudRun, PostHogRpcError>;
    readonly uploadCloudRunArtifacts: (
      input: CloudArtifactUploadInput,
    ) => Effect.Effect<ReadonlyArray<PostHogCloudRunArtifact>, PostHogRpcError>;
    readonly readCloudRunLogs: (input: CloudRunInput) => Effect.Effect<string, PostHogRpcError>;
    readonly streamCloudRun: (
      input: CloudStreamInput,
    ) => Effect.Effect<Stream.Stream<PostHogCloudStreamEvent, PostHogRpcError>, PostHogRpcError>;
  }
>()("t3/posthog/PostHogClient") {}

interface PostHogConnection {
  readonly host: string;
  readonly projectId: string;
  readonly apiKey: string;
}

const cloudRunPath = (input: CloudRunInput, suffix = "") =>
  `/tasks/${encodeURIComponent(input.taskId)}/runs/${encodeURIComponent(input.runId)}/${suffix}`;

export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const serverSettings = yield* ServerSettingsService;
  const secretStore = yield* ServerSecretStore.ServerSecretStore;

  const resolveConnection: Effect.Effect<PostHogConnection, PostHogRpcError> = Effect.gen(
    function* () {
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: "Failed to read PostHog settings.", cause }),
        ),
      );
      const secret = yield* secretStore
        .get(POSTHOG_API_KEY_SECRET_NAME)
        .pipe(
          Effect.mapError(
            (cause) =>
              new PostHogRequestError({ message: "Failed to read the PostHog API key.", cause }),
          ),
        );
      const host = settings.posthog.host.replace(/\/+$/, "");
      const projectId = settings.posthog.projectId;
      const apiKey = Option.isSome(secret) ? textDecoder.decode(secret.value).trim() : "";
      const missing: Array<"host" | "projectId" | "apiKey"> = [];
      if (host.length === 0) missing.push("host");
      if (projectId.length === 0) missing.push("projectId");
      if (apiKey.length === 0) missing.push("apiKey");
      if (missing.length > 0) {
        return yield* new PostHogNotConfiguredError({ missing });
      }
      return { host, projectId, apiKey };
    },
  );

  const getUrlJson = Effect.fn("PostHogClient.getUrlJson")(function* (
    connection: PostHogConnection,
    url: string,
    urlParams: Record<string, string>,
  ) {
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setUrlParams(urlParams),
      HttpClientRequest.setHeaders({
        accept: "application/json",
        authorization: `Bearer ${connection.apiKey}`,
      }),
    );
    const response = yield* httpClient
      .execute(request)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: `PostHog request failed: ${cause.message}`, cause }),
        ),
      );
    if (response.status === 401 || response.status === 403) {
      return yield* new PostHogUnauthorizedError({ status: response.status });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new PostHogRequestError({
        message: `PostHog answered ${response.status} for ${url}.`,
        status: response.status,
      });
    }
    return yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({ message: "PostHog returned an unreadable body.", cause }),
      ),
    );
  });

  /** Project-scoped read. Most of the PostHog API this app touches lives here. */
  const getJson = (
    connection: PostHogConnection,
    path: string,
    urlParams: Record<string, string>,
  ) =>
    getUrlJson(
      connection,
      `${connection.host}/api/projects/${encodeURIComponent(connection.projectId)}${path}`,
      urlParams,
    );

  const sendJson = Effect.fn("PostHogClient.sendJson")(function* (
    connection: PostHogConnection,
    method: "post" | "put",
    path: string,
    body: unknown,
  ) {
    const url = `${connection.host}/api/projects/${encodeURIComponent(connection.projectId)}${path}`;
    const request = (
      method === "put" ? HttpClientRequest.put(url) : HttpClientRequest.post(url)
    ).pipe(
      HttpClientRequest.setHeaders({
        accept: "application/json",
        authorization: `Bearer ${connection.apiKey}`,
      }),
      HttpClientRequest.bodyJsonUnsafe(body),
    );
    const response = yield* httpClient
      .execute(request)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: `PostHog request failed: ${cause.message}`, cause }),
        ),
      );
    if (response.status === 401 || response.status === 403) {
      return yield* new PostHogUnauthorizedError({ status: response.status });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new PostHogRequestError({
        message: `PostHog answered ${response.status} for ${path}.`,
        status: response.status,
      });
    }
    return yield* response.json.pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({ message: "PostHog returned an unreadable body.", cause }),
      ),
    );
  });

  const listReports: PostHogClient["Service"]["listReports"] = Effect.fn(
    "PostHogClient.listReports",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const body = yield* getJson(connection, "/signals/reports/", {
      limit: String(input.limit ?? DEFAULT_LIST_LIMIT),
      ...(input.status ? { status: input.status } : {}),
    });
    const page = yield* decodePaginatedReports(body).pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({
            message: "PostHog returned an unexpected report list.",
            cause,
          }),
      ),
    );
    return { reports: page.results, count: page.count };
  });

  const listReportArtefacts: PostHogClient["Service"]["listReportArtefacts"] = Effect.fn(
    "PostHogClient.listReportArtefacts",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const body = yield* getJson(
      connection,
      `/signals/reports/${encodeURIComponent(input.reportId)}/artefacts/`,
      { limit: String(ARTEFACTS_LIST_LIMIT) },
    );
    const page = yield* decodePaginatedArtefacts(body).pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({
            message: "PostHog returned an unexpected artefact list.",
            cause,
          }),
      ),
    );
    return { artefacts: page.results };
  });

  const listReportSignals: PostHogClient["Service"]["listReportSignals"] = Effect.fn(
    "PostHogClient.listReportSignals",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const body = yield* getJson(
      connection,
      `/signals/reports/${encodeURIComponent(input.reportId)}/signals/`,
      {},
    );
    const decoded = yield* decodeReportSignals(body).pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({
            message: "PostHog returned an unexpected signal list.",
            cause,
          }),
      ),
    );
    return { signals: decoded.signals };
  });

  const setReportState: PostHogClient["Service"]["setReportState"] = Effect.fn(
    "PostHogClient.setReportState",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const body = yield* sendJson(
      connection,
      "post",
      `/signals/reports/${encodeURIComponent(input.reportId)}/state/`,
      { state: input.state },
    );
    const report = yield* decodeReport(body).pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({ message: "PostHog returned an unexpected report.", cause }),
      ),
    );
    return { report };
  });

  const getCurrentUser: PostHogClient["Service"]["getCurrentUser"] = Effect.fn(
    "PostHogClient.getCurrentUser",
  )(function* () {
    const connection = yield* resolveConnection;
    const body = yield* getUrlJson(
      connection,
      `${connection.host}/api/users/@me/github_login/`,
      {},
    );
    const decoded = yield* decodeCurrentUser(body).pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({ message: "PostHog returned an unexpected user.", cause }),
      ),
    );
    return { github_login: decoded.github_login ?? null };
  });

  const setReviewers: PostHogClient["Service"]["setReviewers"] = Effect.fn(
    "PostHogClient.setReviewers",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const body = yield* sendJson(
      connection,
      "put",
      `/signals/reports/${encodeURIComponent(input.reportId)}/reviewers/`,
      { content: input.content },
    );
    const artefact = yield* decodeArtefact(body).pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({ message: "PostHog returned an unexpected artefact.", cause }),
      ),
    );
    return { artefact };
  });

  const listCloudModels: PostHogClient["Service"]["listCloudModels"] = Effect.fn(
    "PostHogClient.listCloudModels",
  )(function* () {
    const connection = yield* resolveConnection;
    const body = yield* getJson(connection, "/tasks/models/", {});
    const decoded = yield* decodeCloudModels(body).pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({
            message: "PostHog returned an unexpected model catalogue.",
            cause,
          }),
      ),
    );
    return decoded.models;
  });

  const createCloudTask: PostHogClient["Service"]["createCloudTask"] = Effect.fn(
    "PostHogClient.createCloudTask",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const body = yield* sendJson(connection, "post", "/tasks/", {
      title: input.title,
      description: input.description,
      origin_product: input.signalReportId ? "signal_report" : "user_created",
      ...(input.repository && !input.signalReportId ? { repository: input.repository } : {}),
      ...(input.signalReportId
        ? { signal_report: input.signalReportId, signal_report_task_relationship: "discussion" }
        : {}),
    });
    return yield* decodeCloudTask(body).pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({ message: "PostHog returned an unexpected Task.", cause }),
      ),
    );
  });

  const runCloudTask: PostHogClient["Service"]["runCloudTask"] = Effect.fn(
    "PostHogClient.runCloudTask",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const body = yield* sendJson(
      connection,
      "post",
      `/tasks/${encodeURIComponent(input.taskId)}/run/`,
      {
        mode: "interactive",
        pending_user_message: input.message,
        runtime_adapter: input.runtimeAdapter,
        model: input.model,
        auto_publish: false,
        ...(input.resumeFromRunId ? { resume_from_run_id: input.resumeFromRunId } : {}),
        ...(input.reasoningEffort ? { reasoning_effort: input.reasoningEffort } : {}),
        ...(input.artifactIds && input.artifactIds.length > 0
          ? { pending_user_artifact_ids: input.artifactIds }
          : {}),
      },
    );
    return yield* decodeCloudTask(body).pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({ message: "PostHog returned an unexpected Task run.", cause }),
      ),
    );
  });

  const getCloudRun: PostHogClient["Service"]["getCloudRun"] = Effect.fn(
    "PostHogClient.getCloudRun",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const body = yield* getJson(connection, cloudRunPath(input), {});
    return yield* decodeCloudRun(body).pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({ message: "PostHog returned an unexpected TaskRun.", cause }),
      ),
    );
  });

  const commandCloudRun: PostHogClient["Service"]["commandCloudRun"] = Effect.fn(
    "PostHogClient.commandCloudRun",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const body = yield* sendJson(connection, "post", cloudRunPath(input, "command/"), {
      jsonrpc: "2.0",
      method: input.method,
      params: input.params ?? {},
      ...(input.id ? { id: input.id } : {}),
    });
    return yield* decodeCloudCommandResult(body).pipe(
      Effect.orElseSucceed(() => ({ response: body })),
    );
  });

  const cancelCloudRun: PostHogClient["Service"]["cancelCloudRun"] = Effect.fn(
    "PostHogClient.cancelCloudRun",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const body = yield* sendJson(connection, "post", cloudRunPath(input, "cancel/"), {});
    return yield* decodeCloudRun(body).pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({
            message: "PostHog returned an unexpected cancelled TaskRun.",
            cause,
          }),
      ),
    );
  });

  const uploadCloudRunArtifacts: PostHogClient["Service"]["uploadCloudRunArtifacts"] = Effect.fn(
    "PostHogClient.uploadCloudRunArtifacts",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const body = yield* sendJson(connection, "post", cloudRunPath(input, "artifacts/"), {
      artifacts: input.artifacts.map((artifact) => ({
        name: artifact.name,
        type: "user_attachment",
        source: "t3code",
        content: artifact.base64,
        content_encoding: "base64",
        content_type: artifact.contentType,
      })),
    });
    const decoded = yield* decodeCloudArtifacts(body).pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({
            message: "PostHog returned unexpected Cloud Task artifacts.",
            cause,
          }),
      ),
    );
    return decoded.artifacts;
  });

  const readCloudRunLogs: PostHogClient["Service"]["readCloudRunLogs"] = Effect.fn(
    "PostHogClient.readCloudRunLogs",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const url = `${connection.host}/api/projects/${encodeURIComponent(connection.projectId)}${cloudRunPath(input, "logs/")}`;
    const response = yield* httpClient
      .execute(
        HttpClientRequest.get(url).pipe(
          HttpClientRequest.setHeaders({ authorization: `Bearer ${connection.apiKey}` }),
        ),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: `PostHog request failed: ${cause.message}`, cause }),
        ),
      );
    if (response.status === 401 || response.status === 403) {
      return yield* new PostHogUnauthorizedError({ status: response.status });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new PostHogRequestError({
        message: `PostHog answered ${response.status} while reading Cloud Task logs.`,
        status: response.status,
      });
    }
    return yield* response.text.pipe(
      Effect.mapError(
        (cause) =>
          new PostHogRequestError({
            message: "PostHog returned unreadable Cloud Task logs.",
            cause,
          }),
      ),
    );
  });

  const streamCloudRun: PostHogClient["Service"]["streamCloudRun"] = Effect.fn(
    "PostHogClient.streamCloudRun",
  )(function* (input) {
    const connection = yield* resolveConnection;
    const url = `${connection.host}/api/projects/${encodeURIComponent(connection.projectId)}${cloudRunPath(input, "stream/")}`;
    const request = HttpClientRequest.get(url).pipe(
      HttpClientRequest.setUrlParams(input.startLatest ? { start: "latest" } : {}),
      HttpClientRequest.setHeaders({
        accept: "text/event-stream",
        authorization: `Bearer ${connection.apiKey}`,
        ...(input.lastEventId ? { "last-event-id": input.lastEventId } : {}),
      }),
    );
    const response = yield* httpClient
      .execute(request)
      .pipe(
        Effect.mapError(
          (cause) =>
            new PostHogRequestError({ message: `PostHog stream failed: ${cause.message}`, cause }),
        ),
      );
    if (response.status === 401 || response.status === 403) {
      return yield* new PostHogUnauthorizedError({ status: response.status });
    }
    if (response.status < 200 || response.status >= 300) {
      return yield* new PostHogRequestError({
        message: `PostHog answered ${response.status} while opening a Cloud Task stream.`,
        status: response.status,
      });
    }
    return decodePostHogSse(response.stream).pipe(
      Stream.mapError(
        (cause) => new PostHogRequestError({ message: "PostHog Cloud Task stream failed.", cause }),
      ),
    );
  });

  return {
    listReports,
    listReportArtefacts,
    listReportSignals,
    setReportState,
    getCurrentUser,
    setReviewers,
    listCloudModels,
    createCloudTask,
    runCloudTask,
    getCloudRun,
    commandCloudRun,
    cancelCloudRun,
    uploadCloudRunArtifacts,
    readCloudRunLogs,
    streamCloudRun,
  } satisfies PostHogClient["Service"];
});

export const layer = Layer.effect(PostHogClient, make);

/**
 * PostHogClient - server-side proxy for the PostHog self-driving reports API.
 *
 * The personal API key never reaches a client: it is read from the secret
 * store per request and only the decoded report data goes back over RPC.
 *
 * @module PostHogClient
 */
import {
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
  PostHogUnauthorizedError,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import { POSTHOG_API_KEY_SECRET_NAME, ServerSettingsService } from "../serverSettings.ts";

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
  }
>()("t3/posthog/PostHogClient") {}

interface PostHogConnection {
  readonly host: string;
  readonly projectId: string;
  readonly apiKey: string;
}

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

  const getJson = Effect.fn("PostHogClient.getJson")(function* (
    connection: PostHogConnection,
    path: string,
    urlParams: Record<string, string>,
  ) {
    const request = HttpClientRequest.get(
      `${connection.host}/api/projects/${encodeURIComponent(connection.projectId)}${path}`,
    ).pipe(
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

  const postJson = Effect.fn("PostHogClient.postJson")(function* (
    connection: PostHogConnection,
    path: string,
    body: unknown,
  ) {
    const request = HttpClientRequest.post(
      `${connection.host}/api/projects/${encodeURIComponent(connection.projectId)}${path}`,
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
    const body = yield* postJson(
      connection,
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

  return {
    listReports,
    listReportArtefacts,
    listReportSignals,
    setReportState,
  } satisfies PostHogClient["Service"];
});

export const layer = Layer.effect(PostHogClient, make);

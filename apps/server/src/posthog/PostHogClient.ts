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
// Account-scoped, and its own serializer: `/api/users/@me/` does not carry the
// GitHub login, only this sub-resource does.
const CurrentUserBody = Schema.Struct({
  github_login: Schema.optional(Schema.NullOr(Schema.String)),
});
const decodeCurrentUser = Schema.decodeUnknownEffect(CurrentUserBody);
const decodeArtefact = Schema.decodeUnknownEffect(PostHogReportArtefact);

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

  return {
    listReports,
    listReportArtefacts,
    listReportSignals,
    setReportState,
    getCurrentUser,
    setReviewers,
  } satisfies PostHogClient["Service"];
});

export const layer = Layer.effect(PostHogClient, make);

import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";

import * as EntireCli from "./EntireCli.ts";
import * as EntireUrls from "../shared/entireUrls.ts";

const NO_REDIRECT: RequestInit = { redirect: "manual" };
const TIMEOUT = Duration.seconds(30);
const API_HOST_SUFFIX = ".api.entire.io";

const EntireApiFailure = Schema.Literals([
  "missing-tool",
  "unauthenticated",
  "rate-limited",
  "not-found",
  "failed",
]);

export class EntireApiError extends Schema.TaggedError<EntireApiError>()("EntireApiError", {
  operation: Schema.String,
  status: Schema.NullOr(Schema.Int),
  reason: EntireApiFailure,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Entire ${this.operation} failed: ${this.detail}`;
  }
}

export interface EntireApiRequest {
  readonly cwd: string;
  readonly repository: string;
  readonly remoteUrl?: string | undefined;
  readonly operation: string;
  readonly method?: "GET" | "POST" | "PATCH" | "PUT";
  readonly path: string;
  readonly scope?: "repository" | "project" | "collection";
  /**
   * Sends the request to this processing cell instead of the repository's: a project trail is
   * served by its project's cell, which a repository mirrored elsewhere does not share.
   */
  readonly cell?: { readonly slug: string; readonly jurisdiction: string };
  readonly headers?: Readonly<Record<string, string>>;
  readonly body?: unknown;
}

type JsonSchema = Schema.Codec<unknown, unknown, never, never>;

export interface EntireApiResponse<A> {
  readonly body: A;
  readonly etag: string | null;
}

export class EntireApi extends Context.Service<
  EntireApi,
  {
    readonly requestJson: <S extends JsonSchema>(
      input: EntireApiRequest,
      schema: S,
    ) => Effect.Effect<EntireApiResponse<S["Type"]>, EntireApiError>;
    readonly repository: (
      input: Pick<EntireApiRequest, "cwd" | "repository" | "remoteUrl" | "operation">,
    ) => Effect.Effect<EntireCli.EntireRepositoryCoordinates, EntireApiError>;
  }
>()("@t3tools/source-control-entire/server/EntireApi") {}

// The CLI names the cell, so a token only ever leaves for an Entire API host over TLS, and only
// the origin is kept from what the CLI said.
export function entireApiOrigin(apiUrl: string): string | null {
  const url = URL.parse(apiUrl.trim());
  if (url === null || url.protocol !== "https:" || url.username || url.password) return null;
  if (url.port !== "" || !url.hostname.toLowerCase().endsWith(API_HOST_SUFFIX)) return null;
  return url.origin;
}

const decodeProblem = Schema.decodeUnknownOption(
  Schema.fromJsonString(
    Schema.Struct({
      title: Schema.optional(Schema.String),
      detail: Schema.optional(Schema.String),
      // Some write routes (merge) answer with a bare `{error: <code>}` instead of a problem.
      error: Schema.optional(Schema.String),
    }),
  ),
);

const reasonForStatus = (status: number): typeof EntireApiFailure.Type =>
  status === 401
    ? "unauthenticated"
    : status === 429
      ? "rate-limited"
      : status === 404
        ? "not-found"
        : "failed";

export const cliFailure = (error: EntireCli.EntireCliError): typeof EntireApiFailure.Type =>
  error._tag === "EntireCliMissingError"
    ? "missing-tool"
    : error._tag === "EntireNotSignedInError"
      ? "unauthenticated"
      : "failed";

export const checkoutEntireRemote = (
  git: SourceControlHost.SourceControlHost["Service"]["git"],
  cwd: string,
) =>
  git.resolvePrimaryRemoteName(cwd).pipe(
    Effect.flatMap((name) =>
      git.readConfigValue(cwd, `remote.${name}.url`).pipe(
        Effect.map((url) => {
          const remote = url === null ? null : EntireUrls.parseEntireRemote(url);
          return remote === null ? null : { ...remote, name };
        }),
      ),
    ),
  );

/** @public */
export const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const cli = yield* EntireCli.EntireCli;
  const { git } = yield* SourceControlHost.SourceControlHost;

  // A clone URL names its own cluster, so `repo view` resolves it even outside the active
  // login's federation.
  const reference = Effect.fn("EntireApi.reference")(function* (
    input: Pick<EntireApiRequest, "cwd" | "repository" | "remoteUrl">,
  ) {
    const remote =
      input.remoteUrl === undefined
        ? yield* checkoutEntireRemote(git, input.cwd).pipe(Effect.orElseSucceed(() => null))
        : EntireUrls.parseEntireRemote(input.remoteUrl);
    return remote && remote.repository.toLowerCase() === input.repository.toLowerCase()
      ? remote.remoteUrl
      : `/${input.repository}`;
  });

  const failure =
    (operation: string) =>
    (fields: Pick<EntireApiError, "status" | "reason" | "detail"> & { cause?: unknown }) =>
      new EntireApiError({
        operation,
        status: fields.status,
        reason: fields.reason,
        detail: fields.detail,
        ...(fields.cause === undefined ? {} : { cause: fields.cause }),
      });

  const locate = Effect.fn("EntireApi.locate")(function* (
    input: Pick<EntireApiRequest, "cwd" | "repository" | "remoteUrl" | "operation">,
  ) {
    const fail = failure(input.operation);
    const repository = EntireUrls.entireRepositoryPath(input.repository);
    if (repository === null || repository.repository !== input.repository)
      return yield* fail({
        status: null,
        reason: "failed",
        detail: "Entire repositories are named gh/<owner>/<repo> or et/<project>/<repo>.",
      });
    const coordinates = yield* cli.repository(yield* reference(input)).pipe(
      Effect.mapError((cause) =>
        fail({
          status: null,
          reason: cliFailure(cause),
          detail:
            cause._tag === "EntireCliMissingError"
              ? "The Entire CLI is not installed on the server."
              : cause._tag === "EntireNotSignedInError"
                ? "The Entire CLI on the server is not signed in. Run entire login."
                : "The Entire CLI could not find the repository.",
          cause,
        }),
      ),
    );
    return { repository, coordinates };
  });

  // Matched on slug and jurisdiction both, as the CLI does: a cell is never guessed.
  const cellApiUrl = Effect.fn("EntireApi.cellApiUrl")(function* (
    cell: NonNullable<EntireApiRequest["cell"]>,
    fail: ReturnType<typeof failure>,
  ) {
    const cells = yield* cli.cells.pipe(
      Effect.mapError((cause) =>
        fail({
          status: null,
          reason: cliFailure(cause),
          detail:
            cause._tag === "EntireCliMissingError"
              ? "The Entire CLI is not installed on the server."
              : cause._tag === "EntireNotSignedInError"
                ? "The Entire CLI on the server is not signed in. Run entire login."
                : "The Entire CLI could not list processing cells.",
          cause,
        }),
      ),
    );
    const match = cells.find(
      (candidate) =>
        candidate.slug === cell.slug &&
        candidate.jurisdiction.toLowerCase() === cell.jurisdiction.toLowerCase(),
    );
    if (match === undefined)
      return yield* fail({
        status: null,
        reason: "failed",
        detail: `Entire's cell list has no ${cell.slug} in ${cell.jurisdiction}.`,
      });
    return match.apiUrl;
  });

  const requestJson = Effect.fn("EntireApi.requestJson")(function* <S extends JsonSchema>(
    input: EntireApiRequest,
    schema: S,
  ) {
    const fail = failure(input.operation);
    const { repository, coordinates } = yield* locate(input);
    const apiUrl =
      input.cell === undefined ? coordinates.apiUrl : yield* cellApiUrl(input.cell, fail);
    const origin = entireApiOrigin(apiUrl);
    if (origin === null)
      return yield* fail({
        status: null,
        reason: "failed",
        detail: `The Entire CLI named ${apiUrl} as the API, which is not an Entire API host.`,
      });
    yield* Effect.annotateCurrentSpan({
      "entire.operation": input.operation,
      "entire.api_origin": origin,
      "http.request.method": input.method ?? "GET",
    });
    // A repository-scoped project trail is served by its repository's cell, as the CLI does.
    const prefix =
      input.scope === "project"
        ? `/api/v1/${encodeURIComponent(repository.forge)}/${encodeURIComponent(repository.owner.toLowerCase())}/trails`
        : input.scope === "collection"
          ? "/api/v1"
          : `/api/v1/repos/${encodeURIComponent(coordinates.repoId)}`;
    const token = yield* cli.token.pipe(
      Effect.mapError((cause) =>
        fail({
          status: null,
          reason: cliFailure(cause),
          detail:
            cause._tag === "EntireCliMissingError"
              ? "The Entire CLI is not installed on the server."
              : cause._tag === "EntireNotSignedInError"
                ? "The Entire CLI on the server is not signed in. Run entire login."
                : "The Entire CLI could not read the authentication token.",
          cause,
        }),
      ),
    );
    const base = HttpClientRequest.make(input.method ?? "GET")(
      `${origin}${prefix}${input.path}`,
    ).pipe(
      HttpClientRequest.setHeaders(input.headers ?? {}),
      HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "t3code" }),
      HttpClientRequest.bearerToken(Redacted.value(token)),
    );
    const { status, text, etag } = yield* Effect.gen(function* () {
      const response = yield* httpClient
        .execute(
          input.body === undefined ? base : base.pipe(HttpClientRequest.bodyJsonUnsafe(input.body)),
        )
        .pipe(
          // The client's own span would record the query string, which can carry search text.
          Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
          // fetch would follow a redirect itself and keep the bearer token on a same-origin
          // hop; Entire's API answers in place, so a 3xx is answered as a failure.
          Effect.provideService(FetchHttpClient.RequestInit, NO_REDIRECT),
        );
      return {
        status: response.status,
        text: yield* response.text,
        etag: response.headers["etag"] ?? null,
      };
    }).pipe(
      Effect.timeout(TIMEOUT),
      Effect.mapError((cause) =>
        fail({ status: null, reason: "failed", detail: "Could not reach Entire.", cause }),
      ),
    );
    yield* Effect.annotateCurrentSpan({ "http.response.status_code": status });
    if (status >= 200 && status < 300) {
      const body = yield* Schema.decodeEffect(Schema.fromJsonString(schema))(text).pipe(
        Effect.mapError((cause) =>
          fail({
            status,
            reason: "failed",
            detail: "Entire returned an unreadable response.",
            cause,
          }),
        ),
      );
      return { body, etag } satisfies EntireApiResponse<S["Type"]>;
    }
    if (status === 401) yield* cli.invalidateToken;
    const problem = Option.getOrUndefined(decodeProblem(text));
    // Trails are a per-repository setting, off by default; every trail route of a repository
    // without them answers this same 404.
    const trailsOff =
      status === 404 &&
      (input.scope ?? "repository") === "repository" &&
      input.path.startsWith("/trails") &&
      problem?.detail === "repository not found";
    return yield* fail({
      status,
      reason: reasonForStatus(status),
      detail: trailsOff
        ? "Trails aren't turned on for this repository on Entire, or you can't see it."
        : (EntireCli.boundedDetail(
            problem?.detail ?? problem?.error?.replaceAll("_", " ") ?? problem?.title,
          ) ?? `Entire answered HTTP ${status}.`),
    });
  });

  return EntireApi.of({
    requestJson,
    repository: Effect.fn("EntireApi.repository")((input) =>
      locate(input).pipe(Effect.map(({ coordinates }) => coordinates)),
    ),
  });
});

export const layer = Layer.effect(EntireApi, make);

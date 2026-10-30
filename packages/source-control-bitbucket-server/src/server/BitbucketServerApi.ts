import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import * as Semaphore from "effect/Semaphore";
import * as SourceControlRateLimit from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as Schema from "effect/Schema";
import {
  NonNegativeInt,
  settingsSecretLiteral,
  TrimmedNonEmptyString,
  type SourceControlProviderAuth,
  type SourceControlRepositoryCloneUrls,
} from "@t3tools/contracts";
import { FetchHttpClient, HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import { sanitizeBranchFragment } from "@t3tools/shared/git";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import {
  parseGitRemoteHost,
  recognizeRemoteWith,
} from "@t3tools/source-control-core/shared/definition";
import { definition } from "../shared/definition.ts";
const detectSourceControlProviderFromRemoteUrl = (url: string) =>
  recognizeRemoteWith(definition, url);

import {
  normalizeBitbucketChangeRequestId,
  type NormalizedBitbucketPullRequestRecord,
} from "./bitbucketServerPullRequests.ts";
import {
  BitbucketServerPullRequestPageSchema,
  BitbucketServerPullRequestSchema,
  BitbucketServerRepositoryRefSchema,
  bitbucketServerRepositoryName,
  normalizeBitbucketServerPullRequestRecord,
  type BitbucketServerRepositoryLocator,
} from "./bitbucketServerPullRequests.ts";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import * as SourceControlProvider from "@t3tools/source-control-core/server/SourceControlProvider";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";

import * as BitbucketServerClient from "../shared/definition.ts";

export const CONFIGURATION_HINT =
  "Add a Bitbucket Data Center host and token in Settings → Source Control, or set T3CODE_BITBUCKET_SERVER_URL and T3CODE_BITBUCKET_SERVER_TOKEN on the server.";

export const API_ROOT = "/rest/api/1.0";
const DEFAULT_MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
export const MAX_PAGE_SIZE = 100;
export const MAX_PAGES = 10;

const BitbucketServerEnvConfig = Config.all({
  baseUrl: Config.String("T3CODE_BITBUCKET_SERVER_URL").pipe(Config.option),
  token: Config.String("T3CODE_BITBUCKET_SERVER_TOKEN").pipe(Config.option),
});

const BitbucketServerApiOperation = Schema.Literals([
  "resolveRepository",
  "getRepository",
  "getDefaultBranch",
  "getPullRequest",
  "listPullRequests",
  "createPullRequest",
  "createRepository",
  "probeAuth",
  "checkoutPullRequest",
  "request",
]);
type BitbucketServerApiOperation = typeof BitbucketServerApiOperation.Type;

export class BitbucketServerNotConfiguredError extends Schema.TaggedError<BitbucketServerNotConfiguredError>()(
  "BitbucketServerNotConfiguredError",
  {},
) {
  get detail(): string {
    return CONFIGURATION_HINT;
  }

  override get message(): string {
    return `Bitbucket Data Center is not configured: ${this.detail}`;
  }
}

export class BitbucketServerHostMismatchError extends Schema.TaggedError<BitbucketServerHostMismatchError>()(
  "BitbucketServerHostMismatchError",
  {
    remoteHost: Schema.String,
    configuredHost: Schema.String,
  },
) {
  get detail(): string {
    return `The remote is on ${this.remoteHost} but the configured Bitbucket Data Center host is ${this.configuredHost}.`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketServerRepositoryLocatorError extends Schema.TaggedError<BitbucketServerRepositoryLocatorError>()(
  "BitbucketServerRepositoryLocatorError",
  {
    repository: Schema.String,
  },
) {
  get detail(): string {
    return "Bitbucket Data Center repositories must be specified as PROJECTKEY/repo-slug.";
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketServerRequestError extends Schema.TaggedError<BitbucketServerRequestError>()(
  "BitbucketServerRequestError",
  {
    operation: BitbucketServerApiOperation,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to send the Bitbucket Data Center request.";
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketServerResponseError extends Schema.TaggedError<BitbucketServerResponseError>()(
  "BitbucketServerResponseError",
  {
    operation: BitbucketServerApiOperation,
    status: Schema.Int,
    responseBodyLength: NonNegativeInt,
    retryAt: Schema.optional(Schema.Number),
    /**
     * What the host said was wrong, out of its structured `errors` list — a disabled merge
     * strategy, a stale version, a missing e-mail. Nothing else of the body is carried.
     */
    hostMessage: Schema.optional(Schema.String),
  },
) {
  get detail(): string {
    return this.hostMessage === undefined
      ? `Bitbucket Data Center returned HTTP ${this.status}.`
      : `Bitbucket Data Center returned HTTP ${this.status}: ${this.hostMessage}`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketServerResponseBodyReadError extends Schema.TaggedError<BitbucketServerResponseBodyReadError>()(
  "BitbucketServerResponseBodyReadError",
  {
    operation: BitbucketServerApiOperation,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Bitbucket Data Center returned HTTP ${this.status}.`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketServerResponseDecodeError extends Schema.TaggedError<BitbucketServerResponseDecodeError>()(
  "BitbucketServerResponseDecodeError",
  {
    operation: BitbucketServerApiOperation,
    status: Schema.Int,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Bitbucket Data Center returned invalid JSON for the requested resource.";
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in ${this.operation}: ${this.detail}`;
  }
}

export class BitbucketServerRepositoryRemotesError extends Schema.TaggedError<BitbucketServerRepositoryRemotesError>()(
  "BitbucketServerRepositoryRemotesError",
  {
    cwd: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to list remotes for ${this.cwd}.`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketServerRepositoryRemoteNotFoundError extends Schema.TaggedError<BitbucketServerRepositoryRemoteNotFoundError>()(
  "BitbucketServerRepositoryRemoteNotFoundError",
  {
    cwd: Schema.String,
  },
) {
  get detail(): string {
    return `No Bitbucket Data Center repository remote was detected for ${this.cwd}.`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in resolveRepository: ${this.detail}`;
  }
}

export class BitbucketServerPullRequestBodyReadError extends Schema.TaggedError<BitbucketServerPullRequestBodyReadError>()(
  "BitbucketServerPullRequestBodyReadError",
  {
    cwd: Schema.String,
    bodyFile: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return `Failed to read pull request body file ${this.bodyFile}.`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in createPullRequest: ${this.detail}`;
  }
}

export class BitbucketServerCheckoutError extends Schema.TaggedError<BitbucketServerCheckoutError>()(
  "BitbucketServerCheckoutError",
  {
    cwd: Schema.String,
    reference: Schema.String,
    cause: Schema.Defect(),
  },
) {
  get detail(): string {
    return "Failed to check out the Bitbucket Data Center pull request.";
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in checkoutPullRequest: ${this.detail}`;
  }
}

export class BitbucketServerUntrustedUrlError extends Schema.TaggedError<BitbucketServerUntrustedUrlError>()(
  "BitbucketServerUntrustedUrlError",
  {
    host: Schema.String,
  },
) {
  get detail(): string {
    return `The url pointed at ${this.host}, outside the configured Bitbucket Data Center.`;
  }

  override get message(): string {
    return `Bitbucket Data Center API failed in request: ${this.detail}`;
  }
}

export const BitbucketServerApiError = Schema.Union([
  SourceControlRateLimit.SourceControlRateLimitPausedError,
  BitbucketServerNotConfiguredError,
  BitbucketServerHostMismatchError,
  BitbucketServerRepositoryLocatorError,
  BitbucketServerRequestError,
  BitbucketServerResponseError,
  BitbucketServerResponseBodyReadError,
  BitbucketServerResponseDecodeError,
  BitbucketServerRepositoryRemotesError,
  BitbucketServerRepositoryRemoteNotFoundError,
  BitbucketServerPullRequestBodyReadError,
  BitbucketServerCheckoutError,
  BitbucketServerUntrustedUrlError,
]);
export type BitbucketServerApiError = typeof BitbucketServerApiError.Type;
export const ExpectedHost = Context.Reference<string | null>("BitbucketServerApi/ExpectedHost", {
  defaultValue: () => null,
});

const isBitbucketServerApiError = Schema.is(BitbucketServerApiError);

const RawBitbucketServerRepositorySchema = Schema.Struct({
  ...BitbucketServerRepositoryRefSchema.fields,
  links: Schema.Struct({
    clone: Schema.optional(
      Schema.Array(
        Schema.Struct({
          name: TrimmedNonEmptyString,
          href: TrimmedNonEmptyString,
        }),
      ),
    ),
    self: Schema.optional(
      Schema.Array(
        Schema.Struct({
          href: TrimmedNonEmptyString,
        }),
      ),
    ),
  }),
});

const RawBitbucketServerDefaultBranchSchema = Schema.Struct({
  displayId: TrimmedNonEmptyString,
});

export class BitbucketServerApi extends Context.Service<
  BitbucketServerApi,
  {
    readonly probeAuth: Effect.Effect<SourceControlProviderAuth, never>;
    readonly resolveRemote: (
      remoteUrl: string,
    ) => Effect.Effect<{ readonly baseUrl: string; readonly repository: string } | null>;
    readonly createRepository: (input: {
      readonly repository: string;
      readonly visibility: "public" | "private";
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, BitbucketServerApiError>;

    readonly request: (input: {
      readonly method: "GET" | "POST" | "PUT" | "DELETE";
      readonly url: string;
      readonly body?: string;
      /** A media type to ask for, where an endpoint answers JSON unless told otherwise. */
      readonly accept?: string;
      readonly maxBytes?: number;
    }) => Effect.Effect<
      { readonly body: string; readonly truncated: boolean },
      BitbucketServerApiError
    >;
    readonly listPullRequests: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly state: "open" | "closed" | "merged" | "all";
      readonly limit?: number;
    }) => Effect.Effect<
      ReadonlyArray<NormalizedBitbucketPullRequestRecord>,
      BitbucketServerApiError
    >;
    readonly getPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly reference: string;
    }) => Effect.Effect<NormalizedBitbucketPullRequestRecord, BitbucketServerApiError>;
    readonly getRepositoryCloneUrls: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly repository: string;
    }) => Effect.Effect<SourceControlRepositoryCloneUrls, BitbucketServerApiError>;
    readonly createPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly baseBranch: string;
      readonly headSelector: string;
      readonly source?: SourceControlProvider.SourceControlRefSelector;
      readonly target?: SourceControlProvider.SourceControlRefSelector;
      readonly title: string;
      readonly bodyFile: string;
    }) => Effect.Effect<NormalizedBitbucketPullRequestRecord, BitbucketServerApiError>;
    readonly getDefaultBranch: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
    }) => Effect.Effect<string | null, BitbucketServerApiError>;
    readonly checkoutPullRequest: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProvider.SourceControlProviderContext;
      readonly reference: string;
      readonly force?: boolean;
    }) => Effect.Effect<void, BitbucketServerApiError>;
  }
>()("@t3tools/source-control-bitbucket-server/server/BitbucketServerApi") {}

interface BitbucketServerConnection {
  readonly baseUrl: string;
  readonly origin: string;
  readonly hostname: string;
  readonly token: string;
}

function nonEmpty(value: string | undefined): Option.Option<string> {
  const trimmed = value?.trim();
  return trimmed === undefined || trimmed.length === 0 ? Option.none() : Option.some(trimmed);
}

/**
 * Visible ASCII only. A value the HTTP stack rejects makes it throw an error quoting the whole
 * header, and that error travels to clients as a cause, so an unusable token is treated as unset.
 */
const HEADER_SAFE = /^[\x21-\x7e]+$/u;

function connectionFrom(input: {
  readonly url: string;
  readonly token: string;
}): Option.Option<BitbucketServerConnection> {
  const token = input.token.trim();
  if (!HEADER_SAFE.test(token)) return Option.none();
  let url: URL;
  try {
    url = new URL(input.url.trim());
  } catch {
    return Option.none();
  }
  if (
    !/^https?:$/u.test(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname === "bitbucket.org" ||
    url.hostname.endsWith(".bitbucket.org")
  )
    return Option.none();
  return Option.some({
    baseUrl: `${url.origin}${url.pathname.replace(/\/+$/u, "")}`,
    origin: url.origin,
    hostname: url.hostname.toLowerCase(),
    token,
  });
}

/**
 * A host and token saved in settings win over the `T3CODE_BITBUCKET_SERVER_*` environment
 * variables, which stay as a fallback. Each source supplies both or neither.
 */
function resolveConnection(
  settings: BitbucketServerClient.BitbucketServerSettings,
  env: Config.Success<typeof BitbucketServerEnvConfig>,
): Option.Option<BitbucketServerConnection> {
  return Option.orElse(
    connectionFrom({ url: settings.url, token: settingsSecretLiteral(settings.token) }),
    () =>
      connectionFrom({
        url: Option.getOrElse(env.baseUrl, () => ""),
        token: Option.getOrElse(env.token, () => ""),
      }),
  );
}

/** `PROJECTKEY/repo-slug`, the last two segments of whatever spelling arrived. */
export function parseRepositoryName(value: string): BitbucketServerRepositoryLocator | null {
  const normalized = value.trim().replace(/\.git$/u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);
  const projectKey = parts.at(-2);
  const repoSlug = parts.at(-1);
  return parts.length >= 2 &&
    projectKey &&
    repoSlug &&
    /^[~A-Za-z0-9._-]+$/u.test(projectKey) &&
    /^[A-Za-z0-9._-]+$/u.test(repoSlug) &&
    ![".", ".."].includes(projectKey) &&
    ![".", ".."].includes(repoSlug)
    ? { projectKey, repoSlug }
    : null;
}

function parseRemoteUrl(remoteUrl: string): BitbucketServerRepositoryLocator | null {
  const trimmed = remoteUrl.trim();
  const scpMatch = /^[a-zA-Z0-9._-]+@[^:/]+:(.+)$/.exec(trimmed);
  if (scpMatch?.[1]) return parseRepositoryName(scpMatch[1]);
  try {
    return parseRepositoryName(new URL(trimmed).pathname);
  } catch {
    return null;
  }
}

export function toBitbucketServerState(state: "open" | "closed" | "merged" | "all"): string {
  switch (state) {
    case "open":
      return "OPEN";
    case "closed":
      return "DECLINED";
    case "merged":
      return "MERGED";
    case "all":
      return "ALL";
  }
}

function sourceOwner(input: {
  readonly headSelector: string;
  readonly source?: SourceControlProvider.SourceControlRefSelector;
}): string | undefined {
  if (input.source?.owner) return input.source.owner;
  return SourceControlProvider.parseSourceControlOwnerRef(input.headSelector)?.owner;
}

function normalizeRepositoryCloneUrls(
  raw: typeof RawBitbucketServerRepositorySchema.Type,
): SourceControlRepositoryCloneUrls {
  const nameWithOwner = bitbucketServerRepositoryName({
    projectKey: raw.project.key,
    repoSlug: raw.slug,
  });
  const httpClone = raw.links.clone?.find((entry) => entry.name.toLowerCase() === "http")?.href;
  const sshClone = raw.links.clone?.find((entry) => entry.name.toLowerCase() === "ssh")?.href;
  const browseUrl = raw.links.self?.[0]?.href;
  return {
    nameWithOwner,
    url: httpClone ?? browseUrl ?? nameWithOwner,
    sshUrl: sshClone ?? httpClone ?? browseUrl ?? nameWithOwner,
  };
}

function checkoutBranchName(input: {
  readonly pullRequestId: number;
  readonly headBranch: string;
  readonly isCrossRepository: boolean;
}): string {
  return input.isCrossRepository
    ? `t3code/pr-${input.pullRequestId}/${sanitizeBranchFragment(input.headBranch)}`
    : input.headBranch;
}

function originOf(value: string): string | null {
  try {
    return new URL(value).origin;
  } catch {
    return null;
  }
}

const readBody = Effect.fn("BitbucketServerApi.readBody")(
  (response: HttpClientResponse.HttpClientResponse, maxBytes = DEFAULT_MAX_RESPONSE_BYTES) =>
    collectUint8StreamText({ stream: response.stream, maxBytes }).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "EmptyBodyError",
        () => Effect.succeed({ text: "", truncated: false, bytes: 0, invalidUtf8: false }),
      ),
    ),
);

const responseError = Effect.fn("BitbucketServerApi.responseError")(function* (
  operation: BitbucketServerApiOperation,
  response: HttpClientResponse.HttpClientResponse,
): Effect.fn.Return<never, BitbucketServerApiError> {
  const now = yield* Clock.currentTimeMillis;
  const collected = yield* readBody(response).pipe(
    Effect.mapError(
      (cause) =>
        new BitbucketServerResponseBodyReadError({
          operation,
          status: response.status,
          cause,
        }),
    ),
  );
  const hostMessage = hostErrorMessage(collected.text);
  return yield* new BitbucketServerResponseError({
    operation,
    status: response.status,
    responseBodyLength: collected.text.length,
    retryAt: retryAtFromHeader(response.headers["retry-after"], now),
    ...(hostMessage === null ? {} : { hostMessage }),
  });
});

const HostErrorsSchema = Schema.Struct({
  errors: Schema.Array(Schema.Struct({ message: Schema.optional(Schema.NullOr(Schema.String)) })),
});
const decodeHostErrors = decodeJsonResult(HostErrorsSchema);
const HOST_MESSAGE_MAX_LENGTH = 500;

/** The host's own account of a refusal, or null where the body is not its `errors` document. */
function hostErrorMessage(body: string): string | null {
  const decoded = decodeHostErrors(body);
  if (!Result.isSuccess(decoded)) return null;
  const message = decoded.success.errors
    .flatMap((error) => {
      const text = error.message?.trim() ?? "";
      return text.length > 0 ? [text] : [];
    })
    .join(" ");
  return message.length === 0 ? null : message.slice(0, HOST_MESSAGE_MAX_LENGTH);
}

const make = Effect.gen(function* () {
  const config = yield* BitbucketServerEnvConfig;
  const host = yield* SourceControlHost.SourceControlHost;
  const git = host.git;
  const httpClient = yield* HttpClient.HttpClient;
  const fileSystem = yield* FileSystem.FileSystem;
  const limits = yield* SourceControlRateLimit.SourceControlRateLimit;
  const slots = yield* Semaphore.make(4);

  // Read on every request so a host and token saved in settings apply without a restart.
  const currentConnection = host.settings.getWithSecrets(definition.kind).pipe(
    Effect.map((settings) =>
      resolveConnection(
        readSourceControlHostSettings(
          BitbucketServerClient.settings,
          settings.sourceControlHosts[BitbucketServerClient.definition.kind],
        ),
        config,
      ),
    ),
    Effect.catch((error) =>
      // No cause: a settings decode error can quote a hand-edited token.
      Effect.logWarning("failed to read Bitbucket Data Center credentials from settings", {
        operation: error.operation,
      }).pipe(
        Effect.as(
          resolveConnection(
            readSourceControlHostSettings(BitbucketServerClient.settings, {}),
            config,
          ),
        ),
      ),
    ),
  );

  const withConnection = <A, E, R>(
    use: (connection: BitbucketServerConnection) => Effect.Effect<A, E, R>,
  ): Effect.Effect<
    A,
    E | BitbucketServerNotConfiguredError | BitbucketServerHostMismatchError,
    R
  > =>
    currentConnection.pipe(
      Effect.flatMap(Effect.fromOption),
      Effect.catchTags({
        NoSuchElementError: () => Effect.fail(new BitbucketServerNotConfiguredError()),
      }),
      Effect.flatMap(
        Effect.fn("BitbucketServerApi.useConnection")(function* (connection) {
          const expected = yield* ExpectedHost;
          const url = new URL(connection.baseUrl);
          if (
            expected !== null &&
            expected.toLowerCase() !== url.host &&
            expected.toLowerCase() !== url.hostname
          ) {
            return yield* new BitbucketServerHostMismatchError({
              remoteHost: expected,
              configuredHost: url.host,
            });
          }
          return yield* use(connection);
        }),
      ),
    );

  const apiUrl = (connection: BitbucketServerConnection, path: string) =>
    `${connection.baseUrl}${API_ROOT}${path}`;

  const repositoryPath = (repository: BitbucketServerRepositoryLocator) =>
    `/projects/${encodeURIComponent(repository.projectKey)}/repos/${encodeURIComponent(repository.repoSlug)}`;

  const send = (
    operation: BitbucketServerApiOperation,
    connection: BitbucketServerConnection,
    request: HttpClientRequest.HttpClientRequest,
  ) =>
    httpClient.execute(request.pipe(HttpClientRequest.bearerToken(connection.token))).pipe(
      Effect.provideService(FetchHttpClient.RequestInit, { redirect: "manual" }),
      Effect.tap((response) =>
        response.status === 429
          ? Effect.gen(function* () {
              const key = { provider: definition.kind, host: new URL(connection.baseUrl).host };
              const lease = yield* limits.check(key, { allowPaused: true });
              const now = yield* Clock.currentTimeMillis;
              yield* limits.recordRateLimit({
                ...key,
                lease,
                retryAt: retryAtFromHeader(response.headers["retry-after"], now),
              });
            })
          : Effect.void,
      ),
      Effect.mapError(
        (cause): BitbucketServerApiError => new BitbucketServerRequestError({ operation, cause }),
      ),
    );

  const runRequest = Effect.fn("BitbucketServerApi.runRequest")(
    function* <A, R>(
      connection: BitbucketServerConnection,
      method: string,
      run: Effect.Effect<A, BitbucketServerApiError, R>,
    ) {
      const key = { provider: definition.kind, host: new URL(connection.baseUrl).host };
      const interactive = yield* SourceControlRateLimit.Interactive;
      const lease = yield* limits.check(
        key,
        interactive || method !== "GET" ? { allowPaused: true } : undefined,
      );
      return yield* run.pipe(
        Effect.tap(() => limits.recordSuccess({ ...key, lease })),
        Effect.timeout("30 seconds"),
        Effect.catchTags({
          TimeoutError: (cause) => new BitbucketServerRequestError({ operation: "request", cause }),
        }),
      );
    },
    (effect) => slots.withPermit(effect),
  );

  const decodeResponse = <S extends Schema.Top>(
    operation: BitbucketServerApiOperation,
    schema: S,
    response: HttpClientResponse.HttpClientResponse,
  ): Effect.Effect<S["Type"], BitbucketServerApiError, S["DecodingServices"]> =>
    HttpClientResponse.matchStatus({
      "2xx": (success) =>
        readBody(success).pipe(
          Effect.flatMap((body) =>
            body.truncated
              ? Effect.fail(
                  new BitbucketServerResponseDecodeError({
                    operation,
                    status: success.status,
                    cause: "Response exceeded the byte limit.",
                  }),
                )
              : Schema.decodeEffect(Schema.fromJsonString(schema))(body.text).pipe(
                  Effect.mapError(
                    (cause) =>
                      new BitbucketServerResponseDecodeError({
                        operation,
                        status: success.status,
                        cause,
                      }),
                  ),
                ),
          ),
          Effect.mapError(
            (cause) =>
              new BitbucketServerResponseDecodeError({
                operation,
                status: success.status,
                cause,
              }),
          ),
        ),
      orElse: (failed) => responseError(operation, failed),
    })(response);

  const executeJson = <S extends Schema.Top>(
    operation: BitbucketServerApiOperation,
    buildRequest: (connection: BitbucketServerConnection) => HttpClientRequest.HttpClientRequest,
    schema: S,
  ): Effect.Effect<S["Type"], BitbucketServerApiError, S["DecodingServices"]> =>
    withConnection((connection) =>
      runRequest(
        connection,
        buildRequest(connection).method,
        send(
          operation,
          connection,
          buildRequest(connection).pipe(HttpClientRequest.acceptJson),
        ).pipe(Effect.flatMap((response) => decodeResponse(operation, schema, response))),
      ),
    );

  const locatorFromRemote = (
    connection: BitbucketServerConnection,
    remoteUrl: string,
  ): Effect.Effect<BitbucketServerRepositoryLocator | null, BitbucketServerHostMismatchError> => {
    const remote = URL.parse(remoteUrl);
    const configured = new URL(connection.baseUrl);
    const hostname = remote?.hostname ?? /^[^@/]+@([^:]+):/u.exec(remoteUrl)?.[1];
    const mount =
      remote && /^https?:$/u.test(remote.protocol)
        ? /^(.*?)\/scm\//u.exec(remote.pathname)?.[1]
        : undefined;
    if (
      hostname?.toLowerCase() !== connection.hostname ||
      (remote &&
        /^https?:$/u.test(remote.protocol) &&
        (remote.origin !== connection.origin || mount !== configured.pathname.replace(/\/$/u, "")))
    ) {
      return Effect.fail(
        new BitbucketServerHostMismatchError({
          remoteHost: remote?.host ?? hostname ?? "unknown",
          configuredHost: configured.host,
        }),
      );
    }
    return Effect.succeed(parseRemoteUrl(remoteUrl));
  };

  const resolveRepository = Effect.fn("BitbucketServerApi.resolveRepository")(function* (input: {
    readonly cwd: string;
    readonly context?: SourceControlProvider.SourceControlProviderContext;
    readonly repository?: string;
    readonly reference?: string;
  }) {
    const connection = yield* withConnection(Effect.succeed);

    if (input.context) yield* locatorFromRemote(connection, input.context.remoteUrl);
    const referenceUrl = input.reference ? URL.parse(input.reference) : null;
    if (referenceUrl) {
      const link = definition.parseChangeRequestUrl(referenceUrl);
      if (
        !link ||
        referenceUrl.origin !== connection.origin ||
        referenceUrl.pathname.match(/^(.*?)\/(?:projects|users)\/[^/]+\/repos\//u)?.[1] !==
          new URL(connection.baseUrl).pathname.replace(/\/$/u, "")
      ) {
        return yield* new BitbucketServerHostMismatchError({
          remoteHost: referenceUrl.host,
          configuredHost: new URL(connection.baseUrl).host,
        });
      }
      const repository = parseRepositoryName(link.repository);
      if (!repository)
        return yield* new BitbucketServerRepositoryLocatorError({ repository: link.repository });
      return repository;
    }
    if (input.repository !== undefined) {
      const fromRepository = URL.canParse(input.repository)
        ? yield* locatorFromRemote(connection, input.repository)
        : parseRepositoryName(input.repository);
      if (fromRepository) return fromRepository;
      return yield* new BitbucketServerRepositoryLocatorError({ repository: input.repository });
    }

    if (input.context?.provider.kind === "bitbucket-server") {
      const fromContext = yield* locatorFromRemote(connection, input.context.remoteUrl);
      if (fromContext) return fromContext;
    }

    const remotes = yield* git.remotes(input.cwd).pipe(
      Effect.flatMap((listRemotes) => listRemotes),
      Effect.mapError(
        (cause) => new BitbucketServerRepositoryRemotesError({ cwd: input.cwd, cause }),
      ),
    );
    for (const remote of remotes.remotes) {
      if (
        detectSourceControlProviderFromRemoteUrl(remote.url)?.kind !== definition.kind &&
        parseGitRemoteHost(remote.url)?.hostname !== connection.hostname
      ) {
        continue;
      }
      const parsed = yield* locatorFromRemote(connection, remote.url);
      if (parsed) return parsed;
    }

    return yield* new BitbucketServerRepositoryRemoteNotFoundError({ cwd: input.cwd });
  });

  const getRepositoryFromLocator = (repository: BitbucketServerRepositoryLocator) =>
    executeJson(
      "getRepository",
      (connection) => HttpClientRequest.get(apiUrl(connection, repositoryPath(repository))),
      RawBitbucketServerRepositorySchema,
    );

  const getRawPullRequest = (repository: BitbucketServerRepositoryLocator, reference: string) =>
    !/^[1-9]\d*$/u.test(normalizeBitbucketChangeRequestId(reference))
      ? Effect.fail(new BitbucketServerRepositoryLocatorError({ repository: reference }))
      : executeJson(
          "getPullRequest",
          (connection) =>
            HttpClientRequest.get(
              apiUrl(
                connection,
                `${repositoryPath(repository)}/pull-requests/${encodeURIComponent(normalizeBitbucketChangeRequestId(reference))}`,
              ),
            ),
          BitbucketServerPullRequestSchema,
        );

  const listPullRequestPages = Effect.fn("BitbucketServerApi.listPullRequestPages")(
    function* (input: {
      readonly repository: BitbucketServerRepositoryLocator;
      readonly branch: string;
      readonly state: string;
      readonly limit: number;
      readonly owner: string | undefined;
    }) {
      const collected: Array<NormalizedBitbucketPullRequestRecord> = [];
      let start = 0;
      for (let page = 0; page < MAX_PAGES && collected.length < input.limit; page += 1) {
        const result = yield* executeJson(
          "listPullRequests",
          (connection) =>
            HttpClientRequest.get(
              apiUrl(connection, `${repositoryPath(input.repository)}/pull-requests`),
              {
                urlParams: {
                  direction: "OUTGOING",
                  at: `refs/heads/${input.branch}`,
                  state: input.state,
                  order: "NEWEST",
                  limit: String(Math.min(input.limit - collected.length, MAX_PAGE_SIZE)),
                  start: String(start),
                },
              },
            ),
          BitbucketServerPullRequestPageSchema,
        );
        for (const raw of result.values) {
          if (
            input.owner !== undefined &&
            raw.fromRef.repository?.project.key.toLowerCase() !== input.owner.toLowerCase()
          ) {
            continue;
          }
          collected.push(normalizeBitbucketServerPullRequestRecord(raw));
        }
        if (result.isLastPage || result.nextPageStart === undefined) break;
        start = result.nextPageStart;
      }
      return collected.slice(0, input.limit);
    },
  );

  const trustedUrl = (connection: BitbucketServerConnection, value: string): string | null => {
    const url = URL.parse(value.startsWith("/rest/") ? `${connection.baseUrl}${value}` : value);
    const mount = new URL(connection.baseUrl).pathname.replace(/\/$/u, "");
    return url &&
      !url.username &&
      !url.password &&
      url.origin === connection.origin &&
      url.pathname.startsWith(`${mount}/rest/`)
      ? url.toString()
      : null;
  };

  const request: BitbucketServerApi["Service"]["request"] = (input) =>
    withConnection((connection) => {
      const url = trustedUrl(connection, input.url);
      if (url === null) {
        return Effect.fail(
          new BitbucketServerUntrustedUrlError({
            host: originOf(input.url) ?? "an unreadable url",
          }),
        );
      }
      const base = HttpClientRequest.make(input.method)(url).pipe(
        input.accept === undefined ? (request) => request : HttpClientRequest.accept(input.accept),
      );
      const withBody =
        input.body === undefined
          ? base
          : base.pipe(HttpClientRequest.bodyText(input.body, "application/json"));
      return runRequest(
        connection,
        input.method,
        send("request", connection, withBody).pipe(
          Effect.flatMap((response) =>
            HttpClientResponse.matchStatus({
              "2xx": (success) =>
                readBody(success, input.maxBytes).pipe(
                  Effect.mapError(
                    (cause) =>
                      new BitbucketServerResponseBodyReadError({
                        operation: "request",
                        status: success.status,
                        cause,
                      }),
                  ),
                  Effect.map((collected) => ({
                    body: collected.text,
                    truncated: collected.truncated,
                  })),
                ),
              orElse: (failed) => responseError("request", failed),
            })(response),
          ),
        ),
      );
    });

  const probeConnection = (connection: BitbucketServerConnection) =>
    send(
      "probeAuth",
      connection,
      HttpClientRequest.get(apiUrl(connection, "/projects"), {
        urlParams: { limit: "1" },
      }).pipe(HttpClientRequest.acceptJson),
    ).pipe(
      Effect.timeout("3 seconds"),
      Effect.map((response): SourceControlProviderAuth => {
        if (response.status >= 200 && response.status < 300) {
          const rawAccount = response.headers["x-ausername"];
          let account = rawAccount;
          try {
            account = rawAccount === undefined ? undefined : decodeURIComponent(rawAccount);
          } catch {}
          return {
            status: "authenticated",
            account: nonEmpty(account),
            host: Option.some(connection.hostname),
            detail: Option.none(),
          };
        }
        if (response.status === 401 || response.status === 403) {
          return {
            status: "unauthenticated",
            account: Option.none(),
            host: Option.some(connection.hostname),
            detail: Option.some(
              `${connection.hostname} rejected the configured token (HTTP ${response.status}).`,
            ),
          };
        }
        return {
          status: "unknown",
          account: Option.none(),
          host: Option.some(connection.hostname),
          detail: Option.some(`${connection.hostname} returned HTTP ${response.status}.`),
        };
      }),
      Effect.orElseSucceed((): SourceControlProviderAuth => ({
        status: "unknown",
        account: Option.none(),
        host: Option.some(connection.hostname),
        detail: Option.some(`${connection.hostname} could not be reached.`),
      })),
    );

  const probeAuth: BitbucketServerApi["Service"]["probeAuth"] = currentConnection.pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.succeed<SourceControlProviderAuth>({
            status: "unauthenticated",
            account: Option.none(),
            host: Option.none(),
            detail: Option.some(CONFIGURATION_HINT),
          }),
        onSome: () =>
          withConnection(probeConnection).pipe(
            Effect.orElseSucceed((): SourceControlProviderAuth => ({
              status: "unknown",
              account: Option.none(),
              host: Option.none(),
              detail: Option.some(
                "The configured Data Center instance does not match the requested host.",
              ),
            })),
          ),
      }),
    ),
  );

  return BitbucketServerApi.of({
    probeAuth,
    request,
    resolveRemote: Effect.fn("BitbucketServerApi.resolveRemote")((remoteUrl) =>
      withConnection((connection) =>
        locatorFromRemote(connection, remoteUrl).pipe(
          Effect.map((locator) =>
            locator === null
              ? null
              : { baseUrl: connection.baseUrl, repository: bitbucketServerRepositoryName(locator) },
          ),
        ),
      ).pipe(Effect.orElseSucceed(() => null)),
    ),
    createRepository: Effect.fn("BitbucketServerApi.createRepository")(function* (input) {
      const repository = parseRepositoryName(input.repository);
      if (repository === null || input.repository !== bitbucketServerRepositoryName(repository))
        return yield* new BitbucketServerRepositoryLocatorError({ repository: input.repository });
      const raw = yield* executeJson(
        "createRepository",
        (connection) =>
          HttpClientRequest.post(
            apiUrl(connection, `/projects/${encodeURIComponent(repository.projectKey)}/repos`),
          ).pipe(
            HttpClientRequest.bodyJsonUnsafe({
              name: repository.repoSlug,
              scmId: "git",
              public: input.visibility === "public",
            }),
          ),
        RawBitbucketServerRepositorySchema,
      );
      return normalizeRepositoryCloneUrls(raw);
    }),
    listPullRequests: Effect.fn("BitbucketServerApi.listPullRequests")((input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((repository) =>
          listPullRequestPages({
            repository,
            branch: SourceControlProvider.sourceBranch(input),
            state: toBitbucketServerState(input.state),
            limit: Math.max(1, input.limit ?? 20),
            owner: sourceOwner(input),
          }),
        ),
      ),
    ),
    getPullRequest: Effect.fn("BitbucketServerApi.getPullRequest")((input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((repository) => getRawPullRequest(repository, input.reference)),
        Effect.map(normalizeBitbucketServerPullRequestRecord),
      ),
    ),
    getRepositoryCloneUrls: Effect.fn("BitbucketServerApi.getRepositoryCloneUrls")((input) =>
      resolveRepository(input).pipe(
        Effect.flatMap(getRepositoryFromLocator),
        Effect.map(normalizeRepositoryCloneUrls),
      ),
    ),
    createPullRequest: Effect.fn("BitbucketServerApi.createPullRequest")((input) =>
      Effect.gen(function* () {
        const repository = yield* resolveRepository(input);
        const description = yield* fileSystem.readFileString(input.bodyFile).pipe(
          Effect.mapError(
            (cause) =>
              new BitbucketServerPullRequestBodyReadError({
                cwd: input.cwd,
                bodyFile: input.bodyFile,
                cause,
              }),
          ),
        );
        const owner = sourceOwner(input);
        const body = {
          title: input.title,
          description,
          fromRef: {
            id: `refs/heads/${SourceControlProvider.sourceBranch(input)}`,
            repository: {
              slug: input.source?.repository ?? repository.repoSlug,
              project: { key: owner ?? repository.projectKey },
            },
          },
          toRef: {
            id: `refs/heads/${input.target?.refName ?? input.baseBranch}`,
            repository: {
              slug: repository.repoSlug,
              project: { key: repository.projectKey },
            },
          },
        };
        const created = yield* executeJson(
          "createPullRequest",
          (connection) =>
            HttpClientRequest.post(
              apiUrl(connection, `${repositoryPath(repository)}/pull-requests`),
            ).pipe(HttpClientRequest.bodyJsonUnsafe(body)),
          BitbucketServerPullRequestSchema,
        );
        return normalizeBitbucketServerPullRequestRecord(created);
      }),
    ),
    getDefaultBranch: Effect.fn("BitbucketServerApi.getDefaultBranch")((input) =>
      resolveRepository(input).pipe(
        Effect.flatMap((repository) =>
          executeJson(
            "getDefaultBranch",
            (connection) =>
              HttpClientRequest.get(
                apiUrl(connection, `${repositoryPath(repository)}/default-branch`),
              ),
            RawBitbucketServerDefaultBranchSchema,
          ),
        ),
        Effect.map((branch) => branch.displayId),
      ),
    ),
    checkoutPullRequest: Effect.fn("BitbucketServerApi.checkoutPullRequest")((input) =>
      Effect.gen(function* () {
        const repository = yield* resolveRepository(input);
        const pullRequest = normalizeBitbucketServerPullRequestRecord(
          yield* getRawPullRequest(repository, input.reference),
        );
        const connection = yield* withConnection(Effect.succeed);
        const isCrossRepository = pullRequest.isCrossRepository === true;
        const referenceUrl = URL.parse(input.reference);
        const contextRepository = input.context ? parseRemoteUrl(input.context.remoteUrl) : null;
        let remoteName: string;
        if (
          input.context &&
          contextRepository &&
          bitbucketServerRepositoryName(contextRepository).toLowerCase() ===
            bitbucketServerRepositoryName(repository).toLowerCase()
        ) {
          remoteName = input.context.remoteName;
        } else if (referenceUrl) {
          const clones = normalizeRepositoryCloneUrls(yield* getRepositoryFromLocator(repository));
          remoteName = yield* git.ensureRemote({
            cwd: input.cwd,
            preferredName: `bitbucket-${repository.projectKey}`,
            url: clones.url,
          });
        } else {
          const remotes = yield* git.remotes(input.cwd).pipe(Effect.flatten);
          const remote = remotes.remotes.find((remote) => {
            const parsed = parseRemoteUrl(remote.url);
            return (
              parsed &&
              bitbucketServerRepositoryName(parsed).toLowerCase() ===
                bitbucketServerRepositoryName(repository).toLowerCase() &&
              parseGitRemoteHost(remote.url)?.hostname === connection.hostname
            );
          });
          if (!remote)
            return yield* new BitbucketServerRepositoryRemoteNotFoundError({ cwd: input.cwd });
          remoteName = remote.name;
        }
        const localBranch = checkoutBranchName({
          pullRequestId: pullRequest.number,
          headBranch: pullRequest.headRefName,
          isCrossRepository,
        });
        const localBranchExists = (yield* git.listLocalBranchNames(input.cwd)).includes(
          localBranch,
        );

        if (input.force === true || !localBranchExists) {
          yield* git.fetchRemoteRef({
            cwd: input.cwd,
            remoteName,
            remoteRef: `refs/pull-requests/${pullRequest.number}/from`,
            localBranch,
          });
        }
        if (!isCrossRepository) {
          yield* git.fetchRemoteTrackingBranch({
            cwd: input.cwd,
            remoteName,
            remoteBranch: pullRequest.headRefName,
          });
          yield* git.setBranchUpstream({
            cwd: input.cwd,
            branch: localBranch,
            remoteName,
            remoteBranch: pullRequest.headRefName,
          });
        }
        yield* Effect.scoped(git.switchRef({ cwd: input.cwd, refName: localBranch }));
      }).pipe(
        Effect.mapError((cause) =>
          isBitbucketServerApiError(cause)
            ? cause
            : new BitbucketServerCheckoutError({
                cwd: input.cwd,
                reference: input.reference,
                cause,
              }),
        ),
      ),
    ),
  });
});

export const layer = Layer.effect(BitbucketServerApi, make);

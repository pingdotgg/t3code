/**
 * Requests borrow the `origin` CLI's session token and go straight to `api.cursor.com/v1/origin`
 * over one long-lived HTTP/2 connection: spawning the CLI per request costs about 0.8s, a warm
 * request about 0.2s.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import * as Redacted from "effect/Redacted";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";
import * as NodeModule from "node:module";
import type * as Undici from "undici";
import { collectUint8StreamText } from "@t3tools/provider-core/server/collectStreamText";
import { decodeJsonResult } from "@t3tools/shared/schemaJson";
import { parseGitRemoteHost } from "@t3tools/source-control-core/shared/definition";
import { CURSOR_ORIGIN_GIT_HOST } from "../shared/definition.ts";
import { retryAtFromHeader } from "@t3tools/source-control-core/server/SourceControlRateLimit";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import type { SourceControlProviderContext } from "@t3tools/source-control-core/server/SourceControlProvider";
import { repositoryPathFromRemoteUrl } from "@t3tools/source-control-core/server/SourceControlProvider";

const DEFAULT_TIMEOUT_MS = 30_000;
const MISSING_TOKEN_TTL_MS = 10_000;
/** How long a session is trusted before the CLI is asked again, as the GitHub and GitCafe credentials are. */
const SESSION_TTL_MS = 5 * 60_000;
const MAX_OUTPUT_BYTES = 8_000_000;
const API_BASE_URL = "https://api.cursor.com";

export const ORIGIN_COMMAND = "origin";

export class OriginCliError extends Schema.TaggedError<OriginCliError>()("OriginCliError", {
  operation: Schema.String,
  cwd: Schema.String,
  detail: Schema.String,
  reason: Schema.Literals([
    "missing-tool",
    "unauthenticated",
    "rate-limited",
    "not-found",
    "invalid-response",
    "failed",
  ]),
  httpStatus: Schema.optional(Schema.Int),
  /** When a rate-limited request may be sent again, in epoch milliseconds. */
  retryAt: Schema.optional(Schema.Number),
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Cursor Origin failed in ${this.operation}: ${this.detail}`;
  }
}

/** What `origin auth status --json` reports. Only the fields this package reads. */
const OriginAuthStatusSchema = Schema.Struct({
  authenticated: Schema.Boolean,
  tokenValid: Schema.optional(Schema.Boolean),
  account: Schema.optional(
    Schema.NullOr(Schema.Struct({ email: Schema.optional(Schema.NullOr(Schema.String)) })),
  ),
});
type OriginAuthStatus = typeof OriginAuthStatusSchema.Type;

export function parseOriginAuthStatus(raw: string): OriginAuthStatus | null {
  const decoded = decodeJsonResult(OriginAuthStatusSchema)(raw);
  return Result.isSuccess(decoded) ? decoded.success : null;
}

/** The signed-in account's email, which is what `origin auth status` names it by. */
export function originAccount(status: OriginAuthStatus | null): string | null {
  if (!status?.authenticated || status.tokenValid === false) return null;
  return status.account?.email?.trim() || null;
}

const OriginNamespaceListSchema = Schema.Struct({
  namespaces: Schema.optional(
    Schema.NullOr(
      Schema.Array(
        Schema.Struct({ namespace: Schema.Struct({ slug: Schema.String, type: Schema.String }) }),
      ),
    ),
  ),
});

/** `owner/repo` for a REST path, each segment escaped. */
export function originRepositoryPath(repository: string): string {
  return `/v1/origin/repos/${repository.split("/").map(encodeURIComponent).join("/")}`;
}

/** The message an Origin error body carries, Connect-style or REST-style. */
function errorBodyMessage(body: string): string | null {
  const decoded = decodeJsonResult(
    Schema.Struct({
      message: Schema.optional(Schema.String),
      error: Schema.optional(
        Schema.Union([Schema.String, Schema.Struct({ message: Schema.optional(Schema.String) })]),
      ),
    }),
  )(body);
  if (Result.isFailure(decoded)) return null;
  const { message, error } = decoded.success;
  return message ?? (typeof error === "string" ? error : error?.message) ?? null;
}

const UNAUTHENTICATED_DETAIL =
  "Cursor Origin CLI is not signed in. Run `origin auth login` and retry.";

/** A failed `origin` command, read from its exit and output. */
function classifyOriginFailure(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly stdout: string;
  readonly stderr: string;
}): OriginCliError {
  const text = `${input.stderr}\n${input.stdout}`;
  const reason: OriginCliError["reason"] =
    /not authenticated|not (?:logged|signed) in|origin auth login|unauthenticated|unauthorized/iu.test(
      text,
    )
      ? "unauthenticated"
      : /rate.?limit|too many requests|\b429\b/iu.test(text)
        ? "rate-limited"
        : /\bnot[_ ]found\b/iu.test(text)
          ? "not-found"
          : "failed";
  const firstLine = input.stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  return new OriginCliError({
    operation: input.operation,
    cwd: input.cwd,
    reason,
    detail:
      reason === "unauthenticated"
        ? UNAUTHENTICATED_DETAIL
        : input.operation === "authToken"
          ? "Cursor Origin CLI could not hand over a session token. Check `origin auth status`."
          : (errorBodyMessage(input.stdout) ??
            firstLine?.replace(/^Error:\s*/u, "") ??
            "Cursor Origin CLI command failed."),
  });
}

/** A non-2xx API response. */
function classifyOriginResponse(input: {
  readonly operation: string;
  readonly cwd: string;
  readonly status: number;
  readonly body: string;
  readonly headers: Readonly<Record<string, string | undefined>>;
  readonly now: number;
}): OriginCliError {
  const reason: OriginCliError["reason"] =
    input.status === 401
      ? "unauthenticated"
      : input.status === 429
        ? "rate-limited"
        : input.status === 404
          ? "not-found"
          : "failed";
  const reset = Number(input.headers["x-ratelimit-reset"]) * 1_000;
  const retryAt =
    reason !== "rate-limited"
      ? undefined
      : (retryAtFromHeader(input.headers["retry-after"], input.now) ??
        (Number.isFinite(reset) && reset > input.now ? reset : undefined));
  return new OriginCliError({
    operation: input.operation,
    cwd: input.cwd,
    reason,
    httpStatus: input.status,
    ...(retryAt === undefined ? {} : { retryAt }),
    detail:
      reason === "unauthenticated"
        ? UNAUTHENTICATED_DETAIL
        : reason === "rate-limited"
          ? "Cursor Origin API rate limit exceeded."
          : (errorBodyMessage(input.body) ??
            `Cursor Origin request failed (HTTP ${input.status}).`),
  });
}

interface OriginApiInput {
  readonly cwd: string;
  readonly operation: string;
  /** A full `/v1/origin/...` path, query included. */
  readonly path: string;
  readonly method?: "GET" | "POST" | "PATCH";
  readonly body?: unknown;
}

export class OriginCli extends Context.Service<
  OriginCli,
  {
    /** Runs `origin …args` and fails with a classified error on a non-zero exit. */
    readonly execute: (input: {
      readonly cwd: string;
      readonly operation: string;
      readonly args: ReadonlyArray<string>;
    }) => Effect.Effect<string, OriginCliError>;
    /** One REST request, decoded with `schema`. */
    readonly api: <S extends Schema.Codec<unknown, unknown, never, never>>(
      input: OriginApiInput,
      schema: S,
    ) => Effect.Effect<S["Type"], OriginCliError>;
    /** The signed-in account, held until the session's token is refused. */
    readonly viewer: (cwd: string) => Effect.Effect<string, OriginCliError>;
    /** The signed-in user's own namespace slug, which owns their repositories and pull requests. */
    readonly personalNamespace: (cwd: string) => Effect.Effect<string, OriginCliError>;
    /** `owner/repo` for the checkout, from the caller's remote or the checkout's primary remote. */
    readonly resolveRepository: (input: {
      readonly cwd: string;
      readonly context?: SourceControlProviderContext;
    }) => Effect.Effect<string, OriginCliError>;
  }
>()("@t3tools/source-control-cursor-origin/server/OriginCli") {}

const make = Effect.gen(function* () {
  const host = yield* SourceControlHost.SourceControlHost;
  const httpClient = yield* HttpClient.HttpClient;
  const scope = yield* Effect.scope;

  const run = (input: Parameters<OriginCli["Service"]["execute"]>[0]) =>
    host.process
      .run({
        operation: `CursorOrigin.${input.operation}`,
        command: ORIGIN_COMMAND,
        args: input.args,
        cwd: input.cwd,
        env: { NO_COLOR: "1" },
        allowNonZeroExit: true,
        timeoutMs: DEFAULT_TIMEOUT_MS,
        maxOutputBytes: MAX_OUTPUT_BYTES,
        outputMode: "error",
      })
      .pipe(
        Effect.mapError((cause) => {
          const missing =
            cause._tag === "VcsProcessSpawnError" &&
            cause.cause instanceof PlatformError.PlatformError &&
            cause.cause.reason._tag === "NotFound";
          return new OriginCliError({
            operation: input.operation,
            cwd: input.cwd,
            reason: missing ? "missing-tool" : "failed",
            detail: missing
              ? "Cursor Origin CLI (`origin`) is required but not available on PATH."
              : "Cursor Origin CLI could not be run.",
            cause,
          });
        }),
      );

  const execute: OriginCli["Service"]["execute"] = Effect.fn("OriginCli.execute")(
    function* (input) {
      const result = yield* run(input);
      if (result.exitCode !== 0) return yield* classifyOriginFailure({ ...input, ...result });
      return result.stdout;
    },
  );

  // The CLI's session token, kept a few minutes or until Origin refuses it. One read at a time, so a burst of
  // requests on a cold server spawns the CLI once; a failed read is shared for a few seconds, so
  // a burst while signed out does not queue one CLI process per request either.
  const tokenLock = yield* Semaphore.make(1);
  let token: Result.Result<Redacted.Redacted<string>, OriginCliError> | null = null;
  let tokenExpiresAt = 0;
  let viewerAccount: string | null = null;
  let viewerExpiresAt = 0;
  const currentToken = (cwd: string) =>
    tokenLock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (token !== null && tokenExpiresAt > now) return yield* Effect.fromResult(token);
        token = yield* execute({ cwd, operation: "authToken", args: ["auth", "token"] }).pipe(
          Effect.flatMap((stdout) => {
            const read = stdout.trim();
            if (read.length === 0)
              return Effect.fail(
                new OriginCliError({
                  operation: "authToken",
                  cwd,
                  reason: "unauthenticated",
                  detail: UNAUTHENTICATED_DETAIL,
                }),
              );
            return Effect.succeed(Redacted.make(read));
          }),
          Effect.result,
        );
        tokenExpiresAt =
          (yield* Clock.currentTimeMillis) +
          (Result.isSuccess(token) ? SESSION_TTL_MS : MISSING_TOKEN_TTL_MS);
        return yield* Effect.fromResult(token);
      }),
    );
  const forgetSession = (refused: Redacted.Redacted<string>) =>
    tokenLock.withPermits(1)(
      Effect.sync(() => {
        // A late 401 from an old request must not discard another request's fresh token.
        if (token !== null && Result.isSuccess(token) && token.success === refused) {
          token = null;
          viewerAccount = null;
        }
      }),
    );

  const send = (input: OriginApiInput, bearer: string) => {
    const request = HttpClientRequest.make(input.method ?? "GET")(
      `${API_BASE_URL}${input.path}`,
    ).pipe(HttpClientRequest.bearerToken(bearer), HttpClientRequest.acceptJson);
    return httpClient
      .execute(
        input.body === undefined ? request : HttpClientRequest.bodyJsonUnsafe(request, input.body),
      )
      .pipe(
        Effect.flatMap((response) =>
          collectUint8StreamText({ stream: response.stream, maxBytes: MAX_OUTPUT_BYTES }).pipe(
            Effect.map((collected) => ({ response, collected })),
          ),
        ),
        Effect.timeout(DEFAULT_TIMEOUT_MS),
        Effect.mapError(
          (cause) =>
            new OriginCliError({
              operation: input.operation,
              cwd: input.cwd,
              reason: "failed",
              detail: "Could not reach Cursor Origin.",
              cause,
            }),
        ),
        Effect.flatMap(({ response, collected }) =>
          collected.truncated
            ? Effect.fail(
                new OriginCliError({
                  operation: input.operation,
                  cwd: input.cwd,
                  reason: "failed",
                  detail: "Cursor Origin sent a response too large to read.",
                }),
              )
            : Effect.succeed({ response, body: collected.text }),
        ),
      );
  };

  const api: OriginCli["Service"]["api"] = Effect.fn("OriginCli.api")(function* (input, schema) {
    const bearer = yield* currentToken(input.cwd);
    let exchange = yield* send(input, Redacted.value(bearer));
    // A refused token may have been rotated by `origin auth login`; read it again once.
    if (exchange.response.status === 401) {
      yield* forgetSession(bearer);
      exchange = yield* send(input, Redacted.value(yield* currentToken(input.cwd)));
    }
    if (exchange.response.status < 200 || exchange.response.status >= 300)
      return yield* classifyOriginResponse({
        operation: input.operation,
        cwd: input.cwd,
        status: exchange.response.status,
        body: exchange.body,
        headers: exchange.response.headers,
        now: yield* Clock.currentTimeMillis,
      });
    const body = exchange.body.trim().length === 0 ? "{}" : exchange.body;
    return yield* Schema.decodeEffect(Schema.fromJsonString(schema))(body).pipe(
      Effect.mapError(
        (cause) =>
          new OriginCliError({
            operation: input.operation,
            cwd: input.cwd,
            reason: "invalid-response",
            detail: "Cursor Origin returned a response this version cannot read.",
            cause,
          }),
      ),
    );
  });

  const authStatus = (cwd: string) =>
    run({ cwd, operation: "authStatus", args: ["auth", "status", "--json"] }).pipe(
      Effect.flatMap((result) => {
        const status = parseOriginAuthStatus(result.stdout);
        if (status !== null) return Effect.succeed(status);
        return Effect.fail(
          result.exitCode !== 0
            ? classifyOriginFailure({ cwd, operation: "authStatus", ...result })
            : new OriginCliError({
                cwd,
                operation: "authStatus",
                reason: "invalid-response",
                detail: "Cursor Origin returned an unreadable auth status.",
              }),
        );
      }),
    );

  // A session's first question is who is signed in, which the CLI answers in most of a second.
  // The token read and the API connection's TLS handshake happen meanwhile, so the request that
  // follows starts warm. The API's root takes no credentials and counts against no limit.
  const warmUp = (cwd: string) =>
    Effect.all(
      [
        currentToken(cwd),
        httpClient.execute(HttpClientRequest.get(API_BASE_URL)).pipe(Effect.flatMap((r) => r.text)),
      ],
      { concurrency: "unbounded", discard: true },
    ).pipe(Effect.timeout(DEFAULT_TIMEOUT_MS), Effect.ignore);

  const viewer: OriginCli["Service"]["viewer"] = Effect.fn("OriginCli.viewer")(function* (cwd) {
    if (viewerAccount !== null && viewerExpiresAt > (yield* Clock.currentTimeMillis))
      return viewerAccount;
    yield* Effect.forkIn(warmUp(cwd), scope);
    return yield* authStatus(cwd).pipe(
      Effect.flatMap((status) => {
        const account = originAccount(status);
        if (account === null)
          return Effect.fail(
            new OriginCliError({
              operation: "viewer",
              cwd,
              reason: "unauthenticated",
              detail: UNAUTHENTICATED_DETAIL,
            }),
          );
        viewerAccount = account;
        return Clock.currentTimeMillis.pipe(
          Effect.map((now) => {
            viewerExpiresAt = now + SESSION_TTL_MS;
            return account;
          }),
        );
      }),
    );
  });

  const resolveRepository: OriginCli["Service"]["resolveRepository"] = Effect.fn(
    "OriginCli.resolveRepository",
  )(function* (input) {
    const remoteUrl =
      input.context?.remoteUrl ??
      (yield* host.git.resolvePrimaryRemoteName(input.cwd).pipe(
        Effect.flatMap((remote) => host.git.readConfigValue(input.cwd, `remote.${remote}.url`)),
        Effect.orElseSucceed(() => null),
      ));
    const repository =
      remoteUrl && parseGitRemoteHost(remoteUrl)?.hostname === CURSOR_ORIGIN_GIT_HOST
        ? repositoryPathFromRemoteUrl(remoteUrl)
        : null;
    if (!repository)
      return yield* new OriginCliError({
        operation: "resolveRepository",
        cwd: input.cwd,
        reason: "not-found",
        detail: "This checkout has no Cursor Origin remote.",
      });
    return repository;
  });

  const personalNamespace: OriginCli["Service"]["personalNamespace"] = (cwd) =>
    api(
      { cwd, operation: "personalNamespace", path: "/v1/origin/namespaces" },
      OriginNamespaceListSchema,
    ).pipe(
      Effect.flatMap((list) => {
        const slug = list.namespaces?.find((entry) => entry.namespace.type === "user")?.namespace
          .slug;
        return slug
          ? Effect.succeed(slug)
          : Effect.fail(
              new OriginCliError({
                operation: "personalNamespace",
                cwd,
                reason: "not-found",
                detail:
                  "This Cursor account has no Origin namespace. Claim one at cursor.com/codebase.",
              }),
            );
      }),
    );

  return OriginCli.of({ execute, api, viewer, personalNamespace, resolveRepository });
});

/**
 * Origin answers from a few hundred milliseconds away, so a new TLS connection doubles a request.
 * Undici's default drops an idle connection after four seconds, which a person reading a pull
 * request always outlasts; Origin keeps one open for minutes, and HTTP/2 carries a detail's
 * parallel reads on it at once.
 */
const httpClientLayer = Layer.unwrap(
  Effect.gen(function* () {
    // The CLI single-executable resolves only builtin imports; undici loads from disk through require.
    const undici = NodeModule.createRequire(import.meta.url)("undici") as typeof Undici;
    const dispatcher = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new undici.Agent({
            allowH2: true,
            keepAliveTimeout: 300_000,
            keepAliveMaxTimeout: 300_000,
          }),
      ),
      (agent) => Effect.promise(() => agent.destroy()),
    );
    // FetchHttpClient always passes a URL; undici's Response is structurally the web Response.
    // Manual redirects keep the status classifyOriginResponse saw before this used fetch.
    const fetch = ((url: URL, init?: Undici.RequestInit) =>
      undici.fetch(url, {
        ...init,
        dispatcher,
        redirect: "manual",
      })) as unknown as typeof globalThis.fetch;
    return FetchHttpClient.layer.pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch)));
  }),
);

export const layer = Layer.effect(OriginCli, make).pipe(Layer.provide(httpClientLayer));

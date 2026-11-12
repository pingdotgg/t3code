import {
  SourceControlProviderKind,
  SourceControlSignInError,
  type SourceControlSignInFailure,
  type SourceControlSignInPrompt,
} from "@t3tools/contracts";
import * as SourceControlHost from "@t3tools/source-control-core/server/SourceControlHost";
import { readSourceControlHostSettings } from "@t3tools/source-control-core/shared/definition";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";
import * as HostProcess from "@t3tools/shared/HostProcess";

import * as GitHubClient from "../shared/definition.ts";

/**
 * The public client ID of the T3 Code for GitHub app, which the device flow needs (no secret).
 * Unset turns the app sign-in off: no app tokens, no sign-in, nothing for clients to show.
 */
export const CLIENT_ID_VARIABLE = "T3CODE_GITHUB_APP_CLIENT_ID";

const KIND = SourceControlProviderKind.make("github");
const REQUEST_TIMEOUT = Duration.seconds(15);
// Refresh ahead of expiry so a token never lapses between the check and a long request.
const REFRESH_MARGIN_MS = Duration.toMillis(Duration.minutes(5));

const GitHubAppSession = Schema.Struct({
  accessToken: Schema.String,
  /** Null when the app hands out tokens that do not expire. */
  accessTokenExpiresAt: Schema.NullOr(Schema.Number),
  refreshToken: Schema.NullOr(Schema.String),
  refreshTokenExpiresAt: Schema.NullOr(Schema.Number),
});
type GitHubAppSession = typeof GitHubAppSession.Type;

const GitHubAppSessionJson = Schema.fromJsonString(GitHubAppSession);
const decodeSession = Schema.decodeUnknownOption(GitHubAppSessionJson);
const encodeSession = Schema.encodeSync(GitHubAppSessionJson);

// GitHub answers both token grants with HTTP 200 and puts refusals in `error`.
const TokenResponse = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  refresh_token: Schema.optional(Schema.String),
  refresh_token_expires_in: Schema.optional(Schema.Number),
  interval: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

const DeviceCodeResponse = Schema.Struct({
  device_code: Schema.optional(Schema.String),
  user_code: Schema.optional(Schema.String),
  verification_uri: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  interval: Schema.optional(Schema.Number),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});

export class GitHubAppSessionError extends Schema.TaggedError<GitHubAppSessionError>()(
  "GitHubAppSessionError",
  { host: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not refresh the ${GitHubClient.APP_SIGN_IN.appName} sign-in for ${this.host}. Check the server's connection to GitHub, or sign in again in Settings → Source Control.`;
  }
}

export class GitHubAppSignIn extends Context.Service<
  GitHubAppSignIn,
  {
    /** Whether the server is configured with the app's client ID. */
    readonly enabled: boolean;
    /** The signed-in access token for `host`, refreshed when due; none when not signed in. */
    readonly token: (host: string) => Effect.Effect<Option.Option<string>, GitHubAppSessionError>;
    /** Refreshes on the next `token` when `rejected` is the token GitHub just refused. */
    readonly invalidate: (host: string, rejected: string) => Effect.Effect<void>;
    readonly start: (
      host: string,
    ) => Effect.Effect<SourceControlSignInPrompt, SourceControlSignInError>;
    /** Resolves once the sign-in `start` began has saved a session. */
    readonly wait: (host: string) => Effect.Effect<void, SourceControlSignInError>;
    readonly cancel: (host: string) => Effect.Effect<void>;
  }
>()("@t3tools/source-control-github/server/GitHubAppSignIn") {}

interface PendingSignIn {
  readonly deferred: Deferred.Deferred<void, SourceControlSignInError>;
  readonly fiber: Fiber.Fiber<boolean>;
}

const signInError = (host: string, reason: SourceControlSignInFailure, detail: string) =>
  new SourceControlSignInError({ provider: KIND, host, reason, detail });

/** @public */
export const make = Effect.gen(function* () {
  const sourceControlHost = yield* SourceControlHost.SourceControlHost;
  const httpClient = yield* HttpClient.HttpClient;
  const clientId = (yield* HostProcess.Environment)[CLIENT_ID_VARIABLE]?.trim() ?? "";
  const enabled = clientId !== "";
  const scope = yield* Effect.scope;
  const refreshLock = yield* Semaphore.make(1);
  const refused = yield* Ref.make<ReadonlySet<string>>(new Set());
  const pending = yield* Ref.make<ReadonlyMap<string, PendingSignIn>>(new Map());

  const isAppHost = (host: string) =>
    enabled && GitHubClient.APP_SIGN_IN.hosts.includes(host.trim().toLowerCase());

  const readSignIns = sourceControlHost.settings.get.pipe(
    Effect.map(
      (settings) =>
        readSourceControlHostSettings(
          GitHubClient.settings,
          settings.sourceControlHosts[GitHubClient.definition.kind],
        ).signIns,
    ),
    Effect.orElseSucceed((): Readonly<Record<string, string>> => ({})),
  );

  const readSession = (host: string) =>
    readSignIns.pipe(Effect.map((signIns) => decodeSession(signIns[host] ?? "")));

  const writeSession = Effect.fn("GitHubAppSignIn.writeSession")(function* (
    host: string,
    session: GitHubAppSession | null,
  ) {
    const signIns = { ...(yield* readSignIns) };
    if (session === null) delete signIns[host];
    else signIns[host] = encodeSession(session);
    yield* sourceControlHost.settings.update({
      sourceControlHosts: { [GitHubClient.definition.kind]: { signIns } },
    });
  });

  /**
   * Writes `next` only while the stored session is still the one a refresh started from, so a
   * sign-out or a newer sign-in during the request is not undone.
   */
  const replaceSession = Effect.fn("GitHubAppSignIn.replaceSession")(function* (
    host: string,
    from: GitHubAppSession,
    next: GitHubAppSession | null,
  ) {
    const current = yield* readSession(host);
    if (Option.isNone(current) || current.value.accessToken !== from.accessToken) return false;
    yield* writeSession(host, next);
    return true;
  });

  const postForm = <S extends Schema.Top>(
    host: string,
    path: string,
    body: Record<string, string>,
    schema: S,
  ) =>
    httpClient
      .execute(
        HttpClientRequest.post(`https://${host}${path}`).pipe(
          HttpClientRequest.setHeaders({ accept: "application/json", "user-agent": "t3code" }),
          HttpClientRequest.bodyUrlParams(body),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.filterStatusOk),
        Effect.flatMap(HttpClientResponse.schemaBodyJson(schema)),
        Effect.timeout(REQUEST_TIMEOUT),
      );

  const sessionFrom = (
    now: number,
    response: typeof TokenResponse.Type & { readonly access_token: string },
  ): GitHubAppSession => ({
    accessToken: response.access_token,
    accessTokenExpiresAt:
      response.expires_in === undefined ? null : now + response.expires_in * 1_000,
    refreshToken: response.refresh_token ?? null,
    refreshTokenExpiresAt:
      response.refresh_token_expires_in === undefined
        ? null
        : now + response.refresh_token_expires_in * 1_000,
  });

  const refresh = Effect.fn("GitHubAppSignIn.refresh")(function* (
    host: string,
    session: GitHubAppSession,
  ) {
    const now = yield* Clock.currentTimeMillis;
    if (
      session.refreshToken === null ||
      (session.refreshTokenExpiresAt !== null && session.refreshTokenExpiresAt <= now)
    ) {
      yield* replaceSession(host, session, null).pipe(Effect.ignore);
      return Option.none<string>();
    }
    const response = yield* postForm(
      host,
      "/login/oauth/access_token",
      {
        client_id: clientId,
        grant_type: "refresh_token",
        refresh_token: session.refreshToken,
      },
      TokenResponse,
    ).pipe(Effect.mapError((cause) => new GitHubAppSessionError({ host, cause })));
    if (response.error === "bad_refresh_token") {
      // Final: the user revoked the app or the session lapsed.
      yield* Effect.logWarning("GitHub refused the app sign-in refresh; signing out.", { host });
      yield* replaceSession(host, session, null).pipe(Effect.ignore);
      return Option.none<string>();
    }
    if (response.access_token === undefined) {
      return yield* new GitHubAppSessionError({
        host,
        cause: new Error(`GitHub did not refresh the sign-in (${response.error ?? "no token"}).`),
      });
    }
    const next = sessionFrom(now, {
      ...response,
      access_token: response.access_token,
    });
    // GitHub has retired the old pair, so an unsaved new one is still the only usable token.
    const saved = yield* replaceSession(host, session, next).pipe(
      Effect.retry({ times: 2, schedule: Schedule.spaced(Duration.millis(250)) }),
      Effect.catch((cause) =>
        Effect.logError("Could not save the refreshed app sign-in; using it unsaved.", {
          host,
          cause,
        }).pipe(Effect.as(true)),
      ),
    );
    if (saved) return Option.some(next.accessToken);
    // Signed out or signed in again meanwhile: serve whatever is stored now.
    return Option.map(yield* readSession(host), (current) => current.accessToken);
  });

  const isFresh = (session: GitHubAppSession, now: number) =>
    session.accessTokenExpiresAt === null || now < session.accessTokenExpiresAt - REFRESH_MARGIN_MS;

  const token: GitHubAppSignIn["Service"]["token"] = Effect.fn("GitHubAppSignIn.token")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      if (!isAppHost(host)) return Option.none();
      const session = yield* readSession(host);
      if (Option.isNone(session)) return Option.none();
      const now = yield* Clock.currentTimeMillis;
      if (
        isFresh(session.value, now) &&
        !(yield* Ref.get(refused)).has(session.value.accessToken)
      ) {
        return Option.some(session.value.accessToken);
      }
      return yield* refreshLock.withPermits(1)(
        Effect.gen(function* () {
          // Another request may have refreshed while this one queued.
          const current = yield* readSession(host);
          if (Option.isNone(current)) return Option.none<string>();
          const refusedTokens = yield* Ref.get(refused);
          const now = yield* Clock.currentTimeMillis;
          if (isFresh(current.value, now) && !refusedTokens.has(current.value.accessToken)) {
            return Option.some(current.value.accessToken);
          }
          const usable = Option.some(current.value.accessToken).pipe(
            Option.filter(
              (accessToken) =>
                !refusedTokens.has(accessToken) &&
                (current.value.accessTokenExpiresAt === null ||
                  now < current.value.accessTokenExpiresAt),
            ),
          );
          // A refresh ahead of expiry that fails leaves the still-valid token in use.
          return yield* refresh(host, current.value).pipe(
            Effect.catchTags({
              GitHubAppSessionError: (error) =>
                Option.isSome(usable) ? Effect.succeed(usable) : Effect.fail(error),
            }),
          );
        }),
      );
    },
  );

  const invalidate: GitHubAppSignIn["Service"]["invalidate"] = Effect.fn(
    "GitHubAppSignIn.invalidate",
  )(function* (rawHost, rejected) {
    const session = yield* readSession(rawHost.trim().toLowerCase());
    // A refused fallback token says nothing about the app session.
    if (Option.isNone(session) || session.value.accessToken !== rejected) return;
    yield* Ref.update(refused, (current) => new Set([...current, rejected]));
  });

  const poll = Effect.fn("GitHubAppSignIn.poll")(function* (
    host: string,
    deviceCode: string,
    expiresAt: number,
    initialInterval: number,
  ) {
    let interval = initialInterval;
    while (true) {
      yield* Effect.sleep(Duration.seconds(interval));
      const now = yield* Clock.currentTimeMillis;
      if (now >= expiresAt) {
        return yield* signInError(host, "expired", "The sign-in code expired. Start again.");
      }
      const answer = yield* postForm(
        host,
        "/login/oauth/access_token",
        {
          client_id: clientId,
          device_code: deviceCode,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
        },
        TokenResponse,
      ).pipe(Effect.option);
      // A dropped poll is retried on the next tick; the code stays valid until it expires.
      if (Option.isNone(answer)) continue;
      const response = answer.value;
      if (response.access_token !== undefined) {
        const accessToken = response.access_token;
        return yield* writeSession(
          host,
          sessionFrom(yield* Clock.currentTimeMillis, { ...response, access_token: accessToken }),
        ).pipe(
          Effect.mapError(
            (cause) =>
              new SourceControlSignInError({
                provider: KIND,
                host,
                reason: "failed",
                detail: "The server could not save the sign-in.",
                cause,
              }),
          ),
        );
      }
      switch (response.error) {
        case "authorization_pending":
          continue;
        case "slow_down":
          interval = response.interval ?? interval + 5;
          continue;
        case "expired_token":
          return yield* signInError(host, "expired", "The sign-in code expired. Start again.");
        case "access_denied":
          return yield* signInError(host, "denied", "The sign-in was cancelled on GitHub.");
        default:
          return yield* signInError(
            host,
            "failed",
            response.error_description ??
              `GitHub refused the sign-in (${response.error ?? "no reason given"}).`,
          );
      }
    }
  });

  const start: GitHubAppSignIn["Service"]["start"] = Effect.fn("GitHubAppSignIn.start")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      if (!enabled) {
        return yield* signInError(
          host,
          "unsupported",
          `This server is not set up to sign in with ${GitHubClient.APP_SIGN_IN.appName}.`,
        );
      }
      if (!isAppHost(host)) {
        return yield* signInError(
          host,
          "unsupported",
          `${GitHubClient.APP_SIGN_IN.appName} only signs in to ${GitHubClient.APP_SIGN_IN.hosts.join(", ")}. Use a token or the GitHub CLI for ${host}.`,
        );
      }
      const code = yield* postForm(
        host,
        "/login/device/code",
        { client_id: clientId },
        DeviceCodeResponse,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new SourceControlSignInError({
              provider: KIND,
              host,
              reason: "failed",
              detail: "The server could not reach GitHub to start the sign-in.",
              cause,
            }),
        ),
      );
      if (
        code.device_code === undefined ||
        code.user_code === undefined ||
        code.verification_uri === undefined ||
        code.expires_in === undefined
      ) {
        return yield* signInError(
          host,
          "failed",
          code.error_description ??
            `GitHub would not start the sign-in (${code.error ?? "no reason given"}).`,
        );
      }
      const expiresAt = (yield* Clock.currentTimeMillis) + code.expires_in * 1_000;
      const deferred = yield* Deferred.make<void, SourceControlSignInError>();
      const fiber = yield* poll(host, code.device_code, expiresAt, code.interval ?? 5).pipe(
        Effect.tap(() => Ref.set(refused, new Set())),
        Deferred.into(deferred),
        Effect.forkIn(scope),
      );
      const previous = yield* Ref.modify(pending, (current) => [
        current.get(host),
        new Map(current).set(host, { deferred, fiber }),
      ]);
      if (previous !== undefined) {
        yield* Deferred.fail(
          previous.deferred,
          signInError(host, "failed", "A newer sign-in replaced this one."),
        );
        yield* Fiber.interrupt(previous.fiber);
      }
      return {
        userCode: code.user_code,
        verificationUri: code.verification_uri,
        expiresAt,
      } satisfies SourceControlSignInPrompt;
    },
  );

  const wait: GitHubAppSignIn["Service"]["wait"] = Effect.fn("GitHubAppSignIn.wait")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      const current = (yield* Ref.get(pending)).get(host);
      if (current === undefined) {
        return yield* signInError(host, "not-started", "No sign-in is in progress. Start again.");
      }
      return yield* Deferred.await(current.deferred);
    },
  );

  const cancel: GitHubAppSignIn["Service"]["cancel"] = Effect.fn("GitHubAppSignIn.cancel")(
    function* (rawHost) {
      const host = rawHost.trim().toLowerCase();
      const current = (yield* Ref.get(pending)).get(host);
      if (current === undefined) return;
      yield* Deferred.fail(
        current.deferred,
        signInError(host, "cancelled", "The sign-in was cancelled."),
      );
      yield* Fiber.interrupt(current.fiber);
    },
  );

  return GitHubAppSignIn.of({ enabled, token, invalidate, start, wait, cancel });
});

export const layer = Layer.effect(GitHubAppSignIn, make);

/**
 * KimiOAuth — server-side "Sign in with Kimi" via the OAuth 2.0 Device
 * Authorization Grant (RFC 8628) against Moonshot's auth service.
 *
 * The flow produces exactly the credential file the Kimi CLI writes for
 * itself (`$KIMI_CODE_HOME/credentials/kimi-code.json`), so after a
 * successful sign-in `kimi` — and therefore the Kimi provider — is
 * authenticated without ever opening a terminal. Token refresh stays with
 * the CLI, which already refreshes on use with cross-process locking.
 *
 * Endpoints, client id, and the credential format mirror kimi-cli
 * (`src/kimi_cli/auth/oauth.py`).
 *
 * @module provider/kimi/KimiOAuth
 */
import * as NodeOS from "node:os";

import {
  KimiAuthDeniedError,
  type KimiAuthError,
  KimiAuthExpiredError,
  KimiAuthInstanceInvalidError,
  KimiAuthRequestError,
  KimiCredentialRemoveError,
  KimiCredentialWriteError,
  type KimiAuthSignInEvent,
  KimiOAuthErrorCode,
  KimiSettings,
  defaultInstanceIdForDriver,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import { expandHomePath } from "../../pathExpansion.ts";

const DEFAULT_OAUTH_HOST = "https://auth.kimi.com";
const DEVICE_AUTHORIZATION_PATH = "/api/oauth/device_authorization";
const TOKEN_PATH = "/api/oauth/token";
// Public device-flow client id shipped inside kimi-cli; not a secret.
const KIMI_OAUTH_CLIENT_ID = "17e5f671-d194-4dfb-9706-5516cb48c098";
const DEVICE_CODE_GRANT = "urn:ietf:params:oauth:grant-type:device_code";
const KIMI_CODE_HOME_DIR_NAME = ".kimi-code";
const CREDENTIALS_DIR_NAME = "credentials";
const CREDENTIALS_FILE_NAME = "kimi-code.json";
// RFC 8628 defaults: poll every 5s unless told otherwise, and never poll
// past the device authorization's own expiry (capped defensively).
const DEFAULT_POLL_INTERVAL_SECONDS = 5;
const DEFAULT_EXPIRES_IN_SECONDS = 600;
const MAX_SIGN_IN_DURATION = Duration.minutes(15);

/** Where the Kimi CLI resolves its data root, honoring a per-instance homePath. */
export function resolveKimiCodeHome(homePath: string | null | undefined): string {
  const trimmed = homePath?.trim();
  return trimmed ? expandHomePath(trimmed) : `${NodeOS.homedir()}/${KIMI_CODE_HOME_DIR_NAME}`;
}

const decodeKimiSettingsExit = Schema.decodeUnknownExit(KimiSettings);
const KIMI_DRIVER = ProviderDriverKind.make("kimi");
const DEFAULT_KIMI_INSTANCE_ID = defaultInstanceIdForDriver(KIMI_DRIVER);

export interface KimiAuthTarget {
  readonly instanceId: ProviderInstanceId;
  readonly homePath: string | undefined;
}

export const resolveKimiAuthTarget = Effect.fn("kimi.oauth.resolve_target")(function* (
  settings: ServerSettings,
  instanceId: ProviderInstanceId | undefined,
) {
  const targetInstanceId = instanceId ?? DEFAULT_KIMI_INSTANCE_ID;
  const instance = settings.providerInstances[targetInstanceId];
  if (instance !== undefined) {
    if (instance.driver !== KIMI_DRIVER) {
      return yield* new KimiAuthInstanceInvalidError({
        instanceId: targetInstanceId,
        issue: "wrong-driver",
      });
    }
    const decoded = decodeKimiSettingsExit(instance.config ?? {});
    if (Exit.isFailure(decoded)) {
      return yield* new KimiAuthInstanceInvalidError({
        instanceId: targetInstanceId,
        issue: "invalid-settings",
        cause: decoded.cause,
      });
    }
    return {
      instanceId: targetInstanceId,
      homePath: decoded.value.homePath.trim() || undefined,
    } satisfies KimiAuthTarget;
  }
  if (targetInstanceId !== DEFAULT_KIMI_INSTANCE_ID) {
    return yield* new KimiAuthInstanceInvalidError({
      instanceId: targetInstanceId,
      issue: "not-found",
    });
  }
  return {
    instanceId: DEFAULT_KIMI_INSTANCE_ID,
    homePath: settings.providers.kimi.homePath.trim() || undefined,
  } satisfies KimiAuthTarget;
});

export const resolveKimiSignInHomePath = Effect.fn("kimi.oauth.resolve_sign_in_home")(function* (
  settings: ServerSettings,
  instanceId: ProviderInstanceId | undefined,
) {
  return (yield* resolveKimiAuthTarget(settings, instanceId)).homePath;
});

function resolveOAuthHost(): string {
  const override =
    process.env.KIMI_CODE_OAUTH_HOST?.trim() || process.env.KIMI_OAUTH_HOST?.trim() || "";
  return (override || DEFAULT_OAUTH_HOST).replace(/\/+$/, "");
}

const DeviceAuthorizationResponse = Schema.Struct({
  device_code: Schema.String,
  user_code: Schema.optional(Schema.String),
  verification_uri: Schema.optional(Schema.String),
  verification_uri_complete: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  interval: Schema.optional(Schema.Number),
});

const TokenPollResponse = Schema.Struct({
  access_token: Schema.optional(Schema.String),
  refresh_token: Schema.optional(Schema.String),
  expires_in: Schema.optional(Schema.Number),
  scope: Schema.optional(Schema.String),
  token_type: Schema.optional(Schema.String),
  error: Schema.optional(Schema.String),
  error_description: Schema.optional(Schema.String),
});
type TokenPollResponse = typeof TokenPollResponse.Type;
const isKimiOAuthErrorCode = Schema.is(KimiOAuthErrorCode);

const postForm = Effect.fn("kimi.oauth.post_form")(function* (
  path: string,
  params: Record<string, string>,
) {
  const httpClient = yield* HttpClient.HttpClient;
  const response = yield* HttpClientRequest.post(`${resolveOAuthHost()}${path}`).pipe(
    HttpClientRequest.setHeader("accept", "application/json"),
    HttpClientRequest.bodyUrlParams(params),
    httpClient.execute,
  );
  return response;
});

const requestDeviceAuthorization = Effect.fn("kimi.oauth.device_authorization")(function* () {
  const response = yield* postForm(DEVICE_AUTHORIZATION_PATH, {
    client_id: KIMI_OAUTH_CLIENT_ID,
  }).pipe(
    Effect.mapError(
      (cause) =>
        new KimiAuthRequestError({
          operation: "device-authorization-request",
          cause,
        }),
    ),
  );
  if (response.status !== 200) {
    return yield* new KimiAuthRequestError({
      operation: "device-authorization-request",
      status: response.status,
    });
  }
  return yield* HttpClientResponse.schemaBodyJson(DeviceAuthorizationResponse)(response).pipe(
    Effect.mapError(
      (cause) =>
        new KimiAuthRequestError({
          operation: "device-authorization-response",
          cause,
        }),
    ),
  );
});

const pollToken = Effect.fn("kimi.oauth.poll_token")(
  function* (deviceCode: string) {
    const response = yield* postForm(TOKEN_PATH, {
      client_id: KIMI_OAUTH_CLIENT_ID,
      device_code: deviceCode,
      grant_type: DEVICE_CODE_GRANT,
    });
    const body = yield* HttpClientResponse.schemaBodyJson(TokenPollResponse)(response);
    return { status: response.status, body };
  },
  Effect.mapError(
    (cause) =>
      new KimiAuthRequestError({
        operation: "token-poll",
        cause,
      }),
  ),
);

/** kimi-cli's on-disk credential shape (`credentials/kimi-code.json`). */
export function buildKimiCredentialsJson(
  token: Pick<
    TokenPollResponse,
    "access_token" | "refresh_token" | "expires_in" | "scope" | "token_type"
  >,
  nowEpochMs: number,
): string {
  const expiresIn = token.expires_in ?? 900;
  return `${JSON.stringify(
    {
      access_token: token.access_token,
      refresh_token: token.refresh_token,
      expires_at: nowEpochMs / 1000 + expiresIn,
      scope: token.scope ?? "kimi-code",
      token_type: token.token_type ?? "Bearer",
      expires_in: expiresIn,
    },
    null,
    2,
  )}\n`;
}

/**
 * Persist the credential exactly where kimi-cli looks for it, atomically
 * (tmp → rename) with owner-only permissions, matching the CLI's own writes.
 */
export const writeKimiCredentials = Effect.fn("kimi.oauth.write_credentials")(function* (
  homePath: string | null | undefined,
  token: TokenPollResponse,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const nowEpochMs = yield* Clock.currentTimeMillis;

  const credentialsDir = path.join(resolveKimiCodeHome(homePath), CREDENTIALS_DIR_NAME);
  const credentialsPath = path.join(credentialsDir, CREDENTIALS_FILE_NAME);
  const temporaryPath = `${credentialsPath}.${process.pid}.${nowEpochMs}.tmp`;

  yield* Effect.gen(function* () {
    yield* fileSystem.makeDirectory(credentialsDir, { recursive: true, mode: 0o700 });
    yield* fileSystem.writeFileString(temporaryPath, buildKimiCredentialsJson(token, nowEpochMs), {
      mode: 0o600,
    });
    yield* fileSystem.rename(temporaryPath, credentialsPath);
  }).pipe(
    Effect.tapError(() => Effect.ignore(fileSystem.remove(temporaryPath, { force: true }))),
    Effect.mapError((cause) => new KimiCredentialWriteError({ credentialsPath, cause })),
  );

  return credentialsPath;
});

export const removeKimiCredentials = Effect.fn("kimi.oauth.remove_credentials")(function* (
  homePath: string | null | undefined,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const credentialsPath = path.join(
    resolveKimiCodeHome(homePath),
    CREDENTIALS_DIR_NAME,
    CREDENTIALS_FILE_NAME,
  );
  yield* fileSystem
    .remove(credentialsPath, { force: true })
    .pipe(Effect.mapError((cause) => new KimiCredentialRemoveError({ credentialsPath, cause })));
  return credentialsPath;
});

export interface KimiSignInInput {
  /** KIMI_CODE_HOME override from the target provider instance, if any. */
  readonly homePath?: string | null | undefined;
}

/**
 * Run one device-flow sign-in. Emits `verification` as soon as the user has
 * something to open, then polls until approval and emits `completed` after
 * the credential file is written. Interrupting the stream abandons the
 * attempt without side effects.
 */
export function signInWithKimi(
  input: KimiSignInInput,
): Stream.Stream<
  KimiAuthSignInEvent,
  KimiAuthError,
  HttpClient.HttpClient | FileSystem.FileSystem | Path.Path
> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const authorization = yield* requestDeviceAuthorization();
      const verificationUri =
        authorization.verification_uri_complete?.trim() ||
        authorization.verification_uri?.trim() ||
        "";
      if (!verificationUri) {
        return Stream.fail(
          new KimiAuthRequestError({
            operation: "device-authorization-response",
          }),
        );
      }
      const expiresInSeconds = authorization.expires_in ?? DEFAULT_EXPIRES_IN_SECONDS;
      const userCode = authorization.user_code?.trim();

      const verificationEvent: KimiAuthSignInEvent = {
        type: "verification",
        verificationUri,
        ...(userCode ? { userCode } : {}),
        expiresInSeconds,
      };

      const completion = Effect.gen(function* () {
        const startedAtMs = yield* Clock.currentTimeMillis;
        const deadlineMs =
          startedAtMs + Math.min(expiresInSeconds * 1000, Duration.toMillis(MAX_SIGN_IN_DURATION));
        let intervalSeconds = Math.max(1, authorization.interval ?? DEFAULT_POLL_INTERVAL_SECONDS);

        while ((yield* Clock.currentTimeMillis) < deadlineMs) {
          const remainingMs = deadlineMs - (yield* Clock.currentTimeMillis);
          yield* Effect.sleep(Duration.millis(Math.min(intervalSeconds * 1000, remainingMs)));
          if ((yield* Clock.currentTimeMillis) >= deadlineMs) {
            break;
          }
          const poll = yield* pollToken(authorization.device_code);
          if (poll.status === 200 && poll.body.access_token) {
            yield* writeKimiCredentials(input.homePath, poll.body);
            return { type: "completed" } as const satisfies KimiAuthSignInEvent;
          }
          switch (poll.body.error) {
            case "authorization_pending":
              continue;
            case "slow_down":
              intervalSeconds += 5;
              continue;
            case "access_denied":
              return yield* new KimiAuthDeniedError();
            case "expired_token":
              return yield* new KimiAuthExpiredError();
            default:
              return yield* new KimiAuthRequestError({
                operation: "token-poll",
                status: poll.status,
                ...(isKimiOAuthErrorCode(poll.body.error)
                  ? { oauthErrorCode: poll.body.error }
                  : {}),
                cause: {
                  error: poll.body.error,
                  errorDescription: poll.body.error_description,
                },
              });
          }
        }
        return yield* new KimiAuthExpiredError();
      });

      return Stream.concat(Stream.make(verificationEvent), Stream.fromEffect(completion));
    }),
  );
}

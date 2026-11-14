// @effect-diagnostics nodeBuiltinImport:off - OAuth loopback listener and PKCE use Node APIs.
import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";
import { createRemoteJWKSet, jwtVerify } from "jose";
import {
  ProviderSetupError,
  type ChatGptReconnectProfile,
  type ChatGptTransferredProfile,
  type ProviderInstanceId,
} from "@t3tools/contracts";
import { codexCallbackUrl } from "@t3tools/shared/codexAuthHandoff";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import { openAiUserId } from "../telemetry/Identify.ts";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Hex from "effect/encoding/Hex";
import * as Exit from "effect/Exit";
import { codexAuthCallbackPage, codexAuthReturnUrl } from "./CodexAuthCallbackPage.ts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as ProviderAuthFlow from "@t3tools/provider-core/server/providerAuthFlow";
import type { ProviderAuthFlowContext } from "@t3tools/provider-core/server/providerAuthFlow";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ProviderCredentialStore from "./ProviderCredentialStore.ts";
import { withChatGptSessionLock } from "./CodexChatGptSessionLock.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { CodexChatGptCredentials } from "./CodexChatGptAuth-part2.ts";
import { DISCOVERY, Discovery, REQUIRED_SCOPE, RESOURCE, Record, Registration, RegistrationProfiles, Sessions, TokenResponse, decodeDiscoveryEffect, decodeOAuthError, decodeRegistration, decodeSessions, decodeTokens, encodeRegistration, encodeSessions, isSetupError, profileMethodId, sessionLocks } from "./CodexChatGptAuth-part2.ts";


export interface CodexChatGptAuthOptions {
  readonly instanceId: ProviderInstanceId;
  readonly discoveryUrl?: string;
  readonly resource?: string;
  readonly defaultReturnUrl?: string;
  readonly reconnectProfile?: ChatGptReconnectProfile | null;
  readonly telemetryFlow?: "direct" | "primary_handoff";
  readonly expectedProfileKey?: string;
}

/** Credential plumbing: stores, discovery, token exchange. Flows that use it live in -part4. */
export const makeCodexChatGptAuthState = Effect.fn("CodexChatGptAuth.state")(function* (
  options: CodexChatGptAuthOptions,
) {
  const analytics = yield* Effect.serviceOption(AnalyticsService.AnalyticsService);
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const track = Effect.fn("CodexChatGptAuth.track")(function* <A, E extends ProviderSetupError, R>(
    event: "auth" | "transfer",
    properties: Readonly<Record<string, string>>,
    task: Effect.Effect<A, E, R>,
    expiresAt?: number,
  ) {
    if (Option.isNone(analytics)) return yield* task;
    const record = (name: string, properties: Readonly<Record<string, unknown>>) =>
      analytics.value.record(name, properties).pipe(Effect.ignoreCause);
    const startedAt = yield* Clock.currentTimeMillis;
    yield* record(`chatgpt.${event}.started`, properties);
    return yield* task.pipe(
      Effect.onExit((result) =>
        Effect.gen(function* () {
          const endedAt = yield* Clock.currentTimeMillis;
          const error = Exit.isFailure(result)
            ? Cause.findErrorOption(result.cause)
            : Option.none();
          const counts =
            Exit.isSuccess(result) &&
            (event === "transfer" || options.telemetryFlow !== "primary_handoff")
              ? yield* accountCounts.pipe(Effect.catchCause(() => Effect.succeed({})))
              : {};
          yield* record(`chatgpt.${event}.completed`, {
            ...counts,
            ...properties,
            outcome: Exit.isSuccess(result)
              ? "succeeded"
              : Cause.hasInterruptsOnly(result.cause)
                ? expiresAt !== undefined && endedAt >= expiresAt
                  ? "expired"
                  : "cancelled"
                : "failed",
            durationMs: Math.max(0, endedAt - startedAt),
            ...(Option.isSome(error) && isSetupError(error.value)
              ? { failureStage: error.value.operation }
              : {}),
          });
        }),
      ),
    );
  });
  const http = yield* HttpClient.HttpClient;
  const store = yield* ProviderCredentialStore.make("codex-chatgpt", options.instanceId);
  const registrationStore = yield* ProviderCredentialStore.make(
    "codex-chatgpt-registration",
    options.instanceId,
  );
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  const random = yield* SecureRandom.SecureRandom;
  const digest = yield* Digest.Digest;
  const environmentLocks = sessionLocks.get(secrets) ?? new Map<string, Semaphore.Semaphore>();
  sessionLocks.set(secrets, environmentLocks);
  const lock = environmentLocks.get(store.binding.key) ?? (yield* Semaphore.make(1));
  environmentLocks.set(store.binding.key, lock);
  const withSessionLock = <A, E, R>(task: Effect.Effect<A, E, R>) =>
    withChatGptSessionLock(secrets.directory, store.binding.key, options.instanceId, task);
  const environment = yield* ServerEnvironment.ServerEnvironmentIdentity;
  const hostId = `urn:uuid:${yield* environment.getEnvironmentId}`;
  const resource = options.resource ?? RESOURCE;
  const failure = (operation: string, detail: string) =>
    new ProviderSetupError({ instanceId: options.instanceId, operation, detail });
  let metadata: typeof Discovery.Type | undefined;
  let jwks: ReturnType<typeof createRemoteJWKSet> | undefined;
  const discover = Effect.gen(function* () {
    if (metadata) return metadata;
    const result = yield* http.get(options.discoveryUrl ?? DISCOVERY).pipe(
      Effect.flatMap((response) =>
        Effect.gen(function* () {
          if (response.status < 200 || response.status >= 300)
            return yield* failure("discover", "Could not reach ChatGPT sign-in. Try again.");
          return yield* response.json;
        }),
      ),
      Effect.flatMap(decodeDiscoveryEffect),
      Effect.mapError(() => failure("discover", "Could not reach ChatGPT sign-in. Try again.")),
    );
    if (
      !options.discoveryUrl &&
      (result.issuer !== "https://auth.openai.com" ||
        [
          result.authorization_endpoint,
          result.token_endpoint,
          result.jwks_uri,
          ...(result.revocation_endpoint ? [result.revocation_endpoint] : []),
        ].some((url) => new URL(url).origin !== result.issuer))
    )
      return yield* failure("discover", "ChatGPT sign-in configuration could not be verified.");
    metadata = result;
    jwks = createRemoteJWKSet(new URL(result.jwks_uri));
    return result;
  });
  const readSessions = store.get.pipe(
    Effect.mapError(() => failure("read", "Could not read the saved ChatGPT connection.")),
    Effect.flatMap((bytes) =>
      Option.isNone(bytes)
        ? Effect.succeed<typeof Sessions.Type>({ activeClientId: null, sessions: [] })
        : decodeSessions(new TextDecoder().decode(bytes.value)).pipe(
            Effect.map((saved) =>
              "sessions" in saved ? saved : { activeClientId: saved.clientId, sessions: [saved] },
            ),
            Effect.mapError(() =>
              failure("read", "The saved ChatGPT connection is invalid. Sign in again."),
            ),
          ),
    ),
  );
  const read = readSessions.pipe(
    Effect.map((saved) =>
      Option.fromUndefinedOr(
        saved.sessions.find((session) => session.clientId === saved.activeClientId),
      ),
    ),
    // The OpenAI account is the person, so it marks who owns this install.
    Effect.tap((credentials) => {
      const userId = Option.flatMap(credentials, (saved) =>
        Option.flatMap(Option.fromUndefinedOr(saved.idToken), openAiUserId),
      );
      return Option.isSome(userId) && Option.isSome(analytics)
        ? analytics.value.recordOwners(
            [{ source: "openai", ownerId: hashTelemetryId(userId.value) }],
            "server",
          )
        : Effect.void;
    }),
  );
  const writeSessions = (saved: typeof Sessions.Type) =>
    encodeSessions(saved).pipe(
      Effect.flatMap((json) => store.set(new TextEncoder().encode(json))),
      Effect.mapError(() => failure("save", "Could not save the ChatGPT connection.")),
    );
  const readRegistrations = registrationStore.get.pipe(
    Effect.mapError(() =>
      failure("registration", "Could not read the ChatGPT sign-in registration. Try again."),
    ),
    Effect.flatMap((bytes) =>
      Option.isNone(bytes)
        ? Effect.succeed<typeof RegistrationProfiles.Type>({ profiles: [], lastClientId: null })
        : decodeRegistration(new TextDecoder().decode(bytes.value)).pipe(
            Effect.map((record) => {
              const saved =
                "profiles" in record
                  ? record
                  : { profiles: [record], lastClientId: record.clientId };
              const last = saved.profiles.find(
                (profile) => profile.clientId === saved.lastClientId,
              );
              const ordered = last
                ? [last, ...saved.profiles.filter((profile) => profile.clientId !== last.clientId)]
                : saved.profiles;
              return {
                ...saved,
                profiles: ordered.map((profile) => ({
                  ...profile,
                  connectionLabel:
                    profile.connectionLabel ?? `Connection ${saved.profiles.indexOf(profile) + 1}`,
                })),
              };
            }),
            Effect.mapError(() =>
              failure("registration", "The saved ChatGPT sign-in registration is invalid."),
            ),
          ),
    ),
  );
  const accountCounts = Effect.gen(function* () {
    const instanceIds = new Set<string>([options.instanceId]);
    if (Option.isSome(settings)) {
      const current = yield* settings.value.getSettings;
      instanceIds.add("codex");
      for (const [id, instance] of Object.entries(current.providerInstances)) {
        if (instance.driver === "codex") instanceIds.add(id);
      }
    }
    const accounts = new Set<string>();
    const connections = new Set<string>();
    const savedConnections = new Set<string>();
    let unidentifiedConnectedConnectionCount = 0;
    for (const id of instanceIds) {
      const registrations = yield* ProviderCredentialStore.make("codex-chatgpt-registration", id);
      const registrationBytes = yield* registrations.get;
      if (Option.isSome(registrationBytes)) {
        const saved = yield* decodeRegistration(new TextDecoder().decode(registrationBytes.value));
        for (const profile of "profiles" in saved ? saved.profiles : [saved]) {
          savedConnections.add(profile.clientId);
        }
      }
      const credentials = yield* ProviderCredentialStore.make("codex-chatgpt", id);
      const credentialBytes = yield* credentials.get;
      if (Option.isNone(credentialBytes)) continue;
      const saved = yield* decodeSessions(new TextDecoder().decode(credentialBytes.value));
      for (const session of "sessions" in saved ? saved.sessions : [saved]) {
        if (!session.scopes.includes(REQUIRED_SCOPE) || connections.has(session.clientId)) continue;
        connections.add(session.clientId);
        // Client-scoped subjects need verified email for local counting only; never export email or merge profiles.
        const email = session.email?.trim().toLowerCase();
        if (email) accounts.add(email);
        else unidentifiedConnectedConnectionCount++;
      }
    }
    return {
      accountCountScope: Option.isSome(settings) ? "environment" : "provider_instance",
      connectedAccountCount: accounts.size,
      connectedConnectionCount: connections.size,
      savedConnectionCount: savedConnections.size,
      unidentifiedConnectedConnectionCount,
    };
  }).pipe(
    Effect.provideService(ServerSecretStore.ServerSecretStore, secrets),
    Effect.provideService(SecureRandom.SecureRandom, random),
    Effect.provideService(Digest.Digest, digest),
  );
  const saveRegistration = Effect.fnUntraced(function* (profile: typeof Registration.Type) {
    const saved = yield* readRegistrations;
    profile = {
      ...profile,
      connectionLabel:
        saved.profiles.find((entry) => entry.clientId === profile.clientId)?.connectionLabel ??
        profile.connectionLabel ??
        `Connection ${saved.profiles.length + 1}`,
    };
    yield* encodeRegistration({
      profiles: [profile, ...saved.profiles.filter((entry) => entry.clientId !== profile.clientId)],
      lastClientId: profile.clientId,
    }).pipe(
      Effect.flatMap((json) => registrationStore.set(new TextEncoder().encode(json))),
      Effect.mapError(() =>
        failure("registration", "Could not save the ChatGPT sign-in registration. Try again."),
      ),
    );
  });
  const save = Effect.fnUntraced(function* (record: CodexChatGptCredentials, activate = true) {
    const saved = yield* readSessions;
    yield* writeSessions({
      activeClientId: activate ? record.clientId : saved.activeClientId,
      sessions: [
        ...saved.sessions.filter((session) => session.clientId !== record.clientId),
        record,
      ],
    });
  });
  const clearTokens = Effect.gen(function* () {
    const saved = yield* readSessions;
    const sessions = saved.sessions.filter((session) => session.clientId !== saved.activeClientId);
    if (sessions.length) yield* writeSessions({ activeClientId: null, sessions });
    else
      yield* store.remove.pipe(
        Effect.mapError(() =>
          failure("disconnect", "Could not clear the ChatGPT connection. Try again."),
        ),
      );
  });
  const remove = Effect.gen(function* () {
    const credentials = yield* read;
    if (Option.isSome(credentials)) {
      const { clientId, subject, email } = credentials.value;
      const saved = yield* readRegistrations;
      const profile = saved.profiles.find((entry) => entry.clientId === clientId);
      if (profile && (profile.subject === undefined || profile.email === undefined))
        yield* saveRegistration({ ...profile, subject, email });
    }
    yield* clearTokens;
  });
  const exchange = Effect.fn("CodexChatGptAuth.exchange")(function* (body: URLSearchParams) {
    const endpoints = yield* discover;
    const response = yield* http
      .execute(
        HttpClientRequest.post(endpoints.token_endpoint).pipe(
          HttpClientRequest.setHeader("accept", "application/json"),
          HttpClientRequest.bodyText(body.toString(), "application/x-www-form-urlencoded"),
        ),
      )
      .pipe(
        Effect.flatMap((result) =>
          result.json.pipe(
            Effect.map((raw) => ({
              ok: result.status >= 200 && result.status < 300,
              status: result.status,
              raw,
            })),
          ),
        ),
        Effect.mapError(() =>
          failure("exchange", "ChatGPT sign-in is temporarily unavailable. Try again."),
        ),
      );
    if (!response.ok) {
      const error = yield* Effect.try({
        try: () => decodeOAuthError(response.raw).error,
        catch: () => failure("exchange", "ChatGPT did not accept this sign-in. Try again."),
      });
      if (
        body.get("grant_type") === "refresh_token" &&
        [
          "invalid_grant",
          "invalid_refresh_token",
          "token_expired",
          "refresh_token_expired",
          "refresh_token_invalidated",
          "refresh_token_reused",
        ].includes(error)
      ) {
        yield* remove;
        return yield* failure(
          "refresh",
          "Your ChatGPT connection expired or was disconnected. Sign in again.",
        );
      }
      if (error === "invalid_client")
        return yield* failure(
          "client",
          "OpenAI rejected this app's client registration. Check the ChatGPT connection configuration.",
        );
      if (body.get("grant_type") === "authorization_code" && error === "invalid_grant")
        return yield* failure("code-expired", "This sign-in code expired. Start again.");
      return yield* failure(
        "exchange",
        error === "access_denied"
          ? "ChatGPT sign-in was declined. Sign in again when you are ready."
          : "ChatGPT could not complete sign-in. Try again.",
      );
    }
    return yield* Effect.try({
      try: () => decodeTokens(response.raw),
      catch: () =>
        failure("exchange", "ChatGPT returned an invalid token response. Sign in again."),
    });
  });
  const earliest = (value: (typeof TokenResponse.Type)["earliest_refresh_at"]) => {
    if (value === undefined) return null;
    const time = typeof value === "number" ? value * 1000 : Date.parse(value);
    return Number.isFinite(time) ? time : null;
  };
  return {
    options,
    analytics,
    http,
    store,
    lock,
    withSessionLock,
    hostId,
    resource,
    failure,
    discover,
    readSessions,
    read,
    readRegistrations,
    saveRegistration,
    save,
    remove,
    exchange,
    earliest,
    track,
    digest,
    getJwks: () => jwks,
  };
});

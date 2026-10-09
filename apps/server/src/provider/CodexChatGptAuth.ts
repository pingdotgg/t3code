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
import * as Clock from "effect/Clock";
import * as Cause from "effect/Cause";
import * as AnalyticsService from "../telemetry/AnalyticsService.ts";
import * as Crypto from "effect/Crypto";
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

const isSetupError = Schema.is(ProviderSetupError);
const RESOURCE = "https://api.openai.com/v1";
const REQUIRED_SCOPE = "chatgpt.tokens.use.direct";
const DISCOVERY = "https://auth.openai.com/.well-known/openid-configuration";
const TokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  refresh_token: Schema.optionalKey(Schema.NonEmptyString),
  id_token: Schema.optionalKey(Schema.String),
  token_type: Schema.String,
  expires_in: Schema.Int.check(Schema.isGreaterThan(0)),
  scope: Schema.String,
  earliest_refresh_at: Schema.optionalKey(Schema.Union([Schema.Finite, Schema.String])),
});
const Record = Schema.Struct({
  clientId: Schema.String,
  accessToken: Schema.String,
  refreshToken: Schema.NullOr(Schema.String),
  expiresAt: Schema.Finite,
  earliestRefreshAt: Schema.NullOr(Schema.Finite),
  scopes: Schema.Array(Schema.String),
  subject: Schema.String,
  email: Schema.NullOr(Schema.String),
  idToken: Schema.optionalKey(Schema.String),
  issuer: Schema.optionalKey(Schema.String),
});
export type CodexChatGptCredentials = typeof Record.Type;
const Sessions = Schema.Struct({
  activeClientId: Schema.NullOr(Schema.String),
  sessions: Schema.Array(Record),
});
const sessionLocks = new WeakMap<
  typeof ServerSecretStore.ServerSecretStore.Service,
  Map<string, Semaphore.Semaphore>
>();
const Registration = Schema.Struct({
  clientId: Schema.String.check(Schema.isPattern(/^oaiapp_/u)),
  subject: Schema.optionalKey(Schema.String),
  connectionLabel: Schema.optionalKey(Schema.String),
  sharingEnabled: Schema.optionalKey(Schema.Boolean),
  email: Schema.optionalKey(Schema.NullOr(Schema.String)),
  redirectUri: Schema.optionalKey(
    Schema.String.check(
      Schema.isPattern(/^http:\/\/(?:127\.0\.0\.1|localhost):[1-9]\d{0,4}\/auth\/callback$/u),
    ),
  ),
});
const RegistrationProfiles = Schema.Struct({
  profiles: Schema.Array(Registration),
  lastClientId: Schema.NullOr(Schema.String),
});
const decodeRegistration = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([RegistrationProfiles, Registration])),
);
const encodeRegistration = Schema.encodeEffect(Schema.fromJsonString(RegistrationProfiles));
const profileMethodId = (clientId: string) => `chatgpt-profile:${clientId}`;
const Discovery = Schema.Struct({
  issuer: Schema.String,
  authorization_endpoint: Schema.String,
  token_endpoint: Schema.String,
  jwks_uri: Schema.String,
  revocation_endpoint: Schema.optionalKey(Schema.String),
});
const OAuthError = Schema.Struct({ error: Schema.String });
const decodeSessions = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([Sessions, Record])),
);
const encodeSessions = Schema.encodeEffect(Schema.fromJsonString(Sessions));
const decodeTokens = Schema.decodeUnknownSync(TokenResponse);
const decodeDiscoveryEffect = Schema.decodeUnknownEffect(Discovery);
const decodeOAuthError = Schema.decodeUnknownSync(OAuthError);

export const makeCodexChatGptAuth = Effect.fn("makeCodexChatGptAuth")(function* (options: {
  readonly instanceId: ProviderInstanceId;
  readonly discoveryUrl?: string;
  readonly resource?: string;
  readonly defaultReturnUrl?: string;
  readonly reconnectProfile?: ChatGptReconnectProfile | null;
  readonly telemetryFlow?: "direct" | "primary_handoff";
}) {
  const analytics = yield* Effect.serviceOption(AnalyticsService.AnalyticsService);
  const settings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
  const track = <A, E extends ProviderSetupError, R>(
    event: "auth" | "transfer",
    properties: Readonly<Record<string, string>>,
    task: Effect.Effect<A, E, R>,
    expiresAt?: number,
  ) =>
    Effect.gen(function* () {
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
  const crypto = yield* Crypto.Crypto;
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
  );
  const writeSessions = (saved: typeof Sessions.Type) =>
    encodeSessions(saved).pipe(
      Effect.flatMap((json) => store.set(new TextEncoder().encode(json))),
      Effect.mapError(() => failure("save", "Could not save the ChatGPT connection.")),
    );
  // Registration profiles outlive tokens, but belong only to this environment/instance.
  // Accept the original single-registration record until it is next saved.
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
      // Include the legacy default instance as well as explicitly configured ones.
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
        // Subjects are client-scoped. Use verified email only for counting locally,
        // never export it or merge the underlying profiles.
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
    Effect.provideService(Crypto.Crypto, crypto),
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
  // The active pointer and all profile token sets change in one protected atomic write.
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
    // Promote legacy identity into the retained profile before deleting credentials.
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
  const authenticate = Effect.fn("CodexChatGptAuth.authenticate")(function* (
    method: string,
    context: ProviderAuthFlowContext,
  ) {
    const endpoints = yield* discover;
    const existing = yield* read;
    const previous = Option.getOrUndefined(existing);
    const registrations = yield* readRegistrations;
    const changingAccount = method === "chatgpt-change-account";
    const selectedClientId = method.startsWith("chatgpt-profile:")
      ? method.slice("chatgpt-profile:".length)
      : (previous?.clientId ?? registrations.lastClientId);
    const savedRegistration = changingAccount
      ? undefined
      : registrations.profiles.find((profile) => profile.clientId === selectedClientId);
    // Older development registrations used localhost, which cannot be changed on reauth.
    // Register a 127.0.0.1 connection instead, preserving the verified account.
    const legacyCallback = savedRegistration?.redirectUri?.includes("//localhost:") === true;
    const registeredClientId = legacyCallback ? undefined : savedRegistration?.clientId;
    const selectedTokens = (yield* readSessions).sessions.find(
      (session) => session.clientId === selectedClientId,
    );
    const state = NodeCrypto.randomBytes(32).toString("base64url");
    const nonce = NodeCrypto.randomBytes(32).toString("base64url");
    const verifier = NodeCrypto.randomBytes(64).toString("base64url");
    const returnUrl =
      codexAuthReturnUrl(context.returnUrl) ?? codexAuthReturnUrl(options.defaultReturnUrl);
    const pageNonce = NodeCrypto.randomBytes(24).toString("base64url");
    const callback = Promise.withResolvers<{ url: URL; response?: NodeHttp.ServerResponse }>();
    const clientCallback = context.callbackMode === "client";
    let used = false;
    const server = clientCallback
      ? undefined
      : yield* Effect.acquireRelease(
          Effect.tryPromise({
            try: () =>
              new Promise<NodeHttp.Server>((resolve, reject) => {
                const server = NodeHttp.createServer((request, response) => {
                  const url = new URL(request.url ?? "/", "http://127.0.0.1");
                  if (request.method !== "GET" || url.pathname !== "/auth/callback") {
                    response.writeHead(404).end();
                    return;
                  }
                  if (used) {
                    response.writeHead(410).end("Sign-in is no longer active.");
                    return;
                  }
                  used = true;
                  callback.resolve({ url, response });
                });
                server.once("error", reject);
                server.listen(0, "127.0.0.1", () => resolve(server));
              }),
            catch: () =>
              failure("callback", "Could not start the local sign-in callback. Try again."),
          }),
          (server) =>
            Effect.promise(
              () =>
                new Promise<void>((resolve) => {
                  server.closeAllConnections();
                  server.close(() => resolve());
                }),
            ),
        );
    const address = server?.address();
    if (!clientCallback && (!address || typeof address === "string"))
      return yield* failure("callback", "Could not start the local sign-in callback.");
    // Only the port may vary between attempts; token exchange uses this exact URI.
    const port =
      address && typeof address !== "string" ? address.port : NodeCrypto.randomInt(49_152, 65_536);
    const redirectUri = `http://127.0.0.1:${port}/auth/callback`;
    const idTokenHint = selectedTokens?.idToken ?? options.reconnectProfile?.idTokenHint;
    const url = new URL(endpoints.authorization_endpoint);
    url.search = new URLSearchParams({
      client_id: registeredClientId ?? "dynamic_agent_client",
      ...(registeredClientId
        ? {
            ...(savedRegistration?.email ? { login_hint: savedRegistration.email } : {}),
            ...(idTokenHint ? { id_token_hint: idTokenHint } : {}),
            ...(savedRegistration?.sharingEnabled === false ||
            (selectedTokens && !selectedTokens.scopes.includes(REQUIRED_SCOPE))
              ? { prompt: "consent" }
              : {}),
          }
        : { agent_name_hint: "T3 Code" }),
      ext_agent_host_id: hostId,
      response_type: "code",
      redirect_uri: redirectUri,
      scope: "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct",
      resource,
      state,
      nonce,
      code_challenge_method: "S256",
      code_challenge: NodeCrypto.createHash("sha256").update(verifier).digest("base64url"),
    }).toString();
    yield* context.setInteraction(
      {
        type: "browser",
        id: context.flowId,
        url: url.toString(),
        requiresConsent: false,
        acceptsCallback: true,
      },
      undefined,
      (callbackUrl) =>
        Effect.try({
          try: () => {
            const returned = codexCallbackUrl(callbackUrl, redirectUri, state);
            if (used) throw new Error("used");
            used = true;
            callback.resolve({ url: returned });
          },
          catch: () =>
            failure("complete", "This redirect URL does not belong to the active ChatGPT sign-in."),
        }),
    );
    const received = yield* Effect.tryPromise({
      try: () => callback.promise,
      catch: () => failure("callback", "ChatGPT sign-in could not be completed."),
    });
    const returned = received.url;
    yield* Effect.gen(function* () {
      if (returned.searchParams.get("state") !== state)
        return yield* failure("callback", "ChatGPT sign-in could not be verified. Start again.");
      if (returned.searchParams.has("error"))
        return yield* failure(
          "callback",
          returned.searchParams.get("error") === "access_denied"
            ? "ChatGPT sign-in was declined. Sign in again when you are ready."
            : "ChatGPT sign-in could not be completed. Start again.",
        );
      const code = returned.searchParams.get("code");
      const clientId = registeredClientId ?? returned.searchParams.get("client_id");
      if (
        !code ||
        !clientId ||
        !clientId.startsWith("oaiapp_") ||
        (registeredClientId &&
          returned.searchParams.has("client_id") &&
          returned.searchParams.get("client_id") !== registeredClientId)
      )
        return yield* failure(
          "callback",
          "ChatGPT registration is incomplete. Start sign-in again.",
        );
      yield* context.verifying;
      const tokens = yield* exchange(
        new URLSearchParams({
          grant_type: "authorization_code",
          client_id: clientId,
          code,
          code_verifier: verifier,
          redirect_uri: redirectUri,
          resource,
        }),
      ).pipe(
        Effect.catch((error) =>
          Effect.gen(function* () {
            if (error.operation === "code-expired") {
              if (!registeredClientId)
                yield* withSessionLock(saveRegistration({ clientId, redirectUri }));
              return yield* failure(
                "exchange",
                "This sign-in code expired. Reconnect the saved ChatGPT profile to start a fresh sign-in.",
              );
            }
            return yield* error;
          }),
        ),
      );
      if (!tokens.id_token)
        return yield* failure(
          "verify",
          "ChatGPT did not return a verified identity. Sign in again.",
        );
      const identity = yield* Effect.tryPromise({
        try: async () => {
          const { payload } = await jwtVerify(tokens.id_token!, jwks!, {
            issuer: endpoints.issuer,
            audience: clientId,
            algorithms: ["RS256", "ES256"],
            clockTolerance: 5,
          });
          if (payload.nonce !== nonce || !payload.sub || !payload.exp) throw new Error("identity");
          return {
            subject: payload.sub,
            email: typeof payload.email === "string" ? payload.email : null,
          };
        },
        catch: () => failure("verify", "ChatGPT sign-in could not be verified. Start again."),
      });
      const expectedSubject =
        savedRegistration?.subject ??
        (previous?.clientId === registeredClientId ? previous?.subject : undefined);
      // Subjects are checked within the same registration. Legacy callback migration
      // registers a new client, whose subject cannot be compared with the old client.
      if (registeredClientId && expectedSubject && identity.subject !== expectedSubject)
        return yield* failure(
          "verify",
          "This sign-in returned a different ChatGPT account. Use the different-account sign-in option instead. Your saved connection is unchanged.",
        );
      const knownProfile = registrations.profiles.find((profile) => profile.clientId === clientId);
      if (
        knownProfile &&
        ((knownProfile.redirectUri &&
          (() => {
            const original = new URL(knownProfile.redirectUri);
            const current = new URL(redirectUri);
            return (
              original.protocol !== current.protocol ||
              original.hostname !== current.hostname ||
              original.pathname !== current.pathname
            );
          })()) ||
          (knownProfile.subject && knownProfile.subject !== identity.subject))
      )
        return yield* failure(
          "verify",
          "ChatGPT returned a conflicting account registration. Start again.",
        );
      if (tokens.token_type.toLowerCase() !== "bearer")
        return yield* failure(
          "verify",
          "ChatGPT returned an unsupported connection. Sign in again.",
        );
      const scopes = tokens.scope.split(/\s+/).filter(Boolean);
      yield* withSessionLock(
        Effect.gen(function* () {
          yield* saveRegistration({
            clientId,
            redirectUri,
            sharingEnabled: scopes.includes(REQUIRED_SCOPE),
            ...identity,
          });
          yield* save(
            {
              clientId,
              accessToken: tokens.access_token,
              idToken: tokens.id_token!,
              issuer: endpoints.issuer,
              refreshToken: tokens.refresh_token ?? null,
              expiresAt: (yield* Clock.currentTimeMillis) + tokens.expires_in * 1000,
              earliestRefreshAt: earliest(tokens.earliest_refresh_at),
              scopes,
              ...identity,
            },
            scopes.includes(REQUIRED_SCOPE) || Option.isNone(yield* read),
          );
        }),
      );
      if (!scopes.includes(REQUIRED_SCOPE))
        return yield* failure(
          "sharing",
          previous && previous.clientId !== clientId
            ? "Token sharing was not enabled for the new account. Your existing ChatGPT connection is unchanged."
            : "Signed in with ChatGPT, but token sharing is disabled. Sign in again and enable token sharing, or use another provider.",
        );
    }).pipe(
      Effect.onExit((result) =>
        Effect.promise(
          () =>
            new Promise<void>((resolve) => {
              const response = received.response;
              if (!response || response.destroyed) {
                resolve();
                return;
              }
              response.once("close", resolve);
              response
                .writeHead(200, {
                  "content-type": "text/html; charset=utf-8",
                  "cache-control": "no-store",
                  "referrer-policy": "no-referrer",
                  "content-security-policy": `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${pageNonce}'; base-uri 'none'; frame-ancestors 'none'`,
                  "x-content-type-options": "nosniff",
                })
                .end(codexAuthCallbackPage(Exit.isSuccess(result), returnUrl, pageNonce), resolve);
            }),
        ),
      ),
    );
  });
  const access = lock.withPermit(
    withSessionLock(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const saved = yield* read;
          if (Option.isNone(saved))
            return yield* failure("access", "Sign in with ChatGPT to use managed Codex.");
          let record = saved.value;
          if (!record.scopes.includes(REQUIRED_SCOPE))
            return yield* failure(
              "sharing",
              "Token sharing is disabled. Sign in with ChatGPT and enable token sharing.",
            );
          const now = yield* Clock.currentTimeMillis;
          if (record.expiresAt - now > 60_000) return record;
          if (record.earliestRefreshAt !== null && record.earliestRefreshAt > now) {
            if (record.expiresAt > now) return record;
            return yield* failure(
              "refresh",
              "ChatGPT cannot renew this connection yet. Try again shortly.",
            );
          }
          if (!record.refreshToken) {
            yield* remove;
            return yield* failure("refresh", "Your ChatGPT connection expired. Sign in again.");
          }
          const tokens = yield* exchange(
            new URLSearchParams({
              grant_type: "refresh_token",
              client_id: record.clientId,
              refresh_token: record.refreshToken,
              resource,
            }),
          ).pipe(
            Effect.interruptible,
            Effect.timeout("20 seconds"),
            Effect.mapError((error) =>
              error._tag === "ProviderSetupError" && error.operation === "client"
                ? error
                : failure(
                    "refresh",
                    "Could not renew the ChatGPT connection. Retry, or sign in again.",
                  ),
            ),
          );
          if (!tokens.refresh_token || tokens.token_type.toLowerCase() !== "bearer") {
            return yield* failure("refresh", "ChatGPT returned an invalid renewal. Sign in again.");
          }
          record = {
            ...record,
            accessToken: tokens.access_token,
            refreshToken: tokens.refresh_token,
            expiresAt: (yield* Clock.currentTimeMillis) + tokens.expires_in * 1000,
            earliestRefreshAt: earliest(tokens.earliest_refresh_at),
            scopes: tokens.scope.split(/\s+/).filter(Boolean),
          };
          yield* save(record);
          if (!record.scopes.includes(REQUIRED_SCOPE))
            return yield* failure(
              "sharing",
              "ChatGPT token sharing is no longer enabled. Sign in again.",
            );
          return record;
        }),
      ),
    ),
  );
  const logout = Effect.gen(function* () {
    const credentials = Option.getOrUndefined(yield* read);
    let confirmed = !credentials?.refreshToken;
    if (credentials?.refreshToken) {
      for (let attempt = 0; attempt < 3; attempt++) {
        const result = yield* Effect.gen(function* () {
          const endpoints = yield* discover;
          if (!endpoints.revocation_endpoint) return { confirmed: false, retry: false };
          const response = yield* http.execute(
            HttpClientRequest.post(endpoints.revocation_endpoint).pipe(
              HttpClientRequest.bodyText(
                new URLSearchParams({
                  token: credentials.refreshToken!,
                  token_type_hint: "refresh_token",
                  client_id: credentials.clientId,
                }).toString(),
                "application/x-www-form-urlencoded",
              ),
            ),
          );
          return { confirmed: response.status === 200, retry: response.status >= 500 };
        }).pipe(
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() => ({ confirmed: false, retry: true })),
        );
        confirmed = result.confirmed;
        if (confirmed || !result.retry || attempt === 2) break;
        yield* Effect.sleep(attempt === 0 ? "250 millis" : "1 second");
      }
    }
    yield* remove;
    return confirmed
      ? undefined
      : "Signed out locally. Remote revocation could not be confirmed. Disconnect the app in ChatGPT Settings.";
  });
  if (options.reconnectProfile) {
    const { idTokenHint: _hint, ...registration } = options.reconnectProfile;
    yield* saveRegistration(registration).pipe(Effect.orDie);
  }
  const controller = yield* ProviderAuthFlow.make({
    instanceId: options.instanceId,
    credentialBinding: store.binding,
    refreshMethodsAfterAuth: true,
    methods: Effect.gen(function* () {
      const saved = yield* readRegistrations;
      const active = Option.getOrUndefined(yield* read);
      const current = saved.profiles.find(
        (profile) => profile.clientId === (active?.clientId ?? saved.lastClientId),
      );
      const profiles = current
        ? [current, ...saved.profiles.filter((profile) => profile.clientId !== current.clientId)]
        : saved.profiles;
      return [
        {
          id: "chatgpt",
          name: "Sign in with ChatGPT",
          description: current?.email ? `Reconnect ${current.email}.` : null,
          ...(current?.email ? { accountEmail: current.email } : {}),
          type: "agent" as const,
        },
        {
          id: "chatgpt-change-account",
          name: "Use a different ChatGPT account",
          description: "Register a connection for another ChatGPT account.",
          type: "agent" as const,
        },
        // The wire contract allows 32 methods; advertise the 30 most recent profiles.
        ...profiles.slice(0, 30).map((profile) => ({
          id: profileMethodId(profile.clientId),
          name: `${profile.email ?? "ChatGPT account"} · ${profile.connectionLabel}`,
          ...(profile.email ? { accountEmail: profile.email } : {}),
          description: "Reuse this account's original sign-in registration.",
          type: "agent" as const,
        })),
      ];
    }),
    authenticate: (method, context) =>
      lock.withPermit(
        track(
          "auth",
          {
            flow: options.telemetryFlow ?? "direct",
            intent:
              options.telemetryFlow === "primary_handoff"
                ? options.reconnectProfile
                  ? "saved_profile"
                  : "different_account"
                : method === "chatgpt-change-account"
                  ? "different_account"
                  : method.startsWith("chatgpt-profile:")
                    ? "saved_profile"
                    : "default",
            callbackMode: context.callbackMode ?? "server",
          },
          authenticate(method, context),
          context.expiresAt,
        ),
      ),
    logout: lock.withPermit(withSessionLock(logout)),
  });
  const reconnectProfile = Effect.fnUntraced(function* (methodId: string) {
    if (methodId === "chatgpt-change-account") return null;
    const registrations = yield* readRegistrations;
    const active = Option.getOrUndefined(yield* read);
    const clientId = methodId.startsWith("chatgpt-profile:")
      ? methodId.slice("chatgpt-profile:".length)
      : (active?.clientId ?? registrations.lastClientId);
    const registration = registrations.profiles.find((profile) => profile.clientId === clientId);
    if (!registration) {
      if (methodId.startsWith("chatgpt-profile:"))
        return yield* failure("export", "This saved connection is no longer available.");
      return null;
    }
    const session = (yield* readSessions).sessions.find((session) => session.clientId === clientId);
    return { ...registration, ...(session?.idToken ? { idTokenHint: session.idToken } : {}) };
  });
  const exportProfile = Effect.gen(function* () {
    const credentials = Option.getOrUndefined(yield* read);
    const registration =
      credentials &&
      (yield* readRegistrations).profiles.find(
        (profile) => profile.clientId === credentials.clientId,
      );
    if (!credentials?.idToken || !credentials.issuer || !registration)
      return yield* failure(
        "export",
        "Complete ChatGPT sign-in before transferring this connection.",
      );
    return {
      registration,
      credentials: { ...credentials, idToken: credentials.idToken, issuer: credentials.issuer },
    } satisfies ChatGptTransferredProfile;
  });
  const importProfile = (
    profile: ChatGptTransferredProfile,
    stopSessions: Effect.Effect<void, ProviderSetupError>,
  ) => {
    const validate = Effect.gen(function* () {
      const endpoints = yield* discover;
      const credentials = profile.credentials;
      if (
        credentials.clientId !== profile.registration.clientId ||
        credentials.issuer !== endpoints.issuer ||
        !credentials.scopes.includes(REQUIRED_SCOPE) ||
        credentials.expiresAt <= (yield* Clock.currentTimeMillis)
      )
        return yield* failure(
          "import",
          "The transferred ChatGPT connection is invalid or expired.",
        );
      const identity = yield* Effect.tryPromise({
        try: () =>
          jwtVerify(credentials.idToken, jwks!, {
            issuer: endpoints.issuer,
            audience: credentials.clientId,
            algorithms: ["RS256", "ES256"],
            clockTolerance: 5,
          }),
        catch: () => failure("import", "The transferred ChatGPT identity could not be verified."),
      });
      if (
        identity.payload.sub !== credentials.subject ||
        profile.registration.subject !== credentials.subject ||
        (identity.payload.email ?? null) !== credentials.email ||
        (profile.registration.email !== undefined &&
          profile.registration.email !== credentials.email)
      )
        return yield* failure(
          "import",
          "The transferred ChatGPT identity does not match its profile.",
        );
    });
    const saveImported = Effect.gen(function* () {
      const { idTokenHint: _hint, ...registration } = profile.registration;
      const existing = (yield* readRegistrations).profiles.find(
        (saved) => saved.clientId === registration.clientId,
      );
      if (existing?.subject && existing.subject !== profile.credentials.subject)
        return yield* failure(
          "import",
          "The transferred identity conflicts with the saved ChatGPT connection.",
        );
      yield* saveRegistration(registration);
      yield* save(profile.credentials, true);
    });
    return lock.withPermit(
      track(
        "transfer",
        { flow: "primary_handoff" },
        validate.pipe(
          Effect.andThen(controller.adoptCredentials!(withSessionLock(saveImported), stopSessions)),
        ),
      ),
    );
  };
  return {
    controller: { ...controller, reconnectProfile, importProfile },
    read,
    access,
    exportProfile,
    revoke: lock.withPermit(withSessionLock(remove)),
  };
});

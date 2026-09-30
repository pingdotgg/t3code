import * as NodeCrypto from "node:crypto";

import {
  AuthStandardClientScopes,
  EnvironmentId,
  type AuthClientPresentationMetadata,
} from "@t3tools/contracts";
import {
  RelayDpopAccessTokenScope,
  RelayEnvironmentConnectScope,
  RelayManagedEndpoint,
  RelayPublicClientId,
  RelayWebClientId,
} from "@t3tools/contracts/relay";
import {
  exchangeRemoteDpopAccessToken,
  resolveRemoteDpopWebSocketConnectionUrl,
} from "@t3tools/client-runtime/authorization";
import {
  environmentEndpointUrl,
  fetchRemoteEnvironmentDescriptor,
} from "@t3tools/client-runtime/environment";
import { ManagedRelay } from "@t3tools/client-runtime/relay";
import {
  computeDpopAccessTokenHash,
  computeDpopJwkThumbprint,
  normalizeDpopHtu,
  type DpopPublicJwk,
} from "@t3tools/shared/dpop";
import * as Effect from "effect/Effect";
import * as Encoding from "effect/Encoding";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { FetchHttpClient } from "effect/unstable/http";

import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as CliTokenManager from "../cloud/CliTokenManager.ts";
import { relayUrlConfig } from "../cloud/publicConfig.ts";
import { ServerConfig } from "../config.ts";
import { resolveCliAuthConfig } from "./config.ts";
import {
  accountEnvironmentCandidates,
  manualEnvironmentCandidates,
  resolveEnvironmentCandidate,
  type CliEnvironmentCandidate,
  type CliEnvironmentRegistry,
  CliEnvironmentSelectionError,
} from "./environmentRegistry.ts";

const DPOP_KEY_SECRET = "cloud-cli-dpop-proof-key";
const RELAY_TOKEN_CACHE_SECRET = "cloud-cli-relay-dpop-tokens";
const ENVIRONMENT_TOKEN_CACHE_SECRET = "cloud-cli-environment-dpop-tokens";
const TOKEN_REFRESH_SKEW_MS = 60_000;

const DpopPrivateJwk = Schema.Struct({
  kty: Schema.Literal("EC"),
  crv: Schema.Literal("P-256"),
  x: Schema.String,
  y: Schema.String,
  d: Schema.String,
});
type DpopPrivateJwk = typeof DpopPrivateJwk.Type;

const RelayTokenCacheEntry = Schema.Struct({
  accountId: Schema.String,
  clientId: RelayPublicClientId,
  relayUrl: Schema.String,
  thumbprint: Schema.String,
  scopes: Schema.Array(RelayDpopAccessTokenScope),
  accessToken: Schema.String,
  expiresAtMillis: Schema.Finite,
});
const RelayTokenCache = Schema.Array(RelayTokenCacheEntry);

const EnvironmentTokenCacheEntry = Schema.Struct({
  accountId: Schema.String,
  environmentId: EnvironmentId,
  relayUrl: Schema.String,
  label: Schema.String,
  endpoint: RelayManagedEndpoint,
  accessToken: Schema.String,
  expiresAtEpochMs: Schema.Finite,
  dpopThumbprint: Schema.String,
  clientId: Schema.optionalKey(RelayPublicClientId),
  authorizationScope: Schema.optionalKey(Schema.String),
});
type EnvironmentTokenCacheEntry = typeof EnvironmentTokenCacheEntry.Type;
const LegacyEnvironmentTokenCacheEntry = Schema.Struct({
  accountId: Schema.String,
  environmentId: EnvironmentId,
  label: Schema.String,
  endpoint: RelayManagedEndpoint,
  accessToken: Schema.String,
  expiresAtEpochMs: Schema.Finite,
  dpopThumbprint: Schema.String,
});
const EnvironmentTokenCache = Schema.Array(
  Schema.Union([EnvironmentTokenCacheEntry, LegacyEnvironmentTokenCacheEntry]),
);
const isEnvironmentTokenCacheEntry = Schema.is(EnvironmentTokenCacheEntry);

const decodeDpopPrivateJwk = Schema.decodeUnknownEffect(DpopPrivateJwk);
const decodeRelayTokenCache = Schema.decodeUnknownEffect(RelayTokenCache);
const decodeEnvironmentTokenCache = Schema.decodeUnknownEffect(EnvironmentTokenCache);
export const decodeUsableEnvironmentTokenCache = (value: unknown) =>
  decodeEnvironmentTokenCache(value).pipe(
    Effect.map((entries) => entries.filter(isEnvironmentTokenCacheEntry)),
  );

export class CliAccountEnvironmentError extends Schema.TaggedErrorClass<CliAccountEnvironmentError>()(
  "CliAccountEnvironmentError",
  {
    message: Schema.String,
    cause: Schema.optional(Schema.Unknown),
  },
) {}
const isCliAccountEnvironmentError = Schema.is(CliAccountEnvironmentError);
const isCliEnvironmentSelectionError = Schema.is(CliEnvironmentSelectionError);
const resolveCandidateEffect = (
  selector: string,
  candidates: ReadonlyArray<CliEnvironmentCandidate>,
) =>
  Effect.try({
    try: () => resolveEnvironmentCandidate(selector, candidates),
    catch: (cause) =>
      isCliEnvironmentSelectionError(cause)
        ? cause
        : new CliEnvironmentSelectionError({
            reason: "not-found",
            message: cause instanceof Error ? cause.message : String(cause),
          }),
  });

export interface CliAccountSession {
  readonly accountId: string;
  readonly identity?: string;
  readonly accessToken: string;
}

export interface CliAccountEnvironmentTarget {
  readonly source: "account";
  readonly accountId: string;
  readonly environmentId: string;
  readonly label: string;
  readonly origin: string;
  readonly nextSocketUrl: Effect.Effect<string, CliAccountEnvironmentError>;
  readonly request: (
    path: string,
    request: Request,
  ) => Effect.Effect<Response, CliAccountEnvironmentError>;
}

interface CliDpopSigner {
  readonly thumbprint: string;
  readonly createProof: (input: {
    readonly method: string;
    readonly url: string;
    readonly accessToken?: string;
  }) => Effect.Effect<string, CliAccountEnvironmentError>;
}

export function findReusableEnvironmentToken(
  entries: ReadonlyArray<EnvironmentTokenCacheEntry>,
  input: {
    readonly accountId: string;
    readonly environmentId: EnvironmentId;
    readonly relayUrl: string;
    readonly dpopThumbprint: string;
    readonly nowEpochMs: number;
    readonly rejectedAccessToken?: string;
  },
): EnvironmentTokenCacheEntry | undefined {
  return entries.find(
    (entry) =>
      entry.accountId === input.accountId &&
      entry.environmentId === input.environmentId &&
      entry.relayUrl === input.relayUrl &&
      entry.dpopThumbprint === input.dpopThumbprint &&
      entry.clientId === RelayWebClientId &&
      entry.authorizationScope === [...AuthStandardClientScopes].sort().join(" ") &&
      entry.expiresAtEpochMs > input.nowEpochMs + TOKEN_REFRESH_SKEW_MS &&
      entry.accessToken !== input.rejectedAccessToken,
  );
}

const bytes = (value: string): Uint8Array => new TextEncoder().encode(value);
const text = (value: Uint8Array): string => new TextDecoder().decode(value);

const readJsonSecret = <A>(
  secrets: ServerSecretStore.ServerSecretStoreShape,
  name: string,
  decode: (value: unknown) => Effect.Effect<A, unknown>,
  fallback: A,
) =>
  Effect.gen(function* () {
    const stored = yield* secrets.get(name);
    if (Option.isNone(stored)) return fallback;
    const parsed = yield* Effect.try({
      try: () => JSON.parse(text(stored.value)) as unknown,
      catch: (cause) =>
        new CliAccountEnvironmentError({
          message: `Stored T3 Connect credential state '${name}' is invalid.`,
          cause,
        }),
    });
    return yield* decode(parsed).pipe(
      Effect.mapError(
        (cause) =>
          new CliAccountEnvironmentError({
            message: `Stored T3 Connect credential state '${name}' is invalid.`,
            cause,
          }),
      ),
    );
  });

const writeJsonSecret = (
  secrets: ServerSecretStore.ServerSecretStoreShape,
  name: string,
  value: unknown,
) =>
  secrets.set(name, bytes(JSON.stringify(value))).pipe(
    Effect.mapError(
      (cause) =>
        new CliAccountEnvironmentError({
          message: `Could not persist T3 Connect credential state '${name}'.`,
          cause,
        }),
    ),
  );

const publicJwk = (privateJwk: DpopPrivateJwk): DpopPublicJwk => ({
  kty: privateJwk.kty,
  crv: privateJwk.crv,
  x: privateJwk.x,
  y: privateJwk.y,
});

export const makeCliDpopSigner = Effect.fn("cli.accountEnvironment.makeDpopSigner")(function* (
  secrets: ServerSecretStore.ServerSecretStoreShape,
) {
  const stored = yield* secrets.get(DPOP_KEY_SECRET);
  const privateJwk = Option.isSome(stored)
    ? yield* Effect.try({
        try: () => JSON.parse(text(stored.value)) as unknown,
        catch: (cause) =>
          new CliAccountEnvironmentError({
            message: "Stored CLI DPoP key is invalid.",
            cause,
          }),
      }).pipe(
        Effect.flatMap(decodeDpopPrivateJwk),
        Effect.mapError(
          (cause) =>
            new CliAccountEnvironmentError({
              message: "Stored CLI DPoP key is invalid.",
              cause,
            }),
        ),
      )
    : yield* Effect.gen(function* () {
        const { privateKey } = NodeCrypto.generateKeyPairSync("ec", {
          namedCurve: "P-256",
        });
        const generated = yield* decodeDpopPrivateJwk(privateKey.export({ format: "jwk" })).pipe(
          Effect.mapError(
            (cause) =>
              new CliAccountEnvironmentError({
                message: "Could not generate a CLI DPoP key.",
                cause,
              }),
          ),
        );
        yield* secrets.set(DPOP_KEY_SECRET, bytes(JSON.stringify(generated))).pipe(
          Effect.mapError(
            (cause) =>
              new CliAccountEnvironmentError({
                message: "Could not persist the CLI DPoP key.",
                cause,
              }),
          ),
        );
        return generated;
      });
  const publicKey = publicJwk(privateJwk);
  const thumbprint = computeDpopJwkThumbprint(publicKey);

  const createProof = (input: {
    readonly method: string;
    readonly url: string;
    readonly accessToken?: string;
  }) =>
    Effect.try({
      try: () => {
        const htu = normalizeDpopHtu(input.url);
        if (htu === null) throw new Error("Invalid DPoP target URL.");
        const header = Encoding.encodeBase64Url(
          bytes(JSON.stringify({ typ: "dpop+jwt", alg: "ES256", jwk: publicKey })),
        );
        const payload = Encoding.encodeBase64Url(
          bytes(
            JSON.stringify({
              htm: input.method.toUpperCase(),
              htu,
              jti: NodeCrypto.randomUUID(),
              iat: Math.floor(Date.now() / 1_000),
              ...(input.accessToken === undefined
                ? {}
                : { ath: computeDpopAccessTokenHash(input.accessToken) }),
            }),
          ),
        );
        const signingInput = `${header}.${payload}`;
        const signature = NodeCrypto.sign("sha256", bytes(signingInput), {
          key: NodeCrypto.createPrivateKey({ key: privateJwk, format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        });
        return `${signingInput}.${Encoding.encodeBase64Url(signature)}`;
      },
      catch: (cause) =>
        new CliAccountEnvironmentError({
          message: "Could not create a CLI DPoP proof.",
          cause,
        }),
    });

  return { thumbprint, createProof };
});

const jwtSubject = (token: string): string | null => {
  const payload = token.split(".")[1];
  if (!payload) return null;
  const decoded = Encoding.decodeBase64UrlString(payload);
  if (decoded._tag !== "Success") return null;
  try {
    const claims = JSON.parse(decoded.success) as { readonly sub?: unknown };
    return typeof claims.sub === "string" && claims.sub.length > 0 ? claims.sub : null;
  } catch {
    return null;
  }
};

const getAccountSession = Effect.fn("cli.accountEnvironment.getAccountSession")(function* (
  tokens: CliTokenManager.CloudCliTokenManager["Service"],
) {
  const token = yield* tokens.getExisting.pipe(
    Effect.mapError(
      (cause) =>
        new CliAccountEnvironmentError({
          message:
            "Could not refresh the T3 Connect sign-in. Run `t3 connect login` and try again.",
          cause,
        }),
    ),
  );
  if (Option.isNone(token)) {
    return yield* new CliAccountEnvironmentError({
      message: "T3 Connect is not signed in. Run `t3 connect login` and try again.",
    });
  }
  const accountId = token.value.accountId ?? jwtSubject(token.value.accessToken);
  if (accountId === null) {
    return yield* new CliAccountEnvironmentError({
      message:
        "The stored T3 Connect sign-in has no stable account identity. Run `t3 connect logout`, then `t3 connect login`.",
    });
  }
  return {
    accountId,
    ...(token.value.identity === undefined ? {} : { identity: token.value.identity }),
    accessToken: token.value.accessToken,
  } satisfies CliAccountSession;
});

const logRelayTokenStoreFailure = (operation: "load" | "save" | "clear", cause: unknown) =>
  Effect.logWarning("CLI relay token cache unavailable; continuing without cached credentials.", {
    operation,
    cause,
  });

const logEnvironmentTokenStoreFailure = (operation: "load" | "save", cause: unknown) =>
  Effect.logWarning(
    "CLI environment token cache unavailable; continuing without cached credentials.",
    {
      operation,
      cause,
    },
  );

export const makeRelayTokenStore = (
  secrets: ServerSecretStore.ServerSecretStoreShape,
): ManagedRelay.ManagedRelayAccessTokenStore => ({
  load: readJsonSecret(secrets, RELAY_TOKEN_CACHE_SECRET, decodeRelayTokenCache, []).pipe(
    Effect.tapError((cause) => logRelayTokenStoreFailure("load", cause)),
    Effect.orElseSucceed(() => []),
  ),
  save: (entries) =>
    writeJsonSecret(secrets, RELAY_TOKEN_CACHE_SECRET, entries).pipe(
      Effect.tapError((cause) => logRelayTokenStoreFailure("save", cause)),
      Effect.ignore,
    ),
  clear: secrets.remove(RELAY_TOKEN_CACHE_SECRET).pipe(
    Effect.tapError((cause) => logRelayTokenStoreFailure("clear", cause)),
    Effect.ignore,
  ),
});

export const makeEnvironmentTokenStore = (secrets: ServerSecretStore.ServerSecretStoreShape) => ({
  load: readJsonSecret(
    secrets,
    ENVIRONMENT_TOKEN_CACHE_SECRET,
    decodeUsableEnvironmentTokenCache,
    [],
  ).pipe(
    Effect.tapError((cause) => logEnvironmentTokenStoreFailure("load", cause)),
    Effect.orElseSucceed(() => []),
  ),
  save: (entries: ReadonlyArray<EnvironmentTokenCacheEntry>) =>
    writeJsonSecret(secrets, ENVIRONMENT_TOKEN_CACHE_SECRET, entries).pipe(
      Effect.tapError((cause) => logEnvironmentTokenStoreFailure("save", cause)),
      Effect.ignore,
    ),
});

const CLIENT_PRESENTATION: AuthClientPresentationMetadata = {
  label: "T3 CLI",
  deviceType: "desktop",
  os: process.platform,
};

const withAccountRuntime = <A, E, R>(
  baseDir: string,
  run: (input: {
    readonly session: CliAccountSession;
    readonly secrets: ServerSecretStore.ServerSecretStoreShape;
    readonly tokens: CliTokenManager.CloudCliTokenManager["Service"];
    readonly relay: ManagedRelay.ManagedRelayClient["Service"];
    readonly relayUrl: string;
    readonly signer: CliDpopSigner;
  }) => Effect.Effect<A, E, R>,
  sharedTokens?: CliTokenManager.CloudCliTokenManager["Service"],
) =>
  Effect.gen(function* () {
    const config = yield* resolveCliAuthConfig({ baseDir: Option.some(baseDir) }, Option.none());
    const baseLayer = Layer.mergeAll(
      ServerSecretStore.layer,
      sharedTokens
        ? Layer.succeed(CliTokenManager.CloudCliTokenManager, sharedTokens)
        : CliTokenManager.layer.pipe(Layer.provide(ServerSecretStore.layer)),
    ).pipe(
      Layer.provideMerge(FetchHttpClient.layer),
      Layer.provideMerge(Layer.succeed(ServerConfig, config)),
    );

    return yield* Effect.gen(function* () {
      const secrets = yield* ServerSecretStore.ServerSecretStore;
      const tokens = yield* CliTokenManager.CloudCliTokenManager;
      const session = yield* getAccountSession(tokens);
      const signer = yield* makeCliDpopSigner(secrets);
      const relayUrl = yield* relayUrlConfig;
      const signerLayer = Layer.succeed(
        ManagedRelay.ManagedRelayDpopSigner,
        ManagedRelay.ManagedRelayDpopSigner.of({
          thumbprint: Effect.succeed(signer.thumbprint),
          createProof: (input) =>
            signer.createProof(input).pipe(
              Effect.mapError(
                (cause) =>
                  new ManagedRelay.ManagedRelayDpopProofCreationError({
                    method: input.method,
                    url: input.url,
                    cause,
                  }),
              ),
            ),
        }),
      );
      const relayLayer = ManagedRelay.layer({
        relayUrl,
        clientId: RelayWebClientId,
        accessTokenStore: makeRelayTokenStore(secrets),
      }).pipe(Layer.provide(signerLayer), Layer.provide(FetchHttpClient.layer));
      return yield* Effect.gen(function* () {
        const relay = yield* ManagedRelay.ManagedRelayClient;
        return yield* run({ session, secrets, tokens, relay, relayUrl, signer });
      }).pipe(Effect.provide(relayLayer));
    }).pipe(Effect.provide(baseLayer));
  }).pipe(
    Effect.mapError((cause) =>
      isCliAccountEnvironmentError(cause)
        ? cause
        : new CliAccountEnvironmentError({
            message: "Could not use the T3 Connect account environment.",
            cause,
          }),
    ),
  );

export const discoverAccountEnvironments = (
  baseDir: string,
  sharedTokens?: CliTokenManager.CloudCliTokenManager["Service"],
) =>
  withAccountRuntime(
    baseDir,
    ({ session, relay }) =>
      relay
        .listEnvironments({ clerkToken: session.accessToken })
        .pipe(Effect.map((environments) => ({ session, environments }))),
    sharedTokens,
  );

export const deregisterAccountEnvironment = (
  baseDir: string,
  selection: { readonly accountId: string; readonly environmentId: EnvironmentId },
) =>
  withAccountRuntime(baseDir, ({ session, tokens, relay }) =>
    Effect.gen(function* () {
      if (session.accountId !== selection.accountId) {
        return yield* new CliAccountEnvironmentError({
          message:
            "The T3 Connect account changed. List environments and confirm deregistration again.",
        });
      }
      yield* assertSameAccount(tokens, selection.accountId);
      yield* relay.unlinkEnvironment({
        clerkToken: session.accessToken,
        environmentId: selection.environmentId,
      });
    }),
  );

export const discoverCliEnvironmentCandidates = (
  baseDir: string,
  registry: CliEnvironmentRegistry,
) =>
  discoverAccountEnvironments(baseDir).pipe(
    Effect.map((discovery) => ({
      ...discovery,
      candidates: [
        ...manualEnvironmentCandidates(registry),
        ...accountEnvironmentCandidates(discovery.session.accountId, discovery.environments),
      ] satisfies ReadonlyArray<CliEnvironmentCandidate>,
    })),
  );

export const resolveCliEnvironmentCandidate = (
  baseDir: string,
  registry: CliEnvironmentRegistry,
  selector: string,
) =>
  Effect.gen(function* () {
    const manualCandidates = manualEnvironmentCandidates(registry);
    if (selector.startsWith("manual:")) {
      return yield* resolveCandidateEffect(selector, manualCandidates);
    }
    const accountDiscovery = yield* discoverCliEnvironmentCandidates(baseDir, registry);
    return yield* resolveCandidateEffect(selector, accountDiscovery.candidates);
  });

const assertSameAccount = Effect.fn("cli.accountEnvironment.assertSameAccount")(function* (
  tokens: CliTokenManager.CloudCliTokenManager["Service"],
  expectedAccountId: string,
) {
  const current = yield* getAccountSession(tokens);
  if (current.accountId !== expectedAccountId) {
    return yield* new CliAccountEnvironmentError({
      message:
        "The T3 Connect account changed while authorizing the environment. Select the environment again.",
    });
  }
  return current;
});

const prepareAccountEnvironment = (
  baseDir: string,
  selection: {
    readonly accountId: string;
    readonly environmentId: string;
  },
  sharedTokens?: CliTokenManager.CloudCliTokenManager["Service"],
) =>
  withAccountRuntime(
    baseDir,
    ({ session, secrets, tokens, relay, relayUrl, signer }) =>
      Effect.gen(function* () {
        if (session.accountId !== selection.accountId) {
          return yield* new CliAccountEnvironmentError({
            message:
              `Selected environment belongs to a different T3 Connect account. ` +
              "Run `t3 env list`, then select an environment from the current account.",
          });
        }
        const environmentId = EnvironmentId.make(selection.environmentId);
        const tokenLock = yield* Semaphore.make(1);
        const tokenStore = makeEnvironmentTokenStore(secrets);

        const mintToken = Effect.fn("cli.accountEnvironment.mintToken")(function* () {
          const current = yield* assertSameAccount(tokens, session.accountId);
          const connected = yield* relay.connectEnvironment({
            clerkToken: current.accessToken,
            scopes: [RelayEnvironmentConnectScope],
            environmentId,
          });
          if (connected.environmentId !== environmentId) {
            return yield* new CliAccountEnvironmentError({
              message: `Relay returned environment '${connected.environmentId}' while '${environmentId}' was selected.`,
            });
          }
          const descriptor = yield* fetchRemoteEnvironmentDescriptor({
            httpBaseUrl: connected.endpoint.httpBaseUrl,
          });
          if (descriptor.environmentId !== environmentId) {
            return yield* new CliAccountEnvironmentError({
              message: `Connected endpoint belongs to environment '${descriptor.environmentId}', not '${environmentId}'.`,
            });
          }
          const proof = yield* signer.createProof({
            method: "POST",
            url: environmentEndpointUrl(connected.endpoint.httpBaseUrl, "/oauth/token"),
          });
          const exchanged = yield* exchangeRemoteDpopAccessToken({
            httpBaseUrl: connected.endpoint.httpBaseUrl,
            credential: connected.credential,
            scopes: AuthStandardClientScopes,
            clientMetadata: CLIENT_PRESENTATION,
            dpopProof: proof,
          });
          yield* assertSameAccount(tokens, session.accountId);
          const now = Date.now();
          const minted: EnvironmentTokenCacheEntry = {
            accountId: session.accountId,
            environmentId,
            relayUrl,
            label: descriptor.label,
            endpoint: connected.endpoint,
            accessToken: exchanged.access_token,
            expiresAtEpochMs: now + exchanged.expires_in * 1_000,
            dpopThumbprint: signer.thumbprint,
            clientId: RelayWebClientId,
            authorizationScope: [...AuthStandardClientScopes].sort().join(" "),
          };
          const stored = yield* tokenStore.load;
          yield* tokenStore.save([
            ...stored.filter(
              (entry) =>
                entry.environmentId !== environmentId || entry.accountId !== session.accountId,
            ),
            minted,
          ]);
          return minted;
        });

        const getToken = (rejectedAccessToken?: string) =>
          tokenLock
            .withPermits(1)(
              Effect.gen(function* () {
                yield* assertSameAccount(tokens, session.accountId);
                const now = Date.now();
                const stored = yield* tokenStore.load;
                const cached = findReusableEnvironmentToken(stored, {
                  accountId: session.accountId,
                  environmentId,
                  relayUrl,
                  dpopThumbprint: signer.thumbprint,
                  nowEpochMs: now,
                  ...(rejectedAccessToken === undefined ? {} : { rejectedAccessToken }),
                });
                if (cached !== undefined) {
                  return cached;
                }
                return yield* mintToken();
              }),
            )
            .pipe(
              Effect.provide(FetchHttpClient.layer),
              Effect.mapError((cause) =>
                isCliAccountEnvironmentError(cause)
                  ? cause
                  : new CliAccountEnvironmentError({
                      message: `Could not authorize account environment '${environmentId}'.`,
                      cause,
                    }),
              ),
            );

        const socketUrl = (token: EnvironmentTokenCacheEntry) =>
          Effect.gen(function* () {
            const descriptor = yield* fetchRemoteEnvironmentDescriptor({
              httpBaseUrl: token.endpoint.httpBaseUrl,
            });
            if (descriptor.environmentId !== environmentId)
              return yield* new CliAccountEnvironmentError({
                message:
                  "The endpoint now belongs to a different environment. Refusing to send its credential.",
              });
            yield* assertSameAccount(tokens, session.accountId);
            const proof = yield* signer.createProof({
              method: "POST",
              url: environmentEndpointUrl(token.endpoint.httpBaseUrl, "/api/auth/websocket-ticket"),
              accessToken: token.accessToken,
            });
            return yield* resolveRemoteDpopWebSocketConnectionUrl({
              wsBaseUrl: token.endpoint.wsBaseUrl,
              httpBaseUrl: token.endpoint.httpBaseUrl,
              accessToken: token.accessToken,
              dpopProof: proof,
            });
          }).pipe(
            Effect.provide(FetchHttpClient.layer),
            Effect.mapError((cause) =>
              isCliAccountEnvironmentError(cause)
                ? cause
                : new CliAccountEnvironmentError({
                    message: `Could not issue a WebSocket ticket for '${environmentId}'.`,
                    cause,
                  }),
            ),
          );

        const token = yield* getToken();
        const nextSocketUrl = Effect.gen(function* () {
          let current = yield* getToken();
          let ticket = yield* socketUrl(current).pipe(Effect.result);
          if (ticket._tag === "Failure") {
            current = yield* getToken(current.accessToken);
            ticket = yield* socketUrl(current).pipe(Effect.result);
          }
          if (ticket._tag === "Failure") return yield* ticket.failure;
          yield* assertSameAccount(tokens, session.accountId);
          return ticket.success;
        });

        const request = (path: string, input: Request) =>
          Effect.gen(function* () {
            if (!path.startsWith("/") || path.startsWith("//")) {
              return yield* new CliAccountEnvironmentError({
                message: "Invalid environment path.",
              });
            }
            const body =
              input.body === null ? undefined : yield* Effect.tryPromise(() => input.arrayBuffer());
            const send = (current: EnvironmentTokenCacheEntry) =>
              Effect.gen(function* () {
                const url = new URL(path, current.endpoint.httpBaseUrl);
                if (url.origin !== new URL(current.endpoint.httpBaseUrl).origin) {
                  return yield* new CliAccountEnvironmentError({
                    message: "Invalid environment origin.",
                  });
                }
                const descriptor = yield* fetchRemoteEnvironmentDescriptor({
                  httpBaseUrl: current.endpoint.httpBaseUrl,
                }).pipe(Effect.provide(FetchHttpClient.layer));
                if (descriptor.environmentId !== environmentId) {
                  return yield* new CliAccountEnvironmentError({
                    message:
                      "The endpoint belongs to a different environment. Refusing to send its credential.",
                  });
                }
                yield* assertSameAccount(tokens, session.accountId);
                const proof = yield* signer.createProof({
                  method: input.method,
                  url: url.toString(),
                  accessToken: current.accessToken,
                });
                const headers = new Headers();
                for (const name of [
                  "accept",
                  "content-type",
                  "range",
                  "if-match",
                  "if-none-match",
                ]) {
                  const value = input.headers.get(name);
                  if (value !== null) headers.set(name, value);
                }
                headers.set("authorization", `DPoP ${current.accessToken}`);
                headers.set("dpop", proof);
                return yield* Effect.tryPromise(async () => {
                  const timeout = new AbortController();
                  const timer = setTimeout(() => timeout.abort(), 15_000);
                  try {
                    return await fetch(url, {
                      method: input.method,
                      headers,
                      ...(body === undefined ? {} : { body }),
                      signal: AbortSignal.any([input.signal, timeout.signal]),
                      redirect: "manual",
                    });
                  } finally {
                    clearTimeout(timer);
                  }
                });
              });
            let current = yield* getToken();
            let response = yield* send(current);
            const sessionRejected =
              path.split("?")[0] === "/api/auth/session" && response.ok
                ? yield* Effect.tryPromise(async () => {
                    const state: unknown = await response.clone().json();
                    return (
                      typeof state === "object" &&
                      state !== null &&
                      "authenticated" in state &&
                      state.authenticated === false
                    );
                  })
                : false;
            if (response.status === 401 || sessionRejected) {
              yield* Effect.tryPromise(() => response.body?.cancel() ?? Promise.resolve());
              current = yield* getToken(current.accessToken);
              response = yield* send(current);
            }
            yield* assertSameAccount(tokens, session.accountId);
            if (response.status >= 300 && response.status < 400 && response.status !== 304) {
              yield* Effect.tryPromise(() => response.body?.cancel() ?? Promise.resolve());
              return yield* new CliAccountEnvironmentError({
                message: "Environment redirects are not allowed for authenticated requests.",
              });
            }
            return response;
          }).pipe(
            Effect.mapError((cause) =>
              isCliAccountEnvironmentError(cause)
                ? cause
                : new CliAccountEnvironmentError({ message: "Environment request failed.", cause }),
            ),
          );

        return {
          source: "account",
          accountId: session.accountId,
          environmentId,
          label: token.label,
          origin: token.endpoint.httpBaseUrl.replace(/\/$/, ""),
          nextSocketUrl,
          request,
        } satisfies CliAccountEnvironmentTarget;
      }).pipe(Effect.provide(FetchHttpClient.layer)),
    sharedTokens,
  );

export const withAccountEnvironment = <A, E, R>(
  baseDir: string,
  selection: {
    readonly accountId: string;
    readonly environmentId: string;
  },
  run: (target: CliAccountEnvironmentTarget) => Effect.Effect<A, E, R>,
  sharedTokens?: CliTokenManager.CloudCliTokenManager["Service"],
) => prepareAccountEnvironment(baseDir, selection, sharedTokens).pipe(Effect.flatMap(run));

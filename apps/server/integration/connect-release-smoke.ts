import * as NodeCrypto from "node:crypto";
import * as NodeHttp from "node:http";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { EnvironmentId, type ExecutionEnvironmentDescriptor } from "@t3tools/contracts";
import {
  RelayEnvironmentConnectScope,
  RelayEnvironmentStatusScope,
  type RelayEnvironmentLinkResponse,
  RelayWebClientId,
} from "@t3tools/contracts/relay";
import * as ClientCapabilities from "../../../packages/client-runtime/src/platform/capabilities.ts";
import * as Connectivity from "../../../packages/client-runtime/src/connection/connectivity.ts";
import * as ConnectionWakeups from "../../../packages/client-runtime/src/connection/wakeups.ts";
import * as ManagedRelay from "../../../packages/client-runtime/src/relay/managedRelay.ts";
import * as RelayEnvironmentDiscovery from "../../../packages/client-runtime/src/relay/discovery.ts";
import { remoteHttpClientLayer } from "../../../packages/client-runtime/src/rpc/http.ts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import * as FetchHttpClient from "effect/unstable/http/FetchHttpClient";
import * as Headers from "effect/unstable/http/Headers";
import * as HttpClient from "effect/unstable/http/HttpClient";

import * as EnvironmentAuth from "../src/auth/EnvironmentAuth.ts";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import { fetchLiveOrchestrationShellSnapshot } from "../src/cli/client.ts";
import * as CliState from "../src/cloud/CliState.ts";
import * as CliTokenManager from "../src/cloud/CliTokenManager.ts";
import {
  CLOUD_LINKED_USER_ID,
  CLOUD_MINT_PUBLIC_KEY,
  RELAY_ENVIRONMENT_CREDENTIAL_SECRET,
  RELAY_ISSUER_SECRET,
  RELAY_URL_SECRET,
} from "../src/cloud/config.ts";
import { reconcileDesiredCloudLink } from "../src/cloud/http.ts";
import * as ManagedEndpointRuntime from "../src/cloud/ManagedEndpointRuntime.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";

const RELAY_ORIGIN = "https://release-smoke-relay.invalid";
const environmentId = EnvironmentId.make("release-smoke-environment");
const descriptor = {
  environmentId,
  label: "Release smoke environment",
  platform: {
    os: "darwin",
    arch: "arm64",
  },
  serverVersion: "0.0.0-release-smoke",
  capabilities: {
    repositoryIdentity: false,
  },
} satisfies ExecutionEnvironmentDescriptor;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function memorySecretStore() {
  const values = new Map<string, Uint8Array>();
  return {
    values,
    service: ServerSecretStore.ServerSecretStore.of({
      get: (name) =>
        Effect.sync(() => {
          const value = values.get(name);
          return value === undefined ? Option.none() : Option.some(value);
        }),
      set: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      create: (name, value) =>
        Effect.sync(() => {
          values.set(name, value);
        }),
      getOrCreateRandom: (name, bytes) =>
        Effect.sync(() => {
          const existing = values.get(name);
          if (existing !== undefined) return existing;
          const value = NodeCrypto.randomBytes(bytes);
          values.set(name, value);
          return value;
        }),
      remove: (name) =>
        Effect.sync(() => {
          values.delete(name);
        }),
      list: () => Effect.succeed([...values.keys()]),
    }),
  };
}

function readSecret(values: ReadonlyMap<string, Uint8Array>, name: string): string {
  const value = values.get(name);
  assert(value !== undefined, `Expected ${name} to be persisted.`);
  return new TextDecoder().decode(value);
}

function writeJson(response: NodeHttp.ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}

function readBearerToken(request: NodeHttp.IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("Bearer ") ? authorization.slice("Bearer ".length) : null;
}

function readDpopToken(request: NodeHttp.IncomingMessage): string | null {
  const authorization = request.headers.authorization;
  return authorization?.startsWith("DPoP ") ? authorization.slice("DPoP ".length) : null;
}

async function readRequestBody(request: NodeHttp.IncomingMessage): Promise<string> {
  request.setEncoding("utf8");
  let body = "";
  for await (const chunk of request) {
    body += chunk;
  }
  return body;
}

async function readJsonRequest(request: NodeHttp.IncomingMessage): Promise<unknown> {
  return JSON.parse(await readRequestBody(request));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

interface FakeRelayState {
  link: RelayEnvironmentLinkResponse | null;
  connectCredential: string | null;
  readonly dpopTokens: Set<string>;
}

async function startFakeEnvironmentServer(state: FakeRelayState) {
  const server = NodeHttp.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/api/orchestration/shell-snapshot") {
      if (
        state.connectCredential === null ||
        readBearerToken(request) !== state.connectCredential
      ) {
        response.writeHead(401);
        response.end();
        return;
      }
      writeJson(response, 200, {
        snapshotSequence: 1,
        projects: [],
        threads: [],
        updatedAt: "2026-07-30T00:00:00.000Z",
      });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake environment server did not bind a TCP port.");
  }
  return {
    endpoint: {
      httpBaseUrl: `http://127.0.0.1:${address.port}`,
      wsBaseUrl: `ws://127.0.0.1:${address.port}`,
      providerKind: "cloudflare_tunnel" as const,
    },
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

function linkedEnvironment(state: FakeRelayState): RelayEnvironmentLinkResponse {
  assert(state.link !== null, "Relay received an environment request before linking.");
  return state.link;
}

async function handleFakeRelayRequest(
  request: NodeHttp.IncomingMessage,
  response: NodeHttp.ServerResponse,
  state: FakeRelayState,
  endpoint: RelayEnvironmentLinkResponse["endpoint"],
): Promise<void> {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  if (request.method === "POST" && url.pathname === "/v1/client/environment-link-challenges") {
    assert(
      readBearerToken(request) === "release-smoke-cli-access",
      "Relay link challenge was not authenticated with the CLI access token.",
    );
    writeJson(response, 200, {
      challenge: "release-smoke-link-challenge",
      expiresAt: "2026-07-30T01:00:00.000Z",
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/client/environment-links") {
    assert(
      readBearerToken(request) === "release-smoke-cli-access",
      "Relay environment link was not authenticated with the CLI access token.",
    );
    const payload = await readJsonRequest(request);
    assert(
      isRecord(payload) && typeof payload.proof === "string" && payload.proof.length > 0,
      "Relay environment link did not include its signed proof.",
    );
    const link = {
      ok: true,
      cloudUserId: "release-smoke-user",
      environmentId,
      endpoint,
      endpointRuntime: null,
      relayIssuer: RELAY_ORIGIN,
      environmentCredential: "release-smoke-environment-credential",
      cloudMintPublicKey: NodeCrypto.generateKeyPairSync("ed25519")
        .publicKey.export({ type: "spki", format: "pem" })
        .toString()
        .trim(),
    } satisfies RelayEnvironmentLinkResponse;
    state.link = link;
    writeJson(response, 200, link);
    return;
  }

  if (request.method === "GET" && url.pathname === "/v1/environments") {
    assert(
      readBearerToken(request) === "release-smoke-clerk-token",
      "Relay environment listing was not authenticated with the cloud session.",
    );
    const link = linkedEnvironment(state);
    writeJson(response, 200, {
      environments: [
        {
          environmentId: link.environmentId,
          label: descriptor.label,
          endpoint: link.endpoint,
          linkedAt: "2026-07-30T00:00:00.000Z",
        },
      ],
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/v1/client/dpop-token") {
    assert(request.headers.dpop, "Relay DPoP token exchange did not include a proof.");
    const payload = new URLSearchParams(await readRequestBody(request));
    assert(
      payload.get("subject_token") === "release-smoke-clerk-token",
      "Relay DPoP token exchange used an unexpected cloud session.",
    );
    const scope = payload.get("scope");
    assert(scope !== null && scope.length > 0, "Relay DPoP token exchange did not request scopes.");
    const token = `release-smoke-dpop-${state.dpopTokens.size + 1}`;
    state.dpopTokens.add(token);
    writeJson(response, 200, {
      access_token: token,
      issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
      token_type: "DPoP",
      expires_in: 3600,
      scope,
    });
    return;
  }

  const environmentRequest = /^\/v1\/environments\/([^/]+)\/(status|connect)$/u.exec(url.pathname);
  if (request.method === "POST" && environmentRequest) {
    const [, requestedEnvironmentId, action] = environmentRequest;
    const token = readDpopToken(request);
    assert(
      token !== null && state.dpopTokens.has(token) && request.headers.dpop,
      `Relay environment ${action} request was not DPoP authenticated.`,
    );
    const link = linkedEnvironment(state);
    assert(
      requestedEnvironmentId === link.environmentId,
      "Relay received a request for an environment other than the linked environment.",
    );
    if (action === "status") {
      writeJson(response, 200, {
        environmentId: link.environmentId,
        endpoint: link.endpoint,
        status: "online",
        checkedAt: "2026-07-30T00:00:00.000Z",
        descriptor,
      });
      return;
    }
    state.connectCredential ??= "release-smoke-connect-credential";
    writeJson(response, 200, {
      environmentId: link.environmentId,
      endpoint: link.endpoint,
      credential: state.connectCredential,
      expiresAt: "2026-07-30T01:00:00.000Z",
    });
    return;
  }

  response.writeHead(404);
  response.end();
}

async function startFakeRelayServer(
  endpoint: RelayEnvironmentLinkResponse["endpoint"],
  state: FakeRelayState,
) {
  const server = NodeHttp.createServer((request, response) => {
    void handleFakeRelayRequest(request, response, state, endpoint).catch((error: unknown) => {
      writeJson(response, 500, { error: String(error) });
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Fake relay server did not bind a TCP port.");
  }
  const localOrigin = `http://127.0.0.1:${address.port}`;
  const fetch = Object.assign(
    (input: string | URL | Request, init?: RequestInit) => {
      const request =
        input instanceof Request ? new Request(input, init) : new Request(input.toString(), init);
      const url = new URL(request.url);
      if (url.origin === RELAY_ORIGIN) {
        const localUrl = new URL(`${url.pathname}${url.search}`, localOrigin);
        return globalThis.fetch(new Request(localUrl.toString(), request));
      }
      if (url.origin === "https://clerk.invalid" && url.pathname === "/oauth/token") {
        return Promise.resolve(
          Response.json({
            access_token: "release-smoke-cli-access",
            refresh_token: "release-smoke-cli-refresh",
            expires_in: 3600,
            token_type: "Bearer",
          }),
        );
      }
      return Promise.reject(new Error(`Unexpected release smoke HTTP request: ${request.url}`));
    },
    { preconnect: globalThis.fetch.preconnect },
  ) satisfies typeof globalThis.fetch;
  return {
    fetch,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      }),
  };
}

const fakeEndpointRuntime = ManagedEndpointRuntime.CloudManagedEndpointRuntime.of({
  applyConfig: () => Effect.succeed({ status: "disabled" as const }),
  getStatus: Effect.succeed({ status: "disabled" as const }),
});

const fakeEnvironmentAuth = EnvironmentAuth.EnvironmentAuth.of({
  issueSession: () => Effect.die("unused"),
  revokeSession: () => Effect.die("unused"),
  createPairingLink: () => Effect.die("unused"),
});

async function main() {
  const relayState: FakeRelayState = {
    link: null,
    connectCredential: null,
    dpopTokens: new Set(),
  };
  const fakeEnvironment = await startFakeEnvironmentServer(relayState);
  const fakeRelay = await startFakeRelayServer(fakeEnvironment.endpoint, relayState);
  try {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const secrets = memorySecretStore();
          const callbackState = "release-smoke-callback-state";
          const relayHttpClientLayer: Layer.Layer<HttpClient.HttpClient> = remoteHttpClientLayer(
            fakeRelay.fetch,
          ).pipe(Layer.provide(Layer.succeed(Headers.CurrentRedactedNames, [])));
          const tokens = yield* CliTokenManager.make.pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.service),
              ),
            ),
          );

          yield* CliTokenManager.withLoopbackAuthorizationCallback(
            {
              redirectUri: "http://127.0.0.1:34338/callback",
              state: callbackState,
            },
            ({ awaitCode }) =>
              Effect.gen(function* () {
                const callback = yield* Effect.promise(() =>
                  fetch(
                    `http://127.0.0.1:34338/callback?code=release-smoke-code&state=${callbackState}`,
                  ),
                );
                assert(callback.status === 200, "Loopback authorization callback was rejected.");
                const exchanged = yield* CliTokenManager.exchangeOAuthToken(
                  {
                    authorizationEndpoint: "https://clerk.invalid/oauth/authorize",
                    tokenEndpoint: "https://clerk.invalid/oauth/token",
                    clientId: "release-smoke-client",
                    redirectUri: "http://127.0.0.1:34338/callback",
                    scopes: ["openid", "profile", "email"],
                  },
                  {
                    grant_type: "authorization_code",
                    code: yield* awaitCode,
                    redirect_uri: "http://127.0.0.1:34338/callback",
                    client_id: "release-smoke-client",
                    code_verifier: "release-smoke-verifier",
                  },
                );
                yield* tokens.store(exchanged.token);
              }),
          ).pipe(Effect.provide(relayHttpClientLayer));

          const persisted = yield* tokens.getExisting;
          const cliToken = Option.getOrThrow(persisted);
          assert(
            cliToken.refreshToken === "release-smoke-cli-refresh",
            "Loopback refresh credential was not persisted.",
          );

          yield* CliState.setCliDesiredCloudLink(true).pipe(
            Effect.provideService(ServerSecretStore.ServerSecretStore, secrets.service),
          );
          assert(
            yield* CliState.readCliDesiredCloudLink.pipe(
              Effect.provideService(ServerSecretStore.ServerSecretStore, secrets.service),
            ),
            "Desired link state was not persisted.",
          );

          yield* reconcileDesiredCloudLink(fakeEnvironment.endpoint.httpBaseUrl).pipe(
            Effect.provide(
              Layer.mergeAll(
                NodeServices.layer,
                Layer.succeed(ServerSecretStore.ServerSecretStore, secrets.service),
                Layer.succeed(
                  ServerEnvironment.ServerEnvironment,
                  ServerEnvironment.ServerEnvironment.of({
                    getEnvironmentId: Effect.succeed(environmentId),
                    getDescriptor: Effect.succeed(descriptor),
                  }),
                ),
                Layer.succeed(
                  ManagedEndpointRuntime.CloudManagedEndpointRuntime,
                  fakeEndpointRuntime,
                ),
                Layer.succeed(EnvironmentAuth.EnvironmentAuth, fakeEnvironmentAuth),
                Layer.succeed(CliTokenManager.CloudCliTokenManager, tokens),
                relayHttpClientLayer,
                ConfigProvider.layer(
                  ConfigProvider.fromEnv({
                    env: { T3CODE_RELAY_URL: RELAY_ORIGIN },
                  }),
                ),
              ),
            ),
          ) as Effect.Effect<unknown, unknown, never>;

          const link = linkedEnvironment(relayState);
          assert(
            readSecret(secrets.values, RELAY_URL_SECRET) === RELAY_ORIGIN,
            "Reconciliation did not persist the relay URL from the link response.",
          );
          assert(
            readSecret(secrets.values, RELAY_ISSUER_SECRET) === link.relayIssuer,
            "Reconciliation did not persist the relay issuer from the link response.",
          );
          assert(
            readSecret(secrets.values, CLOUD_LINKED_USER_ID) === link.cloudUserId,
            "Reconciliation did not persist the linked cloud user from the link response.",
          );
          assert(
            readSecret(secrets.values, RELAY_ENVIRONMENT_CREDENTIAL_SECRET) ===
              link.environmentCredential,
            "Reconciliation did not persist the environment credential from the link response.",
          );
          assert(
            readSecret(secrets.values, CLOUD_MINT_PUBLIC_KEY) === link.cloudMintPublicKey,
            "Reconciliation did not persist the mint key from the link response.",
          );

          const managedRelayLayer: Layer.Layer<ManagedRelay.ManagedRelayClient> =
            ManagedRelay.layer({
              relayUrl: readSecret(secrets.values, RELAY_URL_SECRET),
              clientId: RelayWebClientId,
            }).pipe(
              Layer.provide(
                Layer.succeed(
                  ManagedRelay.ManagedRelayDpopSigner,
                  ManagedRelay.ManagedRelayDpopSigner.of({
                    thumbprint: Effect.succeed("release-smoke-dpop-thumbprint"),
                    createProof: (input) =>
                      Effect.succeed(
                        [input.method, input.url, input.accessToken ?? "token-exchange"].join(":"),
                      ),
                  }),
                ),
              ),
              Layer.provide(relayHttpClientLayer),
            );
          const relay = Context.get(
            yield* Layer.build(managedRelayLayer),
            ManagedRelay.ManagedRelayClient,
          );
          const network = yield* SubscriptionRef.make<"online">("online");
          const discoveryLayer = RelayEnvironmentDiscovery.layer.pipe(
            Layer.provide(
              Layer.mergeAll(
                Layer.succeed(ManagedRelay.ManagedRelayClient, relay),
                Layer.succeed(ClientCapabilities.CloudSession, {
                  clerkToken: Effect.succeed("release-smoke-clerk-token"),
                }),
                Layer.succeed(Connectivity.Connectivity, {
                  status: SubscriptionRef.get(network),
                  changes: SubscriptionRef.changes(network),
                }),
                Layer.succeed(
                  ConnectionWakeups.ConnectionWakeups,
                  ConnectionWakeups.ConnectionWakeups.of({ changes: Stream.never }),
                ),
              ),
            ),
          );
          const discovery = yield* RelayEnvironmentDiscovery.RelayEnvironmentDiscovery.pipe(
            Effect.provide(discoveryLayer),
          );
          yield* discovery.refresh;
          const discovered = (yield* SubscriptionRef.get(discovery.state)).environments.get(
            link.environmentId,
          );
          assert(
            discovered?.availability === "online",
            "Relay discovery did not consume the linked environment endpoint.",
          );

          const connected = yield* relay.connectEnvironment({
            clerkToken: "release-smoke-clerk-token",
            scopes: [RelayEnvironmentConnectScope, RelayEnvironmentStatusScope],
            environmentId: discovered.environment.environmentId,
          });
          assert(
            connected.endpoint.httpBaseUrl === discovered.environment.endpoint.httpBaseUrl,
            "Relay connect returned an endpoint other than the discovered environment.",
          );
          assert(
            connected.credential === relayState.connectCredential,
            "Relay connect did not return the credential stored by the fake relay.",
          );
          const snapshot = yield* fetchLiveOrchestrationShellSnapshot(
            connected.endpoint.httpBaseUrl,
            connected.credential,
          ).pipe(Effect.provide(FetchHttpClient.layer));
          assert(snapshot.snapshotSequence === 1, "Authenticated shell snapshot was not returned.");
        }),
      ),
    );
    console.log("Composed T3 Connect release smoke passed.");
  } finally {
    await fakeRelay.close();
    await fakeEnvironment.close();
  }
}

await main();

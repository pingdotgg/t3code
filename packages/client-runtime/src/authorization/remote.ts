import {
  AuthAccessTokenType,
  type AuthClientPresentationMetadata,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  type ClientConnectionMethod,
  type AuthEnvironmentScope,
  type AuthWebSocketTicketResult,
  type AuthWebSocketTicketUse,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import { hashTelemetryId } from "@t3tools/shared/telemetryId";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ClientCapabilities from "../platform/capabilities.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiGroupClient,
  RemoteEnvironmentAuthUndeclaredStatusError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

export { RemoteEnvironmentAuthUndeclaredStatusError } from "../rpc/http.ts";
export type RemoteEnvironmentAuthError = RemoteEnvironmentRequestError;

const DEFAULT_REMOTE_REQUEST_TIMEOUT_MS = 10_000;

const clientMetadataTokenExchangeFields = (
  clientMetadata: AuthClientPresentationMetadata | undefined,
) => {
  const displayOs = clientMetadata?.os;
  return {
    ...(clientMetadata?.label ? { client_label: clientMetadata.label } : {}),
    ...(clientMetadata?.deviceType ? { client_device_type: clientMetadata.deviceType } : {}),
    ...(displayOs && displayOs !== "unknown" && displayOs !== "other"
      ? { client_os: displayOs }
      : {}),
  };
};

/** Hashes of who is connecting. Only hashes leave the client. */
export interface ClientOwnerParams {
  readonly connect?: string;
  readonly device?: string;
}

/**
 * Tells the environment, for analytics, which T3 Connect account and device
 * are connecting, so it can count the environment as theirs.
 */
export const readClientOwnerParams = Effect.gen(function* () {
  const session = yield* Effect.serviceOption(ClientCapabilities.CloudSession);
  const account = Option.isSome(session) ? yield* session.value.identity : Option.none();
  const device = yield* (yield* ClientCapabilities.AnalyticsDevice).id;
  return {
    ...(Option.isSome(account) ? { connect: hashTelemetryId(account.value.accountId) } : {}),
    ...(Option.isSome(device) ? { device: hashTelemetryId(device.value) } : {}),
  } satisfies ClientOwnerParams;
});

export const appendClientConnectionParams = (
  url: URL,
  clientMetadata: AuthClientPresentationMetadata | undefined,
  connectionMethod?: ClientConnectionMethod,
  owners?: ClientOwnerParams,
): void => {
  if (clientMetadata?.surface) {
    url.searchParams.set("clientSurface", clientMetadata.surface);
  }
  if (clientMetadata?.appVersion) {
    url.searchParams.set("clientAppVersion", clientMetadata.appVersion);
  }
  if (clientMetadata?.deviceType) {
    const deviceType =
      clientMetadata.deviceType === "mobile"
        ? "phone"
        : clientMetadata.deviceType === "desktop" || clientMetadata.deviceType === "tablet"
          ? clientMetadata.deviceType
          : "unknown";
    url.searchParams.set("clientDeviceType", deviceType);
  }
  if (clientMetadata?.os) {
    url.searchParams.set("clientOs", clientMetadata.os);
  }
  if (clientMetadata?.surface === "web") {
    if (clientMetadata.webDeployment) {
      url.searchParams.set("clientWebDeployment", clientMetadata.webDeployment);
    }
    if (clientMetadata.browser) {
      url.searchParams.set("clientBrowser", clientMetadata.browser);
    }
  }
  if (clientMetadata?.surface === "mobile") {
    if (clientMetadata.osMajorVersion !== undefined) {
      url.searchParams.set("clientOsMajorVersion", String(clientMetadata.osMajorVersion));
    }
    if (clientMetadata.deviceModel) {
      url.searchParams.set("clientDeviceModel", clientMetadata.deviceModel);
    }
  }
  if (connectionMethod) {
    url.searchParams.set("connectionMethod", connectionMethod);
  }
  if (owners?.connect) {
    url.searchParams.set("clientOwner", owners.connect);
  }
  if (owners?.device) {
    url.searchParams.set("clientDevice", owners.device);
  }
};

export const exchangeRemoteDpopAccessToken = Effect.fn(
  "clientRuntime.authorization.exchangeRemoteDpopAccessToken",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly clientMetadata?: AuthClientPresentationMetadata;
  readonly dpopProof: string;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "auth");
  const response = yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/oauth/token"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.token({
      headers: { dpop: input.dpopProof },
      payload: {
        grant_type: AuthTokenExchangeGrantType,
        subject_token: input.credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        ...(input.scopes ? { scope: encodeOAuthScope(input.scopes) } : {}),
        ...clientMetadataTokenExchangeFields(input.clientMetadata),
      },
    }),
  );
  return response;
});

export const bootstrapRemoteBearerSession = Effect.fn(
  "clientRuntime.authorization.bootstrapRemoteBearerSession",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly credential: string;
  readonly scopes?: ReadonlyArray<AuthEnvironmentScope>;
  readonly clientMetadata?: AuthClientPresentationMetadata;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "auth");
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/oauth/token"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.token({
      headers: {},
      payload: {
        grant_type: AuthTokenExchangeGrantType,
        subject_token: input.credential,
        subject_token_type: AuthEnvironmentBootstrapTokenType,
        requested_token_type: AuthAccessTokenType,
        ...(input.scopes ? { scope: encodeOAuthScope(input.scopes) } : {}),
        ...clientMetadataTokenExchangeFields(input.clientMetadata),
      },
    }),
  );
});

export const fetchRemoteSessionState = Effect.fn(
  "clientRuntime.authorization.fetchRemoteSessionState",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "auth");
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/api/auth/session"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.session({
      headers: {
        authorization: `Bearer ${input.bearerToken}`,
      },
    }),
  );
});

const webSocketTicketPath = (use: AuthWebSocketTicketUse | undefined) =>
  use === undefined ? "/api/auth/websocket-ticket" : `/api/auth/websocket-ticket/${use}`;

/**
 * A server that predates ticket audiences has no `/:use` route and answers 404.
 * Its tickets are the unbound kind it always issued, so the bare path is the
 * right request there, not an error.
 */
const issueWebSocketTicketWithFallback = <E, R>(
  use: AuthWebSocketTicketUse | undefined,
  issue: (
    use: AuthWebSocketTicketUse | undefined,
  ) => Effect.Effect<AuthWebSocketTicketResult, E, R>,
  canFallBack = true,
) =>
  use === undefined || !canFallBack
    ? issue(use)
    : issue(use).pipe(
        Effect.catchIf(
          (error) =>
            error instanceof RemoteEnvironmentAuthUndeclaredStatusError && error.status === 404,
          () => issue(undefined),
        ),
      );

export const issueRemoteWebSocketTicket = Effect.fn(
  "clientRuntime.authorization.issueRemoteWebSocketTicket",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly use?: AuthWebSocketTicketUse;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "auth");
  const headers = { authorization: `Bearer ${input.bearerToken}` };
  return yield* issueWebSocketTicketWithFallback(input.use, (use) =>
    executeEnvironmentHttpRequest(
      environmentEndpointUrl(input.httpBaseUrl, webSocketTicketPath(use)),
      input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
      use === undefined
        ? client.webSocketTicket({ headers })
        : client.webSocketTicketFor({ headers, params: { use } }),
    ),
  );
});

export const issueRemoteDpopWebSocketTicket = Effect.fn(
  "clientRuntime.authorization.issueRemoteDpopWebSocketTicket",
)(function* <E = never>(input: {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly dpopProof: string;
  readonly use?: AuthWebSocketTicketUse;
  /** Proof for the bare path, used only when the server lacks the `/:use` route. */
  readonly fallbackProof?: Effect.Effect<string, E>;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiGroupClient(input.httpBaseUrl, "auth");
  const fallbackProof = input.fallbackProof;
  return yield* issueWebSocketTicketWithFallback(
    input.use,
    (use) =>
      Effect.gen(function* () {
        // The proof names the path it signs, so the fallback request needs its own.
        const dpopProof =
          use === input.use || fallbackProof === undefined ? input.dpopProof : yield* fallbackProof;
        const headers = { authorization: `DPoP ${input.accessToken}`, dpop: dpopProof };
        return yield* executeEnvironmentHttpRequest(
          environmentEndpointUrl(input.httpBaseUrl, webSocketTicketPath(use)),
          input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
          use === undefined
            ? client.webSocketTicket({ headers })
            : client.webSocketTicketFor({ headers, params: { use } }),
        );
      }),
    fallbackProof !== undefined,
  );
});

function rpcSocketUrl(wsBaseUrl: string): URL {
  const url = new URL(wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  return url;
}

export const resolveRemoteWebSocketConnectionUrl = Effect.fn(
  "clientRuntime.authorization.resolveRemoteWebSocketConnectionUrl",
)(function* (input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly clientMetadata?: AuthClientPresentationMetadata;
  readonly connectionMethod?: ClientConnectionMethod;
  readonly timeoutMs?: number;
}) {
  const issued = yield* issueRemoteWebSocketTicket({
    httpBaseUrl: input.httpBaseUrl,
    bearerToken: input.bearerToken,
    use: "rpc",
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });

  const url = rpcSocketUrl(input.wsBaseUrl);
  url.searchParams.set("wsTicket", issued.ticket);
  appendClientConnectionParams(
    url,
    input.clientMetadata,
    input.connectionMethod,
    yield* readClientOwnerParams,
  );
  return url.toString();
});

/**
 * A DPoP client's RPC ticket is bound to its key, so the upgrade carries a
 * proof too. A WebSocket cannot set headers, so it rides in the `dpop` query
 * parameter and names the socket URL as the HTTP request the server sees.
 */
export const resolveRemoteDpopWebSocketConnectionUrl = Effect.fn(
  "clientRuntime.authorization.resolveRemoteDpopWebSocketConnectionUrl",
)(function* <E>(input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly createProof: (input: {
    readonly method: "GET" | "POST";
    readonly url: string;
    readonly accessToken: string;
  }) => Effect.Effect<string, E>;
  readonly clientMetadata?: AuthClientPresentationMetadata;
  readonly connectionMethod?: ClientConnectionMethod;
  readonly timeoutMs?: number;
}) {
  const ticketProof = yield* input.createProof({
    method: "POST",
    url: environmentEndpointUrl(input.httpBaseUrl, webSocketTicketPath("rpc")),
    accessToken: input.accessToken,
  });
  const issued = yield* issueRemoteDpopWebSocketTicket({
    httpBaseUrl: input.httpBaseUrl,
    accessToken: input.accessToken,
    dpopProof: ticketProof,
    use: "rpc",
    fallbackProof: Effect.suspend(() =>
      input.createProof({
        method: "POST",
        url: environmentEndpointUrl(input.httpBaseUrl, webSocketTicketPath(undefined)),
        accessToken: input.accessToken,
      }),
    ),
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  const url = rpcSocketUrl(input.wsBaseUrl);
  const upgradeProof = yield* input.createProof({
    method: "GET",
    url: `${url.protocol === "wss:" ? "https:" : "http:"}//${url.host}${url.pathname}`,
    accessToken: issued.ticket,
  });
  url.searchParams.set("wsTicket", issued.ticket);
  url.searchParams.set("dpop", upgradeProof);
  appendClientConnectionParams(
    url,
    input.clientMetadata,
    input.connectionMethod,
    yield* readClientOwnerParams,
  );
  return url.toString();
});

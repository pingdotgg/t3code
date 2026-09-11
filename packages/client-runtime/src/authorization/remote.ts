import {
  AuthAccessTokenType,
  type AuthClientPresentationMetadata,
  AuthEnvironmentBootstrapTokenType,
  AuthTokenExchangeGrantType,
  type ClientConnectionMethod,
  type AuthEnvironmentScope,
} from "@t3tools/contracts";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import * as Effect from "effect/Effect";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

export {
  RemoteEnvironmentAuthInvalidJsonError,
  RemoteEnvironmentAuthTimeoutError,
  RemoteEnvironmentAuthUndeclaredStatusError,
} from "../rpc/http.ts";
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

// The server reads these off the /ws upgrade URL next to wsTicket. Optional on
// both ends: old servers ignore unknown params, old clients never send them.
export const appendClientConnectionParams = (
  url: URL,
  clientMetadata: AuthClientPresentationMetadata | undefined,
  connectionMethod?: ClientConnectionMethod,
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
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  const response = yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/oauth/token"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.auth.token({
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
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/oauth/token"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.auth.token({
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
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/api/auth/session"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.auth.session({
      headers: {
        authorization: `Bearer ${input.bearerToken}`,
      },
    }),
  );
});

export const fetchRemoteDpopSessionState = Effect.fn(
  "clientRuntime.authorization.fetchRemoteDpopSessionState",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly dpopProof: string;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/api/auth/session"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.auth.session({
      headers: {
        authorization: `DPoP ${input.accessToken}`,
        dpop: input.dpopProof,
      },
    }),
  );
});

export const issueRemoteWebSocketTicket = Effect.fn(
  "clientRuntime.authorization.issueRemoteWebSocketTicket",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly bearerToken: string;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/api/auth/websocket-ticket"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.auth.webSocketTicket({
      headers: {
        authorization: `Bearer ${input.bearerToken}`,
      },
    }),
  );
});

export const issueRemoteDpopWebSocketTicket = Effect.fn(
  "clientRuntime.authorization.issueRemoteDpopWebSocketTicket",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly dpopProof: string;
  readonly timeoutMs?: number;
}) {
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    environmentEndpointUrl(input.httpBaseUrl, "/api/auth/websocket-ticket"),
    input.timeoutMs ?? DEFAULT_REMOTE_REQUEST_TIMEOUT_MS,
    client.auth.webSocketTicket({
      headers: {
        authorization: `DPoP ${input.accessToken}`,
        dpop: input.dpopProof,
      },
    }),
  );
});

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
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });

  const url = new URL(input.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  url.searchParams.set("wsTicket", issued.ticket);
  appendClientConnectionParams(url, input.clientMetadata, input.connectionMethod);
  return url.toString();
});

export const resolveRemoteDpopWebSocketConnectionUrl = Effect.fn(
  "clientRuntime.authorization.resolveRemoteDpopWebSocketConnectionUrl",
)(function* (input: {
  readonly wsBaseUrl: string;
  readonly httpBaseUrl: string;
  readonly accessToken: string;
  readonly dpopProof: string;
  readonly clientMetadata?: AuthClientPresentationMetadata;
  readonly connectionMethod?: ClientConnectionMethod;
  readonly timeoutMs?: number;
}) {
  const issued = yield* issueRemoteDpopWebSocketTicket({
    httpBaseUrl: input.httpBaseUrl,
    accessToken: input.accessToken,
    dpopProof: input.dpopProof,
    ...(input.timeoutMs ? { timeoutMs: input.timeoutMs } : {}),
  });
  const url = new URL(input.wsBaseUrl);
  if (url.pathname === "" || url.pathname === "/") {
    url.pathname = "/ws";
  }
  url.searchParams.set("wsTicket", issued.ticket);
  appendClientConnectionParams(url, input.clientMetadata, input.connectionMethod);
  return url.toString();
});

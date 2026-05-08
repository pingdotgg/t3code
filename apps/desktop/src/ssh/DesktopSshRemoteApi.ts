import {
  AuthBearerBootstrapResult,
  AuthSessionState,
  AuthWebSocketTokenResult,
  type AuthBearerBootstrapResult as AuthBearerBootstrapResultType,
  type AuthSessionState as AuthSessionStateType,
  type AuthWebSocketTokenResult as AuthWebSocketTokenResultType,
  ExecutionEnvironmentDescriptor,
  type ExecutionEnvironmentDescriptor as ExecutionEnvironmentDescriptorType,
} from "@t3tools/contracts";
import { SshHttpBridgeError } from "@t3tools/ssh/errors";
import { fetchLoopbackSshJson } from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/unstable/http";

export type DesktopSshRemoteApiOperation =
  | "fetch-environment-descriptor"
  | "bootstrap-bearer-session"
  | "fetch-session-state"
  | "issue-websocket-token";

export class DesktopSshRemoteApiError extends Data.TaggedError("DesktopSshRemoteApiError")<{
  readonly operation: DesktopSshRemoteApiOperation;
  readonly cause: SshHttpBridgeError | Schema.SchemaError;
}> {
  override get message() {
    return `SSH remote API request failed during ${this.operation}.`;
  }
}

export interface DesktopSshRemoteApiShape {
  readonly fetchEnvironmentDescriptor: (input: {
    readonly httpBaseUrl: string;
  }) => Effect.Effect<ExecutionEnvironmentDescriptorType, DesktopSshRemoteApiError>;
  readonly bootstrapBearerSession: (input: {
    readonly httpBaseUrl: string;
    readonly credential: string;
  }) => Effect.Effect<AuthBearerBootstrapResultType, DesktopSshRemoteApiError>;
  readonly fetchSessionState: (input: {
    readonly httpBaseUrl: string;
    readonly bearerToken: string;
  }) => Effect.Effect<AuthSessionStateType, DesktopSshRemoteApiError>;
  readonly issueWebSocketToken: (input: {
    readonly httpBaseUrl: string;
    readonly bearerToken: string;
  }) => Effect.Effect<AuthWebSocketTokenResultType, DesktopSshRemoteApiError>;
}

export class DesktopSshRemoteApi extends Context.Service<
  DesktopSshRemoteApi,
  DesktopSshRemoteApiShape
>()("t3/desktop/SshRemoteApi") {}

const decodeExecutionEnvironmentDescriptor = Schema.decodeUnknownEffect(
  ExecutionEnvironmentDescriptor,
);
const decodeAuthBearerBootstrapResult = Schema.decodeUnknownEffect(AuthBearerBootstrapResult);
const decodeAuthSessionState = Schema.decodeUnknownEffect(AuthSessionState);
const decodeAuthWebSocketTokenResult = Schema.decodeUnknownEffect(AuthWebSocketTokenResult);

const mapError =
  (operation: DesktopSshRemoteApiOperation) =>
  (cause: SshHttpBridgeError | Schema.SchemaError): DesktopSshRemoteApiError =>
    new DesktopSshRemoteApiError({ operation, cause });

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const provideHttpClient = <A, E>(effect: Effect.Effect<A, E, HttpClient.HttpClient>) =>
    effect.pipe(Effect.provideService(HttpClient.HttpClient, httpClient));

  return DesktopSshRemoteApi.of({
    fetchEnvironmentDescriptor: ({ httpBaseUrl }) =>
      fetchLoopbackSshJson<unknown>({
        httpBaseUrl,
        pathname: "/.well-known/t3/environment",
      }).pipe(
        Effect.flatMap(decodeExecutionEnvironmentDescriptor),
        Effect.mapError(mapError("fetch-environment-descriptor")),
        provideHttpClient,
        Effect.withSpan("desktop.sshRemoteApi.fetchEnvironmentDescriptor"),
      ),
    bootstrapBearerSession: ({ httpBaseUrl, credential }) =>
      fetchLoopbackSshJson<unknown>({
        httpBaseUrl,
        pathname: "/api/auth/bootstrap/bearer",
        method: "POST",
        body: { credential },
      }).pipe(
        Effect.flatMap(decodeAuthBearerBootstrapResult),
        Effect.mapError(mapError("bootstrap-bearer-session")),
        provideHttpClient,
        Effect.withSpan("desktop.sshRemoteApi.bootstrapBearerSession"),
      ),
    fetchSessionState: ({ httpBaseUrl, bearerToken }) =>
      fetchLoopbackSshJson<unknown>({
        httpBaseUrl,
        pathname: "/api/auth/session",
        bearerToken,
      }).pipe(
        Effect.flatMap(decodeAuthSessionState),
        Effect.mapError(mapError("fetch-session-state")),
        provideHttpClient,
        Effect.withSpan("desktop.sshRemoteApi.fetchSessionState"),
      ),
    issueWebSocketToken: ({ httpBaseUrl, bearerToken }) =>
      fetchLoopbackSshJson<unknown>({
        httpBaseUrl,
        pathname: "/api/auth/ws-token",
        method: "POST",
        bearerToken,
      }).pipe(
        Effect.flatMap(decodeAuthWebSocketTokenResult),
        Effect.mapError(mapError("issue-websocket-token")),
        provideHttpClient,
        Effect.withSpan("desktop.sshRemoteApi.issueWebSocketToken"),
      ),
  });
});

export const layer = Layer.effect(DesktopSshRemoteApi, make);

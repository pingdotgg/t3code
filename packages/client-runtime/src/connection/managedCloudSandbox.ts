import type {
  ManagedCloudSandboxResourceId,
  ManagedCloudSandboxConnection,
  ManagedCloudSandboxOperation,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient } from "effect/http";
import * as RemoteAuthorization from "../authorization/service.ts";
import { environmentEndpointUrl } from "../environment/endpoint.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "../state/environmentHttpRequest.ts";
import {
  RemoteEnvironmentAuthUndeclaredStatusError,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";
import { environmentMismatchError, mapRemoteEnvironmentError } from "./errors.ts";
import {
  ConnectionBlockedError,
  type ConnectionAttemptError,
  type PreparedConnection,
} from "./model.ts";

/** The controller answers 410 once a sandbox is deleted or being deleted. */
const SANDBOX_DELETED_STATUS = 410;

const isUndeclaredStatus = Schema.is(RemoteEnvironmentAuthUndeclaredStatusError);

const mapOperateError = (error: RemoteEnvironmentRequestError): ConnectionAttemptError =>
  isUndeclaredStatus(error) && error.status === SANDBOX_DELETED_STATUS
    ? new ConnectionBlockedError({
        reason: "configuration",
        detail: "This cloud sandbox was deleted. Remove it from your environments.",
      })
    : mapRemoteEnvironmentError(error);

export const makeManagedCloudSandboxClient = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteAuthorization.RemoteEnvironmentAuthorization,
  );
  return Effect.fn("clientRuntime.cloudSandbox.operate")(function* (
    prepared: PreparedConnection,
    operation: ManagedCloudSandboxOperation,
  ) {
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "managedCloudSandbox",
      method: "POST",
      url: (urls) => urls.operate(),
      timeoutMs: 180_000,
      request: ({ client, headers }) => client.operate({ headers, payload: operation }),
    }).pipe(
      Effect.provideService(HttpClient.HttpClient, httpClient),
      Effect.mapError(mapOperateError),
    );
  });
});

export const managedCloudSandboxUrls = Effect.fn("clientRuntime.cloudSandbox.urls")(function* (
  controller: PreparedConnection,
  connection: ManagedCloudSandboxConnection,
) {
  if (controller.environmentId !== connection.controllerEnvironmentId)
    return yield* environmentMismatchError({
      expected: controller.environmentId,
      actual: connection.controllerEnvironmentId,
    });
  const httpBaseUrl = environmentEndpointUrl(controller.httpBaseUrl, connection.routePrefix);
  const ws = new URL(environmentEndpointUrl(httpBaseUrl, "/ws"));
  ws.protocol = ws.protocol === "https:" ? "wss:" : "ws:";
  return { httpBaseUrl, wsBaseUrl: ws.toString() };
});

export const downloadCloudSandboxRecording = Effect.fn(
  "clientRuntime.cloudSandbox.downloadRecording",
)(function* (
  prepared: PreparedConnection,
  resourceId: ManagedCloudSandboxResourceId,
  recordingId: ManagedCloudSandboxResourceId,
) {
  const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
  const remoteAuthorization = yield* Effect.serviceOption(
    RemoteAuthorization.RemoteEnvironmentAuthorization,
  );
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    prepared,
    signer,
    remoteAuthorization,
    group: "managedCloudSandbox",
    method: "GET",
    url: (urls) => urls.artifact({ params: { resourceId, recordingId } }),
    timeoutMs: 180_000,
    request: ({ client, headers }) =>
      client.artifact({ headers, params: { resourceId, recordingId } }),
  });
});

export const openCloudSandboxPreview = Effect.fn("clientRuntime.cloudSandbox.openPreview")(
  function* (
    prepared: PreparedConnection,
    resourceId: ManagedCloudSandboxResourceId,
    url: string,
    access: "local" | "protected" = "protected",
    close = false,
  ) {
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteAuthorization.RemoteEnvironmentAuthorization,
    );
    return yield* executeAuthenticatedEnvironmentHttpRequest({
      prepared,
      signer,
      remoteAuthorization,
      group: "managedCloudSandbox",
      method: "POST",
      url: (urls) => urls.preview(),
      timeoutMs: 180_000,
      request: ({ client, headers }) =>
        client.preview({ headers, payload: { resourceId, url, access, close } }),
    });
  },
);

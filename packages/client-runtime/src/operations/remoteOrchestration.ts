import {
  type ClientOrchestrationCommand,
  type CommandId,
  type DispatchResult,
  type OrchestrationReadModel,
  type OrchestrationCliCreateRequest,
  type OrchestrationCliCreateResult,
  type OrchestrationShellSnapshot,
  type OrchestrationThreadDetailSnapshot,
  type ThreadId,
  type RemoteInteractionAnswerRequest,
  type RemoteInteractionApproveRequest,
  type RemoteInteractionRejectRequest,
  type RemoteInteractionResponseResult,
  type RemoteInteractionThreadId,
  type RemotePendingInteractionsResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { HttpClient } from "effect/unstable/http";

import { environmentEndpointUrl } from "../environment/endpoint.ts";
import {
  executeEnvironmentHttpRequest,
  makeEnvironmentHttpApiClient,
  type RemoteEnvironmentRequestError,
} from "../rpc/http.ts";

const DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS = 10_000;

export interface RemoteBearerAuthorization {
  readonly accessToken: string;
}

const bearerHeaders = (authorization: RemoteBearerAuthorization) => ({
  authorization: `Bearer ${authorization.accessToken}`,
});

export const fetchRemoteOrchestrationSnapshot = Effect.fn(
  "clientRuntime.operations.fetchRemoteOrchestrationSnapshot",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly authorization: RemoteBearerAuthorization;
  readonly timeoutMs?: number;
}): Effect.fn.Return<OrchestrationReadModel, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
  const requestUrl = environmentEndpointUrl(input.httpBaseUrl, "/api/orchestration/snapshot");
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.snapshot({ headers: bearerHeaders(input.authorization) }),
  );
});

export const fetchRemoteOrchestrationShell = Effect.fn(
  "clientRuntime.operations.fetchRemoteOrchestrationShell",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly authorization: RemoteBearerAuthorization;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  OrchestrationShellSnapshot,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const requestUrl = environmentEndpointUrl(input.httpBaseUrl, "/api/orchestration/shell");
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.shellSnapshot({ headers: bearerHeaders(input.authorization) }),
  );
});

export const fetchRemoteOrchestrationThread = Effect.fn(
  "clientRuntime.operations.fetchRemoteOrchestrationThread",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly authorization: RemoteBearerAuthorization;
  readonly threadId: ThreadId;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  OrchestrationThreadDetailSnapshot,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const requestUrl = environmentEndpointUrl(
    input.httpBaseUrl,
    `/api/orchestration/threads/${input.threadId}`,
  );
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.threadSnapshot({
      params: { threadId: input.threadId },
      headers: bearerHeaders(input.authorization),
    }),
  );
});

export const dispatchRemoteOrchestrationCommand = Effect.fn(
  "clientRuntime.operations.dispatchRemoteOrchestrationCommand",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly authorization: RemoteBearerAuthorization;
  readonly command: ClientOrchestrationCommand;
  readonly timeoutMs?: number;
}): Effect.fn.Return<DispatchResult, RemoteEnvironmentRequestError, HttpClient.HttpClient> {
  const requestUrl = environmentEndpointUrl(input.httpBaseUrl, "/api/orchestration/dispatch");
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.dispatch({
      headers: bearerHeaders(input.authorization),
      payload: input.command,
    } as Parameters<typeof client.orchestration.dispatch>[0]),
  );
});

export const createRemoteOrchestrationThread = Effect.fn(
  "clientRuntime.operations.createRemoteOrchestrationThread",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly authorization: RemoteBearerAuthorization;
  readonly payload: OrchestrationCliCreateRequest;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  OrchestrationCliCreateResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const requestUrl = environmentEndpointUrl(input.httpBaseUrl, "/api/orchestration/create");
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.create({
      headers: bearerHeaders(input.authorization),
      payload: input.payload,
    }),
  );
});

export const fetchRemotePendingInteractions = Effect.fn(
  "clientRuntime.operations.fetchRemotePendingInteractions",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly authorization: RemoteBearerAuthorization;
  readonly threadId?: RemoteInteractionThreadId;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  RemotePendingInteractionsResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const requestUrl = environmentEndpointUrl(
    input.httpBaseUrl,
    "/api/orchestration/pending-interactions",
  );
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.pendingInteractions({
      headers: bearerHeaders(input.authorization),
      query: input.threadId === undefined ? {} : { threadId: input.threadId },
    }),
  );
});

export const answerRemotePendingInteraction = Effect.fn(
  "clientRuntime.operations.answerRemotePendingInteraction",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly authorization: RemoteBearerAuthorization;
  readonly payload: RemoteInteractionAnswerRequest;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  RemoteInteractionResponseResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const requestUrl = environmentEndpointUrl(
    input.httpBaseUrl,
    "/api/orchestration/pending-interactions/answer",
  );
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.answerPendingInteraction({
      headers: bearerHeaders(input.authorization),
      payload: input.payload,
    }),
  );
});

export const approveRemotePendingInteraction = Effect.fn(
  "clientRuntime.operations.approveRemotePendingInteraction",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly authorization: RemoteBearerAuthorization;
  readonly payload: RemoteInteractionApproveRequest;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  RemoteInteractionResponseResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const requestUrl = environmentEndpointUrl(
    input.httpBaseUrl,
    "/api/orchestration/pending-interactions/approve",
  );
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.approvePendingInteraction({
      headers: bearerHeaders(input.authorization),
      payload: input.payload,
    }),
  );
});

export const rejectRemotePendingInteraction = Effect.fn(
  "clientRuntime.operations.rejectRemotePendingInteraction",
)(function* (input: {
  readonly httpBaseUrl: string;
  readonly authorization: RemoteBearerAuthorization;
  readonly payload: RemoteInteractionRejectRequest;
  readonly timeoutMs?: number;
}): Effect.fn.Return<
  RemoteInteractionResponseResult,
  RemoteEnvironmentRequestError,
  HttpClient.HttpClient
> {
  const requestUrl = environmentEndpointUrl(
    input.httpBaseUrl,
    "/api/orchestration/pending-interactions/reject",
  );
  const client = yield* makeEnvironmentHttpApiClient(input.httpBaseUrl);
  return yield* executeEnvironmentHttpRequest(
    requestUrl,
    input.timeoutMs ?? DEFAULT_REMOTE_ORCHESTRATION_TIMEOUT_MS,
    client.orchestration.rejectPendingInteraction({
      headers: bearerHeaders(input.authorization),
      payload: input.payload,
    }),
  );
});

export function remoteThreadContainsCommand(
  snapshot: OrchestrationThreadDetailSnapshot,
  commandId: CommandId,
): boolean {
  return snapshot.thread.messages.some((message) => String(message.id) === String(commandId));
}

import {
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";
import { bench, describe } from "vite-plus/test";

import { issueRemoteWebSocketTicket } from "./authorization/remote.ts";
import { PrimaryConnectionTarget } from "./connection/model.ts";
import { fetchRemoteEnvironmentDescriptor } from "./environment/descriptor.ts";
import type { RemoteEnvironmentRequestError } from "./rpc/http.ts";
import { fetchEnvironmentThreadSnapshot } from "./state/threadSnapshotHttp.ts";
import { applyOrchestrationV2ProjectionEvent } from "./state/orchestrationV2Projection.ts";
import { v2Projection, v2Now } from "./state/orchestrationV2TestFixtures.ts";

const timestamp = "2026-09-01T00:00:00.000Z";
const thread: OrchestrationV2ThreadProjection = {
  ...v2Projection,
  messages: Array.from({ length: 100 }, (_, index) => ({
    id: MessageId.make(`message-${index}`),
    threadId: v2Projection.thread.id,
    runId: null,
    nodeId: null,
    role: "assistant",
    text: "Message text. ".repeat(40),
    attachments: [],
    streaming: false,
    createdBy: "agent",
    creationSource: "provider",
    createdAt: v2Now,
    updatedAt: v2Now,
  })),
};
const target = new PrimaryConnectionTarget({
  environmentId: EnvironmentId.make("remote-1"),
  label: "Remote",
  httpBaseUrl: "https://remote.example.test",
  wsBaseUrl: "wss://remote.example.test/ws",
});
const responses = {
  "/.well-known/t3/environment": {
    environmentId: target.environmentId,
    label: target.label,
    platform: { os: "linux", arch: "x64" },
    serverVersion: "0.0.0-test",
    capabilities: { repositoryIdentity: true },
  },
  "/api/auth/websocket-ticket": { ticket: "test-ticket", expiresAt: timestamp },
  "/api/orchestration/threads/thread-v2": { snapshotSequence: 1, projection: thread },
};
const httpClient = HttpClient.make((request) =>
  Effect.sync(() => {
    const path = new URL(request.url).pathname as keyof typeof responses;
    return HttpClientResponse.fromWeb(request, Response.json(responses[path]));
  }),
);
const requests: Record<
  string,
  Effect.Effect<unknown, RemoteEnvironmentRequestError, HttpClient.HttpClient>
> = {
  "read remote connection descriptor": fetchRemoteEnvironmentDescriptor({
    httpBaseUrl: target.httpBaseUrl,
  }),
  "issue remote WebSocket ticket": issueRemoteWebSocketTicket({
    httpBaseUrl: target.httpBaseUrl,
    bearerToken: "test-token",
  }),
  "load remote snapshot with 100 messages": fetchEnvironmentThreadSnapshot({
    prepared: {
      environmentId: target.environmentId,
      label: target.label,
      httpBaseUrl: target.httpBaseUrl,
      socketUrl: target.wsBaseUrl,
      httpAuthorization: null,
      target,
    },
    threadId: thread.thread.id,
    signer: Option.none(),
  }),
};

describe("remote HTTP processing with an in-memory transport", () => {
  for (const [name, request] of Object.entries(requests)) {
    bench(
      name,
      async () => {
        await Effect.runPromise(
          request.pipe(Effect.provideService(HttpClient.HttpClient, httpClient)),
        );
      },
      { warmupTime: 1_000, time: 1_500 },
    );
  }
});

const delta: Extract<OrchestrationV2DomainEvent, { type: "message.updated" }> = {
  id: EventId.make("delta"),
  type: "message.updated",
  threadId: thread.thread.id,
  occurredAt: v2Now,
  payload: { ...thread.messages[99]!, text: " next", streaming: true },
};

describe("remote message replay", () => {
  for (const count of [100, 1_000]) {
    const loaded = {
      ...thread,
      messages: Array.from({ length: count }, (_, index) => ({
        ...thread.messages[0]!,
        id: MessageId.make(`message-${index}`),
      })),
    };
    const event = {
      ...delta,
      payload: { ...delta.payload, id: loaded.messages.at(-1)!.id },
    };
    bench(
      `apply 200 message updates to ${count} loaded messages`,
      () => {
        let current: OrchestrationV2ThreadProjection = loaded;
        for (let index = 0; index < 200; index += 1) {
          current =
            applyOrchestrationV2ProjectionEvent(current, {
              ...event,
              payload: { ...event.payload, text: ` next ${index}` },
            }) ?? current;
        }
      },
      { warmupTime: 1_000, time: 1_500 },
    );
  }
});

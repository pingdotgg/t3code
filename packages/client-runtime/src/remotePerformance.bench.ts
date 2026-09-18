import {
  EnvironmentId,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationThread,
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
import { applyThreadDetailEvent } from "./state/threadReducer.ts";

const timestamp = "2026-09-01T00:00:00.000Z";
const thread: OrchestrationThread = {
  id: ThreadId.make("thread-1"),
  projectId: ProjectId.make("project-1"),
  title: "Remote thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  pullRequests: [],
  messages: Array.from({ length: 100 }, (_, index) => ({
    id: MessageId.make(`message-${index}`),
    role: "assistant",
    text: "Message text. ".repeat(40),
    turnId: null,
    streaming: false,
    createdAt: timestamp,
    updatedAt: timestamp,
  })),
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
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
  "/api/orchestration/threads/thread-1": { snapshotSequence: 1, thread },
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
    threadId: thread.id,
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

const delta: OrchestrationEvent = {
  eventId: EventId.make("delta"),
  sequence: 2,
  aggregateKind: "thread",
  aggregateId: thread.id,
  occurredAt: timestamp,
  commandId: null,
  causationEventId: null,
  correlationId: null,
  metadata: {},
  type: "thread.message-sent",
  payload: {
    threadId: thread.id,
    messageId: MessageId.make("message-99"),
    role: "assistant",
    text: " next",
    turnId: null,
    streaming: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
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
      payload: { ...delta.payload, messageId: loaded.messages.at(-1)!.id },
    };
    bench(
      `apply 200 text deltas to ${count} loaded messages`,
      () => {
        let current: OrchestrationThread = loaded;
        for (let index = 0; index < 200; index += 1) {
          const result = applyThreadDetailEvent(current, event);
          if (result.kind === "updated") current = result.thread;
        }
      },
      { warmupTime: 1_000, time: 1_500 },
    );
  }
});

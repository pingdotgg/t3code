import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  HttpClient,
  HttpClientError,
  HttpClientResponse,
  type HttpClientRequest,
} from "effect/unstable/http";

import { makeAetherRestClient, type AetherRestError } from "./restClient.ts";

const decodeJsonBody = Schema.decodeSync(Schema.fromJsonString(Schema.Unknown));

interface RecordedRequest {
  readonly method: string;
  readonly url: string;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

/** A mock HttpClient that records every request and replies via `handler`. */
const makeRecordingClient = (
  handler: (request: HttpClientRequest.HttpClientRequest) => Response,
) => {
  const requests: Array<RecordedRequest> = [];
  const client = HttpClient.make((request) =>
    Effect.sync(() => {
      const bodyText =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      requests.push({
        method: request.method,
        url: request.url,
        authorization: request.headers["authorization"],
        body: bodyText.length > 0 ? decodeJsonBody(bodyText) : undefined,
      });
      return HttpClientResponse.fromWeb(request, handler(request));
    }),
  );
  return { requests, client };
};

const failingTransportClient = () =>
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({
          request,
          cause: new Error("connection refused"),
        }),
      }),
    ),
  );

const makeClient = (httpClient: HttpClient.HttpClient) =>
  makeAetherRestClient({
    apiBaseUrl: "https://api.example.test/",
    apiKey: "aether-test-key",
    httpClient,
  });

const taskBase = {
  id: "task-1",
  project_id: "project-1",
  user_id: "user-1",
  name: "Fix the flaky test",
  agent_type: "codex",
  model: "gpt-5.6-sol",
  interaction_mode: "default",
  auto_fix_ci: false,
  auto_fix_pr_comments: false,
  auto_rebase: false,
  latest_sequence: 41,
  // Additive fields the client must tolerate without declaring them:
  display_status: "Working",
  usage: { tokens_in: 1, tokens_out: 2 },
  created_at: "2026-08-08T10:00:00Z",
};

const expectFailure = <A>(effect: Effect.Effect<A, AetherRestError>) => Effect.flip(effect);

describe("makeAetherRestClient", () => {
  describe("happy paths", () => {
    it.effect("createTask POSTs the body with bearer auth and parses the 202", () =>
      Effect.gen(function* () {
        const { requests, client } = makeRecordingClient(() =>
          Response.json({ id: "task-1", name: "Fix the flaky test" }, { status: 202 }),
        );
        const created = yield* makeClient(client).createTask({
          project_id: "project-1",
          prompt: "Fix the flaky test",
          base_branch: "main",
          agent_type: "codex",
          model: "gpt-5.6-sol",
          interaction_mode: "default",
          auto_fix_ci: false,
          auto_fix_pr_comments: false,
          auto_rebase: false,
        });
        expect(created).toEqual({ id: "task-1", name: "Fix the flaky test" });
        expect(requests).toHaveLength(1);
        expect(requests[0]?.method).toBe("POST");
        // Trailing base-URL slash is normalized away.
        expect(requests[0]?.url).toBe("https://api.example.test/tasks");
        expect(requests[0]?.authorization).toBe("Bearer aether-test-key");
        expect(requests[0]?.body).toEqual({
          project_id: "project-1",
          prompt: "Fix the flaky test",
          base_branch: "main",
          agent_type: "codex",
          model: "gpt-5.6-sol",
          interaction_mode: "default",
          auto_fix_ci: false,
          auto_fix_pr_comments: false,
          auto_rebase: false,
        });
      }),
    );

    it.effect("respondToTask carries client_message_id and parses message_id", () =>
      Effect.gen(function* () {
        const { requests, client } = makeRecordingClient(() =>
          Response.json({ message_id: "message-9" }, { status: 202 }),
        );
        const accepted = yield* makeClient(client).respondToTask("task-1", {
          message: "also update the docs",
          client_message_id: "3e2a4f9c-0000-4000-8000-000000000001",
        });
        expect(accepted).toEqual({ message_id: "message-9" });
        expect(requests[0]?.url).toBe("https://api.example.test/tasks/task-1/respond");
        expect(requests[0]?.body).toEqual({
          message: "also update the docs",
          client_message_id: "3e2a4f9c-0000-4000-8000-000000000001",
        });
      }),
    );

    it.effect("stopTask sends the explicit discard_queued_messages flag", () =>
      Effect.gen(function* () {
        const { requests, client } = makeRecordingClient(() => new Response(null, { status: 200 }));
        yield* makeClient(client).stopTask("task-1", { discardQueuedMessages: true });
        expect(requests[0]?.url).toBe("https://api.example.test/tasks/task-1/stop");
        expect(requests[0]?.body).toEqual({ discard_queued_messages: true });
      }),
    );

    it.effect("removeFromQueue sends the message id", () =>
      Effect.gen(function* () {
        const { requests, client } = makeRecordingClient(() => new Response(null, { status: 200 }));
        yield* makeClient(client).removeFromQueue("task-1", "message-3");
        expect(requests[0]?.url).toBe("https://api.example.test/tasks/task-1/remove-from-queue");
        expect(requests[0]?.body).toEqual({ message_id: "message-3" });
      }),
    );

    it.effect("updateTask PUTs the full-replace body and decodes the task union", () =>
      Effect.gen(function* () {
        const { requests, client } = makeRecordingClient(() =>
          Response.json({
            ...taskBase,
            model: "claude-opus-5",
            agent_type: "claude-code",
            status: "awaiting_input",
            run_context: { workspace_id: "ws-1", started_at: "2026-08-08T10:01:00Z" },
            awaiting_input: { kind: "message" },
            activity_items: [],
          }),
        );
        const task = yield* makeClient(client).updateTask("task-1", {
          agent_type: "claude-code",
          model: "claude-opus-5",
          interaction_mode: "default",
          reasoning_effort: null,
          auto_fix_ci: false,
          auto_fix_pr_comments: false,
          auto_rebase: false,
        });
        expect(requests[0]?.method).toBe("PUT");
        expect(requests[0]?.url).toBe("https://api.example.test/tasks/task-1");
        // Full replace: reasoning_effort travels as an explicit null.
        expect(requests[0]?.body).toEqual({
          agent_type: "claude-code",
          model: "claude-opus-5",
          interaction_mode: "default",
          reasoning_effort: null,
          auto_fix_ci: false,
          auto_fix_pr_comments: false,
          auto_rebase: false,
        });
        expect(task.status).toBe("awaiting_input");
        if (task.status === "awaiting_input") {
          expect(task.awaiting_input).toEqual({ kind: "message" });
        }
      }),
    );

    it.effect("getTask decodes every known status variant", () =>
      Effect.gen(function* () {
        const bodies = [
          { ...taskBase, status: "queued", run_context: null },
          {
            ...taskBase,
            status: "processing",
            run_context: { workspace_id: "ws-1", started_at: "2026-08-08T10:01:00Z" },
          },
          {
            ...taskBase,
            status: "awaiting_input",
            run_context: { workspace_id: "ws-1", started_at: "2026-08-08T10:01:00Z" },
            awaiting_input: {
              kind: "questions",
              tool_id: "tool-7",
              input: { questions: [{ id: "q1" }] },
            },
          },
          {
            ...taskBase,
            status: "errored",
            run_context: null,
            error: "agent crashed",
            completed_at: "2026-08-08T10:30:00Z",
          },
        ];
        let call = 0;
        const { client } = makeRecordingClient(() => Response.json(bodies[call++]));
        const restClient = makeClient(client);

        const queued = yield* restClient.getTask("task-1");
        expect(queued.status).toBe("queued");
        if (queued.status === "queued") {
          expect(queued.run_context).toBeNull();
        }

        const processing = yield* restClient.getTask("task-1");
        expect(processing.status).toBe("processing");
        if (processing.status === "processing") {
          expect(processing.run_context.workspace_id).toBe("ws-1");
        }

        const awaiting = yield* restClient.getTask("task-1");
        expect(awaiting.status).toBe("awaiting_input");
        if (awaiting.status === "awaiting_input" && awaiting.awaiting_input.kind === "questions") {
          expect(awaiting.awaiting_input.tool_id).toBe("tool-7");
        }

        const errored = yield* restClient.getTask("task-1");
        expect(errored.status).toBe("errored");
        if (errored.status === "errored") {
          expect(errored.error).toBe("agent crashed");
          expect(errored.completed_at).toBe("2026-08-08T10:30:00Z");
        }
      }),
    );

    it.effect("getConversationDelta parses every timeline row variant", () =>
      Effect.gen(function* () {
        const { requests, client } = makeRecordingClient(() =>
          Response.json({
            task: { ...taskBase, status: "queued", run_context: null },
            messages: [
              {
                id: "m-user",
                role: "user",
                content: "do the thing",
                deliveryStatus: "delivered",
                timestamp: "t1",
                sequence: 1,
              },
              {
                id: "m-text",
                role: "assistant",
                variant: "text",
                content: "on it",
                timestamp: "t2",
                sequence: 2,
              },
              {
                id: "m-think",
                role: "assistant",
                variant: "thinking",
                content: "hmm",
                isStreaming: false,
                duration: 1.5,
                timestamp: "t3",
                sequence: 3,
              },
              {
                id: "m-tool",
                role: "assistant",
                variant: "tool",
                tool: {
                  id: "tool-1",
                  name: "Bash",
                  input: { command: "ls" },
                  status: "completed",
                  itemType: "command_execution",
                  display: { label: "ls" },
                  result: "README.md",
                },
                timestamp: "t4",
                sequence: 4,
              },
              {
                id: "m-seam",
                role: "assistant",
                variant: "seam",
                seam: { reason: "compaction", sessionId: "s1", boundaryId: "b1" },
                timestamp: "t5",
                sequence: 5,
              },
            ],
            removedMessageIds: ["m-gone"],
            activity: [{ id: "a1", type: "status" }],
            activeProcessingTurn: { messageId: "m-user", startedAt: "t1" },
            latestSequence: 5,
            truncated: false,
          }),
        );
        const delta = yield* makeClient(client).getConversationDelta("task-1", 3);
        expect(requests[0]?.url).toBe(
          "https://api.example.test/tasks/task-1/conversation/delta?after=3",
        );
        expect(delta.task.status).toBe("queued");
        expect(delta.messages).toHaveLength(5);
        expect(delta.removedMessageIds).toEqual(["m-gone"]);
        expect(delta.activeProcessingTurn).toEqual({ messageId: "m-user", startedAt: "t1" });
        expect(delta.latestSequence).toBe(5);
        expect(delta.truncated).toBe(false);
        const tool = delta.messages[3];
        if (tool !== undefined && tool.role === "assistant" && tool.variant === "tool") {
          expect(tool.tool.display.label).toBe("ls");
        } else {
          throw new Error("expected a tool row at index 3");
        }
      }),
    );

    it.effect("getConversationMessages parses the page envelope", () =>
      Effect.gen(function* () {
        const { requests, client } = makeRecordingClient(() =>
          Response.json({
            task: { ...taskBase, status: "queued", run_context: null },
            messages: [],
            activity: [],
            activeProcessingTurn: null,
            latestSequence: 41,
            oldestSequenceLoaded: null,
            oldestSortTimestampLoaded: null,
            hasMoreOlder: false,
          }),
        );
        const page = yield* makeClient(client).getConversationMessages("task-1");
        expect(requests[0]?.url).toBe(
          "https://api.example.test/tasks/task-1/conversation/messages",
        );
        expect(page.task.status).toBe("queued");
        expect(page.hasMoreOlder).toBe(false);
        expect(page.oldestSequenceLoaded).toBeNull();
      }),
    );

    it.effect("getConversationMessages sends the older-page cursor as paired query params", () =>
      Effect.gen(function* () {
        const { requests, client } = makeRecordingClient(() =>
          Response.json({
            task: { ...taskBase, status: "queued", run_context: null },
            messages: [],
            activity: [],
            activeProcessingTurn: null,
            latestSequence: 41,
            oldestSequenceLoaded: 3,
            oldestSortTimestampLoaded: "2026-08-08T09:00:00Z",
            hasMoreOlder: false,
          }),
        );
        yield* makeClient(client).getConversationMessages("task-1", {
          sequence: 17,
          sortTimestamp: "2026-08-08T10:00:00Z",
        });
        expect(requests[0]?.url).toBe(
          "https://api.example.test/tasks/task-1/conversation/messages?before=17&beforeSortTimestamp=2026-08-08T10%3A00%3A00Z",
        );
      }),
    );

    it.effect("listProjects returns repo_url and task_defaults", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(() =>
          Response.json({
            projects: [
              {
                id: "project-1",
                name: "aether",
                repo_url: "https://github.com/acme/aether",
                default_branch: "main",
                task_defaults: {
                  agent_type: "codex",
                  model: "gpt-5.6-sol",
                  interaction_mode: "default",
                  reasoning_effort: null,
                },
                hardware: { cpu: 4 },
              },
            ],
          }),
        );
        const projects = yield* makeClient(client).listProjects();
        expect(projects).toHaveLength(1);
        expect(projects[0]?.repo_url).toBe("https://github.com/acme/aether");
        expect(projects[0]?.task_defaults.model).toBe("gpt-5.6-sol");
      }),
    );

    it.effect("getProfile reuses the probe schema", () =>
      Effect.gen(function* () {
        const { requests, client } = makeRecordingClient(() =>
          Response.json({ email: "dev@example.test", display_name: "Dev" }),
        );
        const profile = yield* makeClient(client).getProfile();
        expect(requests[0]?.url).toBe("https://api.example.test/profile");
        expect(profile.email).toBe("dev@example.test");
      }),
    );
  });

  describe("forward compatibility", () => {
    it.effect("tolerates additive unknown fields on every payload", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(() =>
          Response.json({
            ...taskBase,
            status: "processing",
            run_context: {
              workspace_id: "ws-1",
              started_at: "2026-08-08T10:01:00Z",
              new_field: "surprise",
            },
            some_new_top_level_field: { nested: true },
            activity_items: [],
          }),
        );
        const task = yield* makeClient(client).getTask("task-1");
        expect(task.status).toBe("processing");
        expect(task.name).toBe("Fix the flaky test");
      }),
    );

    it.effect("carries an unrecognized status as the explicit unknown-status variant", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(() =>
          Response.json({ ...taskBase, status: "paused", run_context: null }),
        );
        const task = yield* makeClient(client).getTask("task-1");
        expect(task.status).toBe("unknown-status");
        if (task.status === "unknown-status") {
          expect(task.rawStatus).toBe("paused");
          expect(task.latest_sequence).toBe(41);
        }
      }),
    );

    it.effect("carries an unrecognized awaiting_input kind as the unknown-kind carrier", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(() =>
          Response.json({
            ...taskBase,
            status: "awaiting_input",
            run_context: null,
            awaiting_input: { kind: "approval", tool_id: "tool-9", input: {} },
          }),
        );
        const task = yield* makeClient(client).getTask("task-1");
        expect(task.status).toBe("awaiting_input");
        if (task.status === "awaiting_input") {
          expect(task.awaiting_input).toEqual({ kind: "unknown-kind", rawKind: "approval" });
        }
      }),
    );

    it.effect("fails loudly when a KNOWN awaiting_input kind carries a malformed payload", () =>
      Effect.gen(function* () {
        // questions requires tool_id; a violation must be a decode error,
        // never a silent downgrade to the unknown-kind carrier.
        const { client } = makeRecordingClient(() =>
          Response.json({
            ...taskBase,
            status: "awaiting_input",
            run_context: null,
            awaiting_input: { kind: "questions", input: {} },
          }),
        );
        const error = yield* expectFailure(makeClient(client).getTask("task-1"));
        expect(error._tag).toBe("AetherApiDecodeError");
      }),
    );

    it.effect("fails loudly when a KNOWN status carries a malformed payload", () =>
      Effect.gen(function* () {
        // processing requires a non-null run_context; a violation must be a
        // decode error, never a silent downgrade to unknown-status.
        const { client } = makeRecordingClient(() =>
          Response.json({ ...taskBase, status: "processing", run_context: null }),
        );
        const error = yield* expectFailure(makeClient(client).getTask("task-1"));
        expect(error._tag).toBe("AetherApiDecodeError");
      }),
    );
  });

  describe("error mapping", () => {
    it.effect("maps 401 to AetherApiAuthError", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(
          () => new Response(JSON.stringify({ error: "invalid api key" }), { status: 401 }),
        );
        const error = yield* expectFailure(makeClient(client).getTask("task-1"));
        expect(error._tag).toBe("AetherApiAuthError");
        expect(error.message).toContain("invalid api key");
      }),
    );

    it.effect("maps 402 to AetherApiPaymentRequiredError", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(
          () => new Response(JSON.stringify({ error: "out of credits" }), { status: 402 }),
        );
        const error = yield* expectFailure(
          makeClient(client).createTask({
            project_id: "project-1",
            prompt: "p",
            agent_type: "codex",
            model: "m",
            interaction_mode: "default",
            auto_fix_ci: false,
            auto_fix_pr_comments: false,
            auto_rebase: false,
          }),
        );
        expect(error._tag).toBe("AetherApiPaymentRequiredError");
        expect(error.message).toContain("out of credits");
      }),
    );

    it.effect("maps 404 to AetherApiNotFoundError", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(
          () => new Response(JSON.stringify({ error: "task not found" }), { status: 404 }),
        );
        const error = yield* expectFailure(makeClient(client).getTask("task-404"));
        expect(error._tag).toBe("AetherApiNotFoundError");
      }),
    );

    it.effect("maps 409 to AetherApiConflictError with code and awaiting_input_kind", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(
          () =>
            new Response(
              JSON.stringify({
                error: "task is awaiting input",
                code: "pending_tool_response",
                awaiting_input_kind: "questions",
              }),
              { status: 409 },
            ),
        );
        const error = yield* expectFailure(
          makeClient(client).respondToTask("task-1", { message: "hello" }),
        );
        expect(error._tag).toBe("AetherApiConflictError");
        if (error._tag === "AetherApiConflictError") {
          expect(error.code).toBe("pending_tool_response");
          expect(error.awaitingInputKind).toBe("questions");
        }
      }),
    );

    it.effect("maps a 409 with a non-JSON body to a conflict with the status text", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(() => new Response("nope", { status: 409 }));
        const error = yield* expectFailure(
          makeClient(client).respondToTask("task-1", { message: "hello" }),
        );
        expect(error._tag).toBe("AetherApiConflictError");
        expect(error.message).toContain("HTTP 409");
      }),
    );

    it.effect("maps other 4xx to AetherApiRequestError with the status", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(
          () => new Response(JSON.stringify({ error: "validation failed" }), { status: 422 }),
        );
        const error = yield* expectFailure(makeClient(client).getTask("task-1"));
        expect(error._tag).toBe("AetherApiRequestError");
        if (error._tag === "AetherApiRequestError") {
          expect(error.status).toBe(422);
        }
      }),
    );

    it.effect("maps 5xx to AetherApiTransportError", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(
          () => new Response(JSON.stringify({ error: "boom" }), { status: 502 }),
        );
        const error = yield* expectFailure(
          makeClient(client).stopTask("task-1", { discardQueuedMessages: true }),
        );
        expect(error._tag).toBe("AetherApiTransportError");
        if (error._tag === "AetherApiTransportError") {
          expect(error.status).toBe(502);
        }
      }),
    );

    it.effect("maps network failures to AetherApiTransportError", () =>
      Effect.gen(function* () {
        const error = yield* expectFailure(makeClient(failingTransportClient()).listProjects());
        expect(error._tag).toBe("AetherApiTransportError");
      }),
    );

    it.effect("maps a malformed 2xx body to AetherApiDecodeError", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(() => new Response("not json", { status: 200 }));
        const error = yield* expectFailure(makeClient(client).getProfile());
        expect(error._tag).toBe("AetherApiDecodeError");
      }),
    );

    it.effect("maps a schema-mismatched 2xx body to AetherApiDecodeError", () =>
      Effect.gen(function* () {
        const { client } = makeRecordingClient(() => Response.json({ projects: "nope" }));
        const error = yield* expectFailure(makeClient(client).listProjects());
        expect(error._tag).toBe("AetherApiDecodeError");
      }),
    );
  });
});

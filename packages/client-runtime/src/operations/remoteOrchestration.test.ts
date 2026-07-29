import { describe, expect, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ThreadId,
  type ClientOrchestrationCommand,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { remoteHttpClientLayer } from "../rpc/http.ts";
import {
  createRemoteOrchestrationThread,
  dispatchRemoteOrchestrationCommand,
  fetchRemoteOrchestrationShell,
  fetchRemoteOrchestrationSnapshot,
  fetchRemoteOrchestrationThread,
} from "./remoteOrchestration.ts";

type FetchCall = readonly [input: RequestInfo | URL, init: RequestInit];

const recordedFetch = (...responses: ReadonlyArray<Response>) => {
  const calls: FetchCall[] = [];
  let index = 0;
  const fetchFn = ((input, init) => {
    calls.push([input, init ?? {}]);
    const response = responses[index++];
    return response === undefined
      ? Promise.reject(new Error("Unexpected fetch call"))
      : Promise.resolve(response);
  }) satisfies typeof fetch;
  return { calls, fetchFn };
};

const emptySnapshot = {
  snapshotSequence: 0,
  projects: [],
  threads: [],
  updatedAt: "2026-07-21T00:00:00.000Z",
};

describe("remote orchestration HTTP operations", () => {
  it.effect(
    "decodes declared worktree conflicts from create and dispatch instead of replacing them with status",
    () =>
      Effect.gen(function* () {
        const conflictBody = {
          _tag: "EnvironmentConflictError",
          code: "conflict",
          reason: "worktree_branch_exists",
          message:
            "The requested branch already exists locally. Choose a different branch or remove the existing branch and its worktree.",
          traceId: "trace-conflict",
        };
        const fetch = recordedFetch(
          Response.json(conflictBody, { status: 409 }),
          Response.json(conflictBody, { status: 409 }),
        );
        const command = {
          type: "thread.turn.start",
          commandId: CommandId.make("command-conflict"),
          threadId: ThreadId.make("thread-conflict"),
          message: {
            messageId: MessageId.make("command-conflict"),
            role: "user",
            text: "hello",
            attachments: [],
          },
          runtimeMode: "full-access",
          interactionMode: "default",
          createdAt: "2026-07-21T00:00:00.000Z",
        } as ClientOrchestrationCommand;

        const authorization = { accessToken: "secret-token" };
        const results = yield* Effect.all([
          Effect.result(
            createRemoteOrchestrationThread({
              httpBaseUrl: "https://remote.example",
              authorization,
              payload: {
                project: "project-conflict",
                message: "create this",
                idempotencyKey: "create-conflict",
              },
            }),
          ),
          Effect.result(
            dispatchRemoteOrchestrationCommand({
              httpBaseUrl: "https://remote.example",
              authorization,
              command,
            }),
          ),
        ]).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));

        for (const result of results) {
          expect(result._tag).toBe("Failure");
          if (result._tag === "Failure") {
            expect(result.failure).toEqual(
              expect.objectContaining({
                _tag: "EnvironmentConflictError",
                code: "conflict",
                reason: "worktree_branch_exists",
                traceId: "trace-conflict",
              }),
            );
          }
        }
      }),
  );

  it.effect("uses only bearer headers for shell, snapshot, thread, create, and dispatch", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("thread-http");
      const thread = {
        id: threadId,
        projectId: "project-http",
        title: "HTTP thread",
        modelSelection: { instanceId: "codex_personal", model: "gpt-test" },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        latestTurn: null,
        createdAt: "2026-07-21T00:00:00.000Z",
        updatedAt: "2026-07-21T00:00:00.000Z",
        archivedAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session: null,
      };
      const fetch = recordedFetch(
        Response.json(emptySnapshot),
        Response.json(emptySnapshot),
        Response.json({ snapshotSequence: 0, thread }),
        Response.json({
          threadId: "thread-created",
          commandId: "command-created",
          sequence: 1,
          replayed: false,
        }),
        Response.json({ sequence: 1 }),
      );
      const authorization = { accessToken: "secret-token" };
      const command = {
        type: "thread.turn.start",
        commandId: CommandId.make("command-http"),
        threadId,
        message: {
          messageId: MessageId.make("command-http"),
          role: "user",
          text: "hello",
          attachments: [],
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        createdAt: "2026-07-21T00:00:00.000Z",
      } as ClientOrchestrationCommand;

      yield* fetchRemoteOrchestrationShell({
        httpBaseUrl: "https://remote.example/base",
        authorization,
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));
      yield* fetchRemoteOrchestrationSnapshot({
        httpBaseUrl: "https://remote.example/base",
        authorization,
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));
      yield* fetchRemoteOrchestrationThread({
        httpBaseUrl: "https://remote.example/base",
        authorization,
        threadId,
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));
      yield* createRemoteOrchestrationThread({
        httpBaseUrl: "https://remote.example/base",
        authorization,
        payload: {
          project: "project-http",
          message: "create this",
          idempotencyKey: "create-1",
        },
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));
      yield* dispatchRemoteOrchestrationCommand({
        httpBaseUrl: "https://remote.example/base",
        authorization,
        command,
      }).pipe(Effect.provide(remoteHttpClientLayer(fetch.fetchFn)));

      expect(fetch.calls.map(([url]) => String(url))).toEqual([
        "https://remote.example/api/orchestration/shell",
        "https://remote.example/api/orchestration/snapshot",
        "https://remote.example/api/orchestration/threads/thread-http",
        "https://remote.example/api/orchestration/create",
        "https://remote.example/api/orchestration/dispatch",
      ]);
      for (const [, init] of fetch.calls) {
        expect(init.headers).toEqual(
          expect.objectContaining({ authorization: "Bearer secret-token" }),
        );
      }
      const createHeaders = fetch.calls[3]?.[1].headers;
      expect(createHeaders).not.toEqual(expect.objectContaining({ cookie: expect.anything() }));
      const body = fetch.calls[4]?.[1].body;
      const decodedBody =
        typeof body === "string"
          ? body
          : body instanceof Uint8Array
            ? new TextDecoder().decode(body)
            : "";
      // @effect-diagnostics-next-line preferSchemaOverJson:off - verifies the raw request body.
      expect(JSON.parse(decodedBody)).toEqual(command);
    }),
  );
});

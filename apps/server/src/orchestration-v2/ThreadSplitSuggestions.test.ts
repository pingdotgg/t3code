import { assert, it } from "@effect/vitest";
import {
  ThreadId,
  ProjectId,
  ProviderInstanceId,
  MessageId,
  DEFAULT_SERVER_SETTINGS,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Orchestrator from "./Orchestrator.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Suggestions from "./ThreadSplitSuggestions.ts";
import type { ProjectionRecords, ProjectionRecordField } from "./ProjectionStore.ts";

const threadId = ThreadId.make("split-test");
const input = { threadId, message: "What is the capital of France?" };
function source() {
  const now = DateTime.makeUnsafe("2026-11-03T00:00:00Z");
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project"),
    title: "Tests",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    forkedFrom: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    deletedAt: null,
    settledAt: null,
    settledOverride: null,
    lastVisitedAt: null,
    createdBy: "user",
    creationSource: "web",
  };
  const messages: OrchestrationV2ConversationMessage[] = ["user", "assistant"].map((role, i) => ({
    id: MessageId.make(`message-${i}`),
    threadId,
    runId: null,
    nodeId: null,
    role: role as "user" | "assistant",
    text: i === 0 ? "Run the tests." : "The parser tests passed.",
    context: undefined,
    attachments: [],
    streaming: false,
    createdAt: now,
    updatedAt: now,
    createdBy: i === 0 ? "user" : "agent",
    creationSource: "web",
  }));
  return { thread, messages, runs: [] };
}

it.effect("abstains for disabled, unsafe endpoints, truncated replies and stale history", () =>
  Effect.gen(function* () {
    for (const scenario of [
      "disabled",
      "remote",
      "header",
      "body",
      "wrong-model",
      "invalid",
      "stale",
      "context",
      "empty-context",
      "valid",
    ] as const) {
      const records = source();
      if (scenario === "context" || scenario === "empty-context")
        records.messages[0] = {
          ...records.messages[0]!,
          context: {
            version: 1,
            records: scenario === "context" ? [{ kind: "file", contextId: "file-1" }] : [],
          } as unknown as OrchestrationV2ConversationMessage["context"],
        };
      let requests = 0;
      const client = HttpClient.make((request) =>
        Effect.sync(() => {
          requests++;
          if (scenario === "stale")
            records.thread = {
              ...records.thread,
              updatedAt: DateTime.makeUnsafe("2026-11-03T01:00:00Z"),
            };
          return HttpClientResponse.fromWeb(
            request,
            Response.json(
              {
                model: scenario === "wrong-model" ? "other" : "pplx-decider-flash-v1.2",
                answers: { q: { type: "noul", noul: scenario === "invalid" ? 2 : 0.98 } },
                truncated: scenario === "body",
              },
              { headers: scenario === "header" ? { "x-mlx-decision-truncated": "true" } : {} },
            ),
          );
        }),
      );
      const layer = Suggestions.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(Orchestrator.OrchestratorV2)({
              getMessageCount: () => Effect.succeed(2),
              getThreadRecords: <K extends ProjectionRecordField>() =>
                Effect.sync(() => ({ ...records }) as unknown as ProjectionRecords<K>),
            }),
            ServerSettings.layerTest({
              threadSplitSuggestionsEnabled: scenario !== "disabled",
              threadSplitModelEndpoint:
                scenario === "remote"
                  ? "https://example.com/v1/systemone"
                  : "http://127.0.0.1:8000/v1/systemone",
            }),
            Layer.succeed(HttpClient.HttpClient, client),
          ),
        ),
      );
      const result = yield* Effect.gen(function* () {
        return yield* (yield* Suggestions.ThreadSplitSuggestions).suggest(input);
      }).pipe(Effect.provide(layer));
      assert.equal(result.suggest, scenario === "valid" || scenario === "empty-context", scenario);
      assert.equal(
        requests,
        scenario === "disabled" || scenario === "remote" || scenario === "context" ? 0 : 1,
        scenario,
      );
    }
  }),
);

it.effect("does not queue a second model request while one is in flight", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const records = source();
    let calls = 0;
    const client = HttpClient.make((request) =>
      Effect.gen(function* () {
        calls++;
        yield* Deferred.succeed(entered, undefined);
        yield* Deferred.await(release);
        return HttpClientResponse.fromWeb(
          request,
          Response.json({
            model: "pplx-decider-flash-v1.2",
            answers: { q: { type: "noul", noul: 0.98 } },
          }),
        );
      }),
    );
    const layer = Suggestions.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({
            getMessageCount: () => Effect.succeed(2),
            getThreadRecords: <K extends ProjectionRecordField>() =>
              Effect.succeed(records as unknown as ProjectionRecords<K>),
          }),
          ServerSettings.layerTest({
            ...DEFAULT_SERVER_SETTINGS,
            threadSplitSuggestionsEnabled: true,
            threadSplitModelEndpoint: "http://127.0.0.1:8000/v1/systemone",
          }),
          Layer.succeed(HttpClient.HttpClient, client),
        ),
      ),
    );
    yield* Effect.gen(function* () {
      const service = yield* Suggestions.ThreadSplitSuggestions;
      const first = yield* service.suggest(input).pipe(Effect.forkChild);
      yield* Deferred.await(entered);
      assert.deepEqual(yield* service.suggest(input), { suggest: false });
      yield* TestClock.adjust("15 seconds");
      assert.deepEqual(yield* Fiber.join(first), { suggest: false });
      yield* Deferred.succeed(release, undefined);
      assert.deepEqual(yield* service.suggest(input), { suggest: true });
      assert.equal(calls, 2);
    }).pipe(Effect.provide(layer));
  }),
);

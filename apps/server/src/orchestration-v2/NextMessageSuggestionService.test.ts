import { assert, describe, it, vi } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  TextGenerationError,
  ThreadId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as NextMessageSuggestionService from "./NextMessageSuggestionService.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const projectId = ProjectId.make("project:next-message");
const threadId = ThreadId.make("thread:next-message");
const environmentModel = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4-mini" };
const projectModel = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "haiku" };
const now = DateTime.makeUnsafe("2026-10-24T00:00:00.000Z");
const firstRunId = RunId.make("run:next-message:1");
const nextRunId = RunId.make("run:next-message:2");

function message(
  role: "user" | "assistant",
  text: string,
  options: { readonly streaming?: boolean } = {},
): OrchestrationV2ConversationMessage {
  return {
    id: MessageId.make(`message:${role}:${text}`),
    threadId,
    runId: null,
    nodeId: null,
    role,
    text,
    attachments: [],
    streaming: options.streaming ?? false,
    createdBy: role === "user" ? "user" : "agent",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
  };
}

function run(
  id: RunId,
  ordinal: number,
  status: OrchestrationV2Run["status"],
): Pick<OrchestrationV2Run, "id" | "ordinal" | "status"> {
  return { id, ordinal, status };
}

const request = message("user", "Fix the build");
const reply = message("assistant", "Fixed it. Should I run the full suite?");
const completedRun = run(firstRunId, 1, "completed");

function makeLayer(input: {
  readonly settings?: Parameters<typeof ServerSettings.layerTest>[0];
  readonly messages: ReadonlyArray<OrchestrationV2ConversationMessage>;
  readonly runs?: ReadonlyArray<Pick<OrchestrationV2Run, "id" | "ordinal" | "status">>;
  readonly worktreePath?: string | null;
  readonly generate?: TextGeneration.TextGeneration["Service"]["generateNextMessageSuggestion"];
}) {
  const thread = { messages: input.messages, runs: input.runs ?? [completedRun] };
  const generateNextMessageSuggestion = vi.fn(
    input.generate ?? (() => Effect.succeed({ suggestion: "Run the full suite" })),
  );
  const layer = NextMessageSuggestionService.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        ServerSettings.layerTest(input.settings),
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadRecords: (requestedThreadId) =>
            requestedThreadId === threadId
              ? Effect.succeed({
                  thread: { projectId, worktreePath: input.worktreePath ?? null },
                  messages: thread.messages,
                  runs: thread.runs,
                } as unknown as Effect.Success<
                  ReturnType<
                    ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"]
                  >
                >)
              : Effect.die(`unexpected thread ${requestedThreadId}`),
        }),
        Layer.mock(ProjectStore.ProjectStoreV2)({
          get: (requestedProjectId) =>
            Effect.succeed(
              requestedProjectId === projectId
                ? Option.some({ workspaceRoot: "/repo" } as never)
                : Option.none(),
            ),
        }),
        Layer.mock(TextGeneration.TextGeneration)({ generateNextMessageSuggestion }),
      ),
    ),
  );
  return { layer, thread, generateNextMessageSuggestion };
}

const suggest = (afterMessageId: MessageId) =>
  NextMessageSuggestionService.NextMessageSuggestionService.use((service) =>
    service.suggest({ threadId, afterMessageId }),
  );

const enabled = {
  nextMessageSuggestionsEnabled: true,
  textGenerationModelSelection: environmentModel,
};

describe("NextMessageSuggestionService", () => {
  it.effect("refuses to run a model while suggestions are off", () => {
    const { layer, generateNextMessageSuggestion } = makeLayer({ messages: [request, reply] });
    return Effect.gen(function* () {
      const error = yield* suggest(reply.id).pipe(Effect.flip);
      assert.strictEqual(error.reason, "disabled");
      assert.strictEqual(generateNextMessageSuggestion.mock.calls.length, 0);
    }).pipe(Effect.provide(layer));
  });

  it.effect("suggests a reply to the agent from the thread with the project's model", () => {
    const { layer, generateNextMessageSuggestion } = makeLayer({
      settings: {
        ...enabled,
        projectSettingsOverrides: { [projectId]: { textGenerationModelSelection: projectModel } },
      },
      worktreePath: "/repo/.worktrees/fix-build",
      messages: [request, reply],
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* suggest(reply.id), { suggestion: "Run the full suite" });
      const [generation] = generateNextMessageSuggestion.mock.calls[0]!;
      assert.strictEqual(generation.cwd, "/repo/.worktrees/fix-build");
      assert.deepStrictEqual(generation.modelSelection, projectModel);
      assert.include(generation.threadContext, "USER:\nFix the build");
      assert.include(
        generation.threadContext,
        "ASSISTANT:\nFixed it. Should I run the full suite?",
      );
    }).pipe(Effect.provide(layer));
  });

  it.effect("runs in the project root with the environment's model by default", () => {
    const { layer, generateNextMessageSuggestion } = makeLayer({
      settings: enabled,
      messages: [request, reply],
    });
    return Effect.gen(function* () {
      yield* suggest(reply.id);
      const [generation] = generateNextMessageSuggestion.mock.calls[0]!;
      assert.strictEqual(generation.cwd, "/repo");
      assert.strictEqual(generation.modelSelection.instanceId, environmentModel.instanceId);
      assert.strictEqual(generation.modelSelection.model, environmentModel.model);
    }).pipe(Effect.provide(layer));
  });

  it.effect("suggests nothing unless the reply is the last message of a completed turn", () =>
    Effect.gen(function* () {
      for (const { messages, runs } of [
        { messages: [request, reply, message("user", "Also update the docs")] },
        {
          messages: [
            request,
            reply,
            message("assistant", "Running the suite", { streaming: true }),
          ],
        },
        { messages: [request] },
        { messages: [request, reply], runs: [run(firstRunId, 1, "running")] },
        { messages: [request, reply], runs: [run(firstRunId, 1, "interrupted")] },
        { messages: [request, reply], runs: [completedRun, run(nextRunId, 2, "starting")] },
      ]) {
        const { layer, generateNextMessageSuggestion } = makeLayer({
          settings: enabled,
          messages,
          ...(runs === undefined ? {} : { runs }),
        });
        const result = yield* suggest(reply.id).pipe(Effect.provide(layer));
        assert.deepStrictEqual(result, { suggestion: "" });
        assert.strictEqual(generateNextMessageSuggestion.mock.calls.length, 0);
      }
    }),
  );

  it.effect("asks once the run completes when earlier requests found it unfinished", () => {
    const { layer, thread, generateNextMessageSuggestion } = makeLayer({
      settings: enabled,
      messages: [request, { ...reply, streaming: true }],
      runs: [run(firstRunId, 1, "running")],
    });
    return Effect.gen(function* () {
      assert.deepStrictEqual(yield* suggest(reply.id), { suggestion: "" });
      thread.messages = [request, reply];
      assert.deepStrictEqual(yield* suggest(reply.id), { suggestion: "" });
      thread.runs = [completedRun];
      assert.deepStrictEqual(yield* suggest(reply.id), { suggestion: "Run the full suite" });
      assert.strictEqual(generateNextMessageSuggestion.mock.calls.length, 1);
    }).pipe(Effect.provide(layer));
  });

  it.effect("asks the model once per reply however many clients request it", () => {
    const { layer, thread, generateNextMessageSuggestion } = makeLayer({
      settings: enabled,
      messages: [request, reply],
    });
    return Effect.gen(function* () {
      yield* Effect.all([suggest(reply.id), suggest(reply.id)], { concurrency: "unbounded" });
      yield* suggest(reply.id);
      assert.strictEqual(generateNextMessageSuggestion.mock.calls.length, 1);

      const nextReply = message("assistant", "The suite passes.");
      thread.messages = [...thread.messages, message("user", "Yes"), nextReply];
      thread.runs = [completedRun, run(nextRunId, 2, "completed")];
      yield* suggest(nextReply.id);
      assert.strictEqual(generateNextMessageSuggestion.mock.calls.length, 2);
    }).pipe(Effect.provide(layer));
  });

  it.effect("reports a provider failure and asks again on the next request", () => {
    const { layer, generateNextMessageSuggestion } = makeLayer({
      settings: enabled,
      messages: [request, reply],
      generate: () =>
        Effect.fail(
          new TextGenerationError({
            operation: "generateNextMessageSuggestion",
            detail: "Codex exited with code 1.",
          }),
        ),
    });
    return Effect.gen(function* () {
      const error = yield* suggest(reply.id).pipe(Effect.flip);
      assert.strictEqual(error.reason, "generation-failed");
      assert.strictEqual(error.threadId, threadId);
      yield* suggest(reply.id).pipe(Effect.flip);
      assert.strictEqual(generateNextMessageSuggestion.mock.calls.length, 2);
    }).pipe(Effect.provide(layer));
  });
});

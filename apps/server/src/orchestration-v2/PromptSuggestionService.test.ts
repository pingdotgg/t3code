import { it as effectIt } from "@effect/vitest";
import {
  MessageId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  type OrchestrationV2ThreadProjection,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { describe, expect, it } from "vite-plus/test";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "./ProjectStore.ts";
import {
  PromptSuggestionService,
  layer as promptSuggestionLayer,
  selectPromptSuggestionContext,
} from "./PromptSuggestionService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const message = (
  id: string,
  role: "user" | "assistant" | "system",
  text: string,
  options: { readonly streaming?: boolean; readonly runId?: string } = {},
) => ({
  id: MessageId.make(id),
  role,
  text,
  streaming: options.streaming ?? false,
  runId: options.runId === undefined ? null : RunId.make(options.runId),
});

describe("selectPromptSuggestionContext", () => {
  it("suggests after a settled agent reply, with the user's latest messages oldest first", () => {
    const context = selectPromptSuggestionContext(
      [
        message("u1", "user", "first"),
        message("a1", "assistant", "one"),
        message("u2", "user", "second"),
        message("u3", "user", "   "),
        message("u4", "user", "third"),
        message("u5", "user", "fourth"),
        message("u6", "user", "fifth"),
        message("a2", "assistant", "  Want me to open a PR?  "),
      ],
      [],
    );
    expect(context).toEqual({
      messageId: MessageId.make("a2"),
      lastAssistantMessage: "Want me to open a PR?",
      recentUserMessages: ["second", "third", "fourth", "fifth"],
    });
  });

  it("ignores turns the user rolled back", () => {
    const context = selectPromptSuggestionContext(
      [
        message("u1", "user", "add dark mode", { runId: "run-1" }),
        message("a1", "assistant", "Added dark mode.", { runId: "run-1" }),
        message("u2", "user", "delete the tests", { runId: "run-2" }),
        message("a2", "assistant", "Deleted them.", { runId: "run-2" }),
      ],
      [
        { id: RunId.make("run-1"), status: "completed" },
        { id: RunId.make("run-2"), status: "rolled_back" },
      ],
    );
    expect(context).toEqual({
      messageId: MessageId.make("a1"),
      lastAssistantMessage: "Added dark mode.",
      recentUserMessages: ["add dark mode"],
    });
  });

  it("does not suggest while the agent is still replying", () => {
    expect(
      selectPromptSuggestionContext(
        [
          message("u1", "user", "go"),
          message("a1", "assistant", "Working on", { streaming: true }),
        ],
        [],
      ),
    ).toBeNull();
  });

  it("does not suggest when the user already spoke last", () => {
    expect(
      selectPromptSuggestionContext(
        [message("a1", "assistant", "Done."), message("u1", "user", "now commit it")],
        [],
      ),
    ).toBeNull();
  });

  it("does not suggest from an empty agent reply", () => {
    expect(selectPromptSuggestionContext([message("a1", "assistant", "  ")], [])).toBeNull();
    expect(selectPromptSuggestionContext([], [])).toBeNull();
  });
});

describe("PromptSuggestionService", () => {
  const threadId = ThreadId.make("thread:suggest");
  const projectId = ProjectId.make("project:suggest");
  const reply = message("a1", "assistant", "Tests pass. Want me to open a PR?");
  const records = {
    thread: { projectId, worktreePath: null } as OrchestrationV2ThreadProjection["thread"],
    messages: [message("u1", "user", "fix the flaky test"), reply],
    runs: [],
  };

  effectIt.effect("shares one model call between viewers asking about the same reply", () =>
    Effect.gen(function* () {
      const release = yield* Deferred.make<void>();
      let calls = 0;
      const layer = promptSuggestionLayer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ThreadManagement.ThreadManagementService)({
              getThreadRecords: (() =>
                Effect.succeed(
                  records,
                )) as ThreadManagement.ThreadManagementService["Service"]["getThreadRecords"],
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({
              get: () =>
                Effect.succeed(
                  Option.some({
                    projectId,
                    title: "Project",
                    workspaceRoot: "/repo",
                    defaultModelSelection: null,
                    defaultThreadEnvMode: null,
                    autoPull: false,
                    faviconPath: null,
                    projectIcon: null,
                    scripts: [],
                    createdAt: "2026-10-19T00:00:00.000Z",
                    updatedAt: "2026-10-19T00:00:00.000Z",
                    deletedAt: null,
                  }),
                ),
            }),
            ServerSettings.layerTest({ promptSuggestionsEnabled: true }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
            Layer.mock(TextGeneration.TextGeneration)({
              generatePromptSuggestion: () =>
                Effect.sync(() => {
                  calls += 1;
                }).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.as({ suggestion: "Open a PR" }),
                ),
            }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const service = yield* PromptSuggestionService;
        const input = { threadId, afterMessageId: reply.id };
        const first = yield* Effect.forkChild(service.suggestNextPrompt(input));
        const second = yield* Effect.forkChild(service.suggestNextPrompt(input));
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(first)).toEqual({ suggestion: "Open a PR" });
        expect(yield* Fiber.join(second)).toEqual({ suggestion: "Open a PR" });
        expect(yield* service.suggestNextPrompt(input)).toEqual({ suggestion: "Open a PR" });
        expect(calls).toBe(1);
      }).pipe(Effect.provide(layer));
    }),
  );
});

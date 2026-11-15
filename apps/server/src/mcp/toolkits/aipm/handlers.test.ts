import { describe, expect, it } from "@effect/vitest";
import {
  type AiPmIdea,
  AiPmError,
  type AiPmSaveIdeaInput,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import type { Tool } from "effect/ai";

import * as AiPmService from "../../../aiPm/AiPmService.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolAccessTestkit from "../../McpToolAccess.testkit.ts";
import * as AipmHandlers from "./handlers.ts";
import { AipmToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:caller");
const environmentId = EnvironmentId.make("environment:aipm");

const idea: AiPmIdea = {
  id: "ai-delivery-factory",
  title: "AI Delivery Factory",
  status: "parked",
  summary: "",
  next: "",
  project: null,
  threads: [],
  files: [],
  created: "2026-10-19",
  updated: "2026-10-19",
};

type AipmTools = typeof AipmToolkit.tools;

const callTool = <Name extends keyof AipmTools>(
  name: Name,
  params: Tool.ParametersEncoded<AipmTools[Name]>,
  aiPm: Partial<AiPmService.AiPmService["Service"]>,
) =>
  Effect.gen(function* () {
    const dependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "session",
        thread: {
          threadId,
          providerSessionId: "session",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        issuedAt: 0,
        capabilities: new Set(["orchestration" as const]),
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: (id) =>
          Effect.succeed(
            id === "thread:missing"
              ? null
              : { ...McpToolAccessTestkit.liveThreadShell(id), title: `Title of ${id}` },
          ),
      }),
      Layer.mock(AiPmService.AiPmService)(aiPm),
    );
    const toolkit = yield* AipmToolkit.pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(AipmHandlers.layer).pipe(Layer.provide(dependencies)),
      ),
    );
    const results = yield* toolkit
      .handle(name, params as Parameters<typeof toolkit.handle<Name>>[1])
      .pipe(Stream.unwrap, Stream.runCollect, Effect.provide(dependencies));
    return results.at(-1)?.result as Record<string, unknown>;
  });

describe("AI PM idea tools", () => {
  it.effect("park links the calling thread and other threads with titles and environment", () => {
    const saved: Array<{ input: AiPmSaveIdeaInput; mergeLinks: boolean }> = [];
    return Effect.gen(function* () {
      yield* callTool(
        "aipm_idea_save",
        {
          title: "AI Delivery Factory",
          summary: "Three concepts, a wizard prototype.",
          next: "Pick a concept",
          files: ["/work/wizard.html"],
          otherThreadIds: [ThreadId.make("thread:other"), threadId],
        },
        {
          saveIdea: (input, options) => {
            saved.push({ input, mergeLinks: options.mergeLinks });
            return Effect.succeed(idea);
          },
        },
      );
      expect(saved).toEqual([
        {
          mergeLinks: true,
          input: {
            title: "AI Delivery Factory",
            summary: "Three concepts, a wizard prototype.",
            next: "Pick a concept",
            threads: [
              { id: threadId, title: "Title of thread:caller", environment: environmentId },
              { id: "thread:other", title: "Title of thread:other", environment: environmentId },
            ],
            files: [{ path: "/work/wizard.html" }],
          },
        },
      ]);
    });
  });

  it.effect("refuses a missing linked thread without saving", () => {
    let saves = 0;
    return Effect.gen(function* () {
      const result = yield* callTool(
        "aipm_idea_save",
        {
          title: "Idea",
          summary: "",
          next: "",
          otherThreadIds: [ThreadId.make("thread:missing")],
        },
        {
          saveIdea: () => {
            saves++;
            return Effect.succeed(idea);
          },
        },
      );
      expect(result).toMatchObject({ code: "thread_not_found" });
      expect(saves).toBe(0);
    });
  });

  it.effect("reports an unknown idea as an invalid request", () =>
    Effect.gen(function* () {
      const result = yield* callTool(
        "aipm_idea_set_status",
        { id: "gone", status: "exploring" },
        { setIdeaStatus: () => Effect.fail(new AiPmError({ reason: "idea_not_found" })) },
      );
      expect(result).toMatchObject({ code: "invalid_request" });
    }),
  );
});

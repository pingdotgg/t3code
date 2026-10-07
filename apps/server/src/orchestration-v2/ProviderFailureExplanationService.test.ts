import { assert, describe, it, vi } from "@effect/vitest";
import {
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2TurnItem,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
  TextGenerationError,
  TurnItemId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as ProviderFailureExplanation from "./ProviderFailureExplanationService.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:explain");
const projectId = ProjectId.make("project:explain");
const runId = RunId.make("run:explain");
const otherRunId = RunId.make("run:other");
const instanceId = ProviderInstanceId.make("codex");

const failure = (message: string): OrchestrationV2ProviderFailure => ({
  class: "provider_error",
  message,
  code: "E_BOOM",
  retryable: false,
});

const item = (
  id: string,
  ordinal: number,
  fields: Record<string, unknown>,
  itemRunId: RunId | null = runId,
) =>
  ({
    id: TurnItemId.make(id),
    threadId,
    runId: itemRunId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal,
    status: "completed",
    title: null,
    startedAt: null,
    completedAt: null,
    updatedAt: "2026-10-07T00:00:00.000Z",
    ...fields,
  }) as unknown as OrchestrationV2TurnItem;

const modelSelection = { instanceId, model: "gpt-5.1-codex" } as const;

function makeHarness(options: {
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  readonly worktreePath?: string | null;
  readonly generate?: TextGeneration.TextGeneration["Service"]["explainProviderFailure"];
}) {
  const explainProviderFailure = vi.fn(
    options.generate ??
      (() => Effect.succeed({ summary: "The binary is missing.", likelyFix: "Install it." })),
  );
  const thread = {
    id: threadId,
    projectId,
    providerInstanceId: instanceId,
    modelSelection,
    runtimeMode: "full-access",
    worktreePath: options.worktreePath ?? null,
  };
  const layerThreads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadRecords: ((
      _threadId: ThreadId,
      _fields: unknown,
      filter?: { turnItemTypes?: ReadonlyArray<string>; turnItemRunId?: RunId },
    ) =>
      Effect.succeed({
        thread,
        turnItems: options.turnItems.filter(
          (candidate) =>
            (filter?.turnItemTypes === undefined ||
              filter.turnItemTypes.includes(candidate.type)) &&
            (filter?.turnItemRunId === undefined || candidate.runId === filter.turnItemRunId),
        ),
        runs: [{ id: runId, providerInstanceId: instanceId, modelSelection }],
        providerSessions: [{ providerInstanceId: instanceId, driver: "codex" }],
      })) as never,
  });
  const layerProjects = Layer.mock(ProjectStore.ProjectStoreV2)({
    get: () => Effect.succeed(Option.some({ projectId, workspaceRoot: "/repo" } as never)),
  });
  const layer = ProviderFailureExplanation.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        layerThreads,
        layerProjects,
        Layer.mock(TextGeneration.TextGeneration)({ explainProviderFailure }),
        ServerSettings.layerTest({
          textGenerationModelSelection: { instanceId: "claudeAgent", model: "claude-haiku" },
        }),
      ),
    ),
    Layer.orDie,
  );
  return { layer, explainProviderFailure };
}

const explain = Effect.gen(function* () {
  const service = yield* ProviderFailureExplanation.ProviderFailureExplanationService;
  return yield* service.explain({ threadId });
});

describe("formatProviderFailureContext", () => {
  const base = {
    providerInstanceId: "codex",
    driver: "codex",
    model: "gpt-5.1-codex",
    runtimeMode: "full-access",
    failure: failure("spawn codex ENOENT"),
    userMessage: "Fix the flaky test",
    items: [],
  } as const;

  it("lists the provider, failure, and last user message", () => {
    const context = ProviderFailureExplanation.formatProviderFailureContext(base);
    assert.include(context, "Provider instance: codex (driver codex)");
    assert.include(context, "Model: gpt-5.1-codex");
    assert.include(context, "Runtime mode: full-access");
    assert.include(context, "Class: provider_error");
    assert.include(context, "Code: E_BOOM");
    assert.include(context, "Provider marked retryable: no");
    assert.include(context, "Message: spawn codex ENOENT");
    assert.include(context, "Last user message of this run:\nFix the flaky test");
    assert.notInclude(context, "Recent activity");
  });

  it("reports provider retries", () => {
    const context = ProviderFailureExplanation.formatProviderFailureContext({
      ...base,
      retry: { attempt: 2, maxAttempts: 3, retryDelayMs: null },
    });
    assert.include(context, "Retried by the provider: attempt 2 of 3");
  });

  it("keeps the last ten non-message items as labels, never outputs or arguments", () => {
    const commands = Array.from({ length: 12 }, (_, index) =>
      item(`item:${index}`, index, {
        type: "command_execution",
        input: `API_KEY=hunter2 npm test --token=abc${index}`,
        output: "SECRET OUTPUT",
        exitCode: 1,
      }),
    );
    const context = ProviderFailureExplanation.formatProviderFailureContext({
      ...base,
      items: [
        item("item:msg", 0, {
          type: "assistant_message",
          text: "ASSISTANT TEXT",
          streaming: false,
        }),
        item("item:think", 1, { type: "reasoning", text: "REASONING TEXT", streaming: false }),
        ...commands,
        item("item:tool", 99, {
          type: "dynamic_tool",
          toolName: "web.fetch",
          input: { secret: 1 },
        }),
      ],
    });
    const lines = context.split("Recent activity in this run, oldest first:\n")[1]!.split("\n");
    assert.equal(lines.length, 10);
    assert.equal(lines[0], "- command_execution completed npm exit 1");
    assert.equal(lines.at(-1), "- dynamic_tool completed web.fetch");
    for (const leaked of ["hunter2", "abc", "SECRET OUTPUT", "ASSISTANT TEXT", "REASONING TEXT"]) {
      assert.notInclude(context, leaked);
    }
  });

  it("truncates the user message and bounds the whole context", () => {
    const context = ProviderFailureExplanation.formatProviderFailureContext({
      ...base,
      userMessage: "u".repeat(10_000),
      failure: failure("m".repeat(4_096)),
    });
    assert.isBelow(context.length, 12_001);
    assert.include(context, "[truncated]");
    assert.isBelow(context.indexOf("u".repeat(2_001)), 0);
  });
});

describe("ProviderFailureExplanationService", () => {
  it.effect("fails with a typed error when the thread has no provider failure", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        turnItems: [item("item:1", 1, { type: "assistant_message", text: "hi", streaming: false })],
      });
      const error = yield* explain.pipe(Effect.provide(harness.layer), Effect.flip);
      assert.equal(error._tag, "ProviderFailureExplanationError");
      assert.equal(error.reason, "no_failure");
      assert.equal(error.message, "This thread has no provider failure to explain.");
      assert.equal(harness.explainProviderFailure.mock.calls.length, 0);
    }),
  );

  it.effect("explains the latest error with the text generation model of the project", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        worktreePath: "/repo/.wt/feature",
        turnItems: [
          item("item:old-error", 1, { type: "error", failure: failure("old failure") }, otherRunId),
          item("item:user", 2, { type: "user_message", text: "Run the build" }),
          item("item:cmd", 3, { type: "command_execution", input: "pnpm build", exitCode: 2 }),
          item("item:new-error", 4, { type: "error", failure: failure("new failure") }),
        ],
      });
      const result = yield* explain.pipe(Effect.provide(harness.layer));

      assert.deepEqual(result, {
        failureMessage: "new failure",
        summary: "The binary is missing.",
        likelyFix: "Install it.",
      });
      const call = harness.explainProviderFailure.mock.calls[0]?.[0];
      assert.equal(call?.cwd, "/repo/.wt/feature");
      assert.equal(call?.modelSelection.instanceId, "claudeAgent");
      assert.equal(call?.modelSelection.model, "claude-haiku");
      assert.include(call?.context, "Message: new failure");
      assert.notInclude(call?.context, "old failure");
      assert.include(call?.context, "Last user message of this run:\nRun the build");
      assert.include(call?.context, "- command_execution completed pnpm exit 2");
      assert.include(call?.context, "(driver codex)");
    }),
  );

  it.effect("falls back to the workspace root and reports model failures", () =>
    Effect.gen(function* () {
      const harness = makeHarness({
        turnItems: [item("item:error", 1, { type: "error", failure: failure("boom") })],
        generate: () =>
          Effect.fail(
            new TextGenerationError({
              operation: "explainProviderFailure",
              detail: "Codex returned invalid structured output.",
            }),
          ),
      });
      const error = yield* explain.pipe(Effect.provide(harness.layer), Effect.flip);

      assert.equal(harness.explainProviderFailure.mock.calls[0]?.[0].cwd, "/repo");
      assert.equal(error.reason, "generation_failed");
      assert.include(error.message, "Codex returned invalid structured output.");
    }),
  );
});

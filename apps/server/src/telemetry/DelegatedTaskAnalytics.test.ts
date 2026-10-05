import { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProviderRegistry from "../provider/Services/ProviderRegistry.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import * as DelegatedTaskAnalytics from "./DelegatedTaskAnalytics.ts";

const parentThreadId = ThreadId.make("parent-private");

const subagentEvent = (status: string, origin = "app_owned") =>
  ({
    type: "subagent.updated",
    payload: {
      id: "task-private",
      threadId: parentThreadId,
      origin,
      status,
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-5-5",
      prompt: "secret task",
      completionWake: "always",
      startedAt: DateTime.makeUnsafe(0),
      completedAt: DateTime.makeUnsafe(90_000),
    },
  }) as never;

it.effect("records each delegated task's final outcome once, without ids or prompts", () => {
  const recorded: Array<{ event: string; properties: unknown }> = [];
  return Effect.gen(function* () {
    const analytics = yield* DelegatedTaskAnalytics.make;
    yield* analytics.onSubagent(subagentEvent("running"));
    yield* analytics.onSubagent(subagentEvent("completed", "provider_native"));
    yield* analytics.onSubagent(subagentEvent("completed"));
    yield* analytics.onSubagent(subagentEvent("completed"));
    expect(recorded).toEqual([
      {
        event: "mcp.delegated_task.finished",
        properties: {
          status: "completed",
          callerProvider: "codex",
          callerModel: "gpt-5.5",
          targetProvider: "claudeAgent",
          targetModel: "claude-opus-5-5",
          crossProvider: true,
          completionWake: "always",
          durationSeconds: 90,
        },
      },
    ]);
  }).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({
          getThreadShell: () =>
            Effect.succeed({
              modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.5" },
            } as never),
        }),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            {
              instanceId: ProviderInstanceId.make("codex"),
              driver: "codex",
              models: [{ slug: "gpt-5.5", isCustom: false }],
            } as never,
            {
              instanceId: ProviderInstanceId.make("claudeAgent"),
              driver: "claudeAgent",
              models: [{ slug: "claude-opus-5-5", isCustom: false }],
            } as never,
          ]),
        }),
        Layer.succeed(
          AnalyticsService.AnalyticsService,
          AnalyticsService.AnalyticsService.of({
            record: (event, properties) =>
              Effect.sync(() => void recorded.push({ event, properties })),
            flush: Effect.void,
          }),
        ),
      ),
    ),
  );
});

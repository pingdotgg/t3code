import {
  NodeId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RunId,
  type OrchestrationV2ProviderTurn,
  type ServerProvider,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as AnalyticsService from "./AnalyticsService.ts";
import { catalogModelLabel } from "./ProviderDimensions.ts";
import {
  ProviderTurnAnalytics,
  RequestUsageLedger,
  layer,
  providerTurnProperties,
  type ProviderTurnAnalyticsContext,
  type ProviderTurnSegment,
} from "./ProviderUsageAnalytics.ts";

const providers = [
  // Codex lists whatever its configured model provider serves, including private deployments.
  { driver: "codex", models: [{ slug: "gpt-6-sol" }, { slug: "acme-azure-deployment" }] },
  { driver: "claudeAgent", models: [{ slug: "claude-opus-5-5" }, { slug: "claude-haiku-4-5" }] },
  { driver: "opencode", models: [{ slug: "ollama/acme-internal" }] },
].map(
  ({ driver, models }) =>
    ({
      instanceId: ProviderInstanceId.make(driver),
      driver,
      models: models.map((model) => ({ ...model, isCustom: false })),
    }) as unknown as ServerProvider,
);
const label = (model: string) => catalogModelLabel(providers, model);

const at = (ms: number) => DateTime.makeUnsafe(ms);
const complete = (input: number, output: number, extra: Partial<TurnTokenUsage> = {}) =>
  ({
    usageStatus: "complete",
    usageScope: "main_agent",
    hasSubagents: false,
    inputTokens: input,
    outputTokens: output,
    ...extra,
  }) as TurnTokenUsage;

const turn = (
  id: string,
  usage: TurnTokenUsage | undefined,
  status: OrchestrationV2ProviderTurn["status"] = "completed",
): OrchestrationV2ProviderTurn => ({
  id: ProviderTurnId.make(id),
  providerThreadId: ProviderThreadId.make("provider-thread"),
  nodeId: NodeId.make(`node:${id}`),
  runAttemptId: null,
  nativeTurnRef: null,
  ordinal: 1,
  status,
  startedAt: at(1_000),
  completedAt: at(4_000),
  ...(usage === undefined ? {} : { turnTokenUsage: usage }),
});

const context = (
  runId: string,
  segment: ProviderTurnSegment,
  model = "gpt-6-sol",
): ProviderTurnAnalyticsContext => ({
  runId: RunId.make(runId),
  modelSelection: {
    instanceId: ProviderInstanceId.make("codex"),
    model,
    options: [{ id: "reasoningEffort", value: "xhigh" }],
  },
  runtimeMode: "full-access",
  interactionMode: "default",
  origin: { createdBy: "user", creationSource: "web", scheduled: false, subagent: false },
  segment,
});

const settled = (runId: string, childrenRunning = false) => ({
  runId: RunId.make(runId),
  status: "completed" as const,
  completedAt: at(9_000),
  childrenRunning,
});

describe("provider usage reporting", () => {
  it.effect(
    "records one request across a continuation, a child, a replay, and a late child",
    () => {
      const recorded: Array<readonly [string, unknown]> = [];
      const layerTest = layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(AnalyticsService.AnalyticsService)({
              record: (event, properties) =>
                Effect.sync(() => void recorded.push([event, properties])),
            }),
            Layer.mock(ProviderRegistry.ProviderRegistry)({
              getProviders: Effect.succeed(providers),
            }),
          ),
        ),
      );
      return Effect.gen(function* () {
        const analytics = yield* ProviderTurnAnalytics;
        const root = context("run-a", "initial");
        yield* analytics.runStarted({ runId: RunId.make("run-a"), driver: "codex", context: root });
        const first = { driver: "codex", context: root };
        const firstTurn = turn("root", complete(100, 10, { models: ["gpt-6-sol"] }));
        yield* analytics.turnCompleted({ ...first, providerTurn: firstTurn });
        yield* analytics.turnCompleted({ ...first, providerTurn: firstTurn });
        yield* analytics.turnCompleted({
          driver: "codex",
          context: context("run-a", "continuation"),
          providerTurn: turn("goal", complete(50, 5, { models: ["gpt-6-sol"] })),
        });
        yield* analytics.turnCompleted({
          driver: "codex",
          context: context("run-a", "native_child"),
          providerTurn: turn("child", complete(20, 2)),
        });
        yield* analytics.runSettled(settled("run-a"));
        yield* analytics.turnCompleted({
          driver: "codex",
          context: context("run-a", "native_child"),
          providerTurn: turn("late-child", complete(7, 1)),
        });
        yield* analytics.runSettled(settled("run-a"));
        yield* analytics.runStarted({
          runId: RunId.make("run-b"),
          driver: "codex",
          context: context("run-b", "initial"),
        });
        yield* analytics.runSettled(settled("run-b"));

        const requests = recorded.filter(([event]) => event === "provider.request.completed");
        expect(recorded.filter(([event]) => event === "provider.turn.completed")).toHaveLength(5);
        expect(requests).toHaveLength(2);
        // The whole payload: no run, turn, or thread ids, prompts, or raw model names.
        expect(requests[0]?.[1]).toEqual({
          reportVersion: 2,
          provider: "codex",
          requestKind: "user",
          terminalStatus: "completed",
          lifecycleObserved: true,
          model: "gpt-6-sol",
          effort: "xhigh",
          runtimeMode: "full-access",
          interactionMode: "default",
          createdBy: "user",
          creationSource: "web",
          scheduled: false,
          subagent: false,
          providerTurns: 2,
          continuations: 1,
          steeringRestarts: 0,
          usageStatus: "complete",
          inputTokens: 150,
          outputTokens: 15,
          nativeChildTurns: 1,
          childUsageStatus: "complete",
          childInputTokens: 20,
          childOutputTokens: 2,
          durationMs: 8_000,
        });
        expect(requests[1]?.[1]).toMatchObject({ providerTurns: 0, usageStatus: "unavailable" });
      }).pipe(Effect.provide(layerTest));
    },
  );

  it("keeps a request partial when its start, a steered segment, or a counter is missing", () => {
    const ledger = new RequestUsageLedger();
    ledger.start(RunId.make("restarted"), "codex", {
      ...context("restarted", "initial"),
      restartContinuation: true,
    });
    ledger.add({
      driver: "codex",
      context: context("restarted", "initial"),
      providerTurn: turn("after-restart", complete(10, 1)),
    });
    expect(ledger.settle(settled("restarted"), label)).toMatchObject({
      restartContinuation: true,
      lifecycleObserved: false,
      usageStatus: "partial",
      inputTokens: 10,
    });

    ledger.start(RunId.make("steered"), "claudeAgent", context("steered", "initial"));
    ledger.add({
      driver: "claudeAgent",
      context: context("steered", "initial"),
      providerTurn: turn(
        "steered-away",
        { usageStatus: "partial", usageScope: "main_agent", hasSubagents: false, outputTokens: 4 },
        "interrupted",
      ),
    });
    ledger.add({
      driver: "claudeAgent",
      context: context("steered", "steering_restart"),
      providerTurn: turn("steered-to", complete(30, 6)),
    });
    expect(ledger.settle(settled("steered"), label)).toMatchObject({
      usageStatus: "partial",
      steeringRestarts: 1,
      inputTokens: 30,
      outputTokens: 10,
    });

    ledger.start(RunId.make("silent"), "grok", context("silent", "initial"));
    ledger.add({
      driver: "grok",
      context: context("silent", "initial"),
      providerTurn: turn("silent", undefined),
    });
    const silent = ledger.settle(settled("silent", true), label);
    expect(silent).toMatchObject({
      usageStatus: "unavailable",
      childrenRunning: true,
      childUsageStatus: "unavailable",
    });
    expect(silent).not.toHaveProperty("outputTokens");
  });

  it("confirms only the models a provider reported", () => {
    const opus = context("models", "initial", "claude-opus-5-5");
    const properties = (usage: TurnTokenUsage | undefined) =>
      providerTurnProperties(
        { driver: "claudeAgent", context: opus, providerTurn: turn("t", usage) },
        label,
      );
    expect(properties(complete(1, 1, { models: ["claude-haiku-4-5-20251001"] }))).toMatchObject({
      model: "claude-opus-5-5",
      observedModel: "claude-haiku-4-5",
      mixedModels: false,
    });
    const unconfirmed = properties(complete(1, 1));
    expect(unconfirmed).toMatchObject({ model: "claude-opus-5-5" });
    expect(unconfirmed).not.toHaveProperty("mixedModels");
    expect(properties(complete(1, 1, { models: ["a", "b"] }))).toMatchObject({ mixedModels: true });

    const ledger = new RequestUsageLedger();
    ledger.start(RunId.make("mixed"), "codex", context("mixed", "initial"));
    ledger.add({
      driver: "codex",
      context: context("mixed", "initial"),
      providerTurn: turn("root", complete(1, 1, { models: ["gpt-6-sol"] })),
    });
    ledger.add({
      driver: "codex",
      context: context("mixed", "native_child"),
      providerTurn: turn("child", complete(1, 1, { models: ["gpt-6-luna"] })),
    });
    expect(ledger.settle(settled("mixed"), label)).toMatchObject({ mixedModels: true });
  });

  it("keeps zero, absent, local-command, and ledger usage distinct", () => {
    const properties = (usage: TurnTokenUsage | undefined) =>
      providerTurnProperties(
        { driver: "claudeAgent", context: context("z", "initial"), providerTurn: turn("t", usage) },
        label,
      );
    expect(properties(complete(0, 0))).toMatchObject({
      usageStatus: "complete",
      usageReported: true,
      inputTokens: 0,
      outputTokens: 0,
    });
    const absent = properties(undefined);
    expect(absent).toMatchObject({ usageStatus: "unavailable", usageReported: false });
    expect(absent).not.toHaveProperty("outputTokens");
    expect(
      properties(
        complete(0, 0, { localCommand: true, otherUsage: { inputTokens: 900, outputTokens: 80 } }),
      ),
    ).toMatchObject({ localCommand: true, otherInputTokens: 900, otherOutputTokens: 80 });
    expect(properties(complete(74_167, 236, { reasoningTokens: 30 }))).toMatchObject({
      outputTokens: 236,
      reasoningTokens: 30,
    });
  });

  it("reports routed catalog models and closed efforts only", () => {
    const routed = (model: string, variant: string) =>
      providerTurnProperties(
        {
          driver: "opencode",
          context: {
            modelSelection: {
              instanceId: ProviderInstanceId.make("opencode"),
              model,
              options: [{ id: "variant", value: variant }],
            },
          },
          providerTurn: turn("t", complete(1, 1, { models: [model] })),
        },
        label,
      );
    expect(routed("my-proxy/claude-opus-5-5", "high")).toMatchObject({
      model: "claude-opus-5-5",
      observedModel: "claude-opus-5-5",
      effort: "high",
    });
    for (const local of [
      routed("ollama/acme-internal", "secret-variant"),
      routed("acme-azure-deployment", "high"),
    ]) {
      expect(local).not.toHaveProperty("model");
      expect(local).not.toHaveProperty("observedModel");
    }
    expect(routed("ollama/acme-internal", "secret-variant")).not.toHaveProperty("effort");
  });
});

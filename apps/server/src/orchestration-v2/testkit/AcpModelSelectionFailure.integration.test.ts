import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
  type ProviderReplayEntry,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { TestClock } from "effect/testing";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import { AcpRegistryOrchestratorReplayHarness } from "../Adapters/AcpRegistryAdapterV2.testkit.ts";
import * as EffectWorker from "../EffectWorker.ts";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { materializeFixtureInput, projectionFor } from "./fixtures/shared.ts";
import {
  type OrchestratorV2ScenarioStep,
  runOrchestratorV2Scenario,
} from "./OrchestratorScenario.ts";
import * as ProviderReplayHarness from "./ProviderReplayHarness.ts";

const PROMPT = "Respond with the following text: fixture simple ok";
const SESSION_ID = "grok-replay-session-1";
const AGENT_REASON = "Invalid provider";

const selection = (model: string) =>
  ({ instanceId: ProviderInstanceId.make("acpRegistry"), model }) satisfies ModelSelection;

/** Session setup advertising one model select, as the issue's agent does. */
const sessionCreated: ProviderReplayEntry = {
  type: "emit_inbound",
  label: "session.created",
  frame: {
    kind: "response",
    method: "session/new",
    result: {
      sessionId: SESSION_ID,
      configOptions: [
        {
          id: "model",
          name: "Model",
          category: "model",
          type: "select",
          currentValue: "replay-model-a",
          options: [
            { value: "replay-model-a", name: "Model A" },
            { value: "replay-model-b", name: "Model B" },
          ],
        },
      ],
    },
  },
};

const modelWrite = (model: string): ProviderReplayEntry => ({
  type: "expect_outbound",
  label: "session.set_model",
  frame: {
    kind: "request",
    method: "session/set_config_option",
    params: { sessionId: SESSION_ID, configId: "model", value: model },
  },
});

const modelWriteRejected = (code: number, message: string): ProviderReplayEntry => ({
  type: "emit_inbound",
  label: "session.set_model.rejected",
  frame: { kind: "response", method: "session/set_config_option", error: { code, message } },
});

/**
 * The registry `simple` handshake with a model config option. `firstTurn`
 * replays the recorded prompt before the `after` entries.
 */
const readTranscript = (input: {
  readonly scenario: string;
  readonly firstTurn: boolean;
  readonly after: ReadonlyArray<ProviderReplayEntry>;
}) =>
  Effect.gen(function* () {
    const recorded = yield* readProviderReplayTranscript(
      new URL("./fixtures/simple/registry_transcript.ndjson", import.meta.url),
    );
    const labelIndex = (label: string) =>
      recorded.entries.findIndex((entry) => "label" in entry && entry.label === label);
    // The prompt's instruction blocks are not under test, only the replies.
    const firstTurn: ReadonlyArray<ProviderReplayEntry> = input.firstTurn
      ? [
          {
            type: "expect_outbound",
            label: "session.prompt",
            frame: {
              kind: "request",
              method: "session/prompt",
              params: { sessionId: SESSION_ID, prompt: "<any>" },
            },
          },
          ...recorded.entries.slice(
            labelIndex("session.prompt") + 1,
            labelIndex("prompt.completed") + 1,
          ),
        ]
      : [];
    return yield* AcpRegistryOrchestratorReplayHarness.decodeTranscript({
      ...recorded,
      scenario: input.scenario,
      entries: [
        ...recorded.entries.slice(0, labelIndex("session.new") + 1),
        sessionCreated,
        ...firstTurn,
        ...input.after,
      ],
    });
  });

/**
 * Runs one message per model against the replay agent and returns the thread's
 * runs and error items. A failed open is retried on a schedule, so a single
 * message runs the worker by hand and moves the test clock to each retry until
 * the last attempt settles the run, without sleeping. Several messages run the
 * worker in the background, which a completed turn needs to settle.
 */
const runMessages = (input: {
  readonly scenario: string;
  readonly firstTurn: boolean;
  readonly after: ReadonlyArray<ProviderReplayEntry>;
  readonly models: ReadonlyArray<string>;
}) =>
  Effect.gen(function* () {
    const transcript = yield* readTranscript(input);
    const workspace = yield* checkpointWorkspace(input.scenario);
    const materialized = yield* materializeFixtureInput({
      scenario: input.scenario,
      fixtureInput: { steps: input.models.map(() => ({ type: "message", text: PROMPT })) },
      driver: ProviderDriverKind.make("acpRegistry"),
      modelSelection: selection(input.models[0]!),
    });
    const driveRetries = input.models.length === 1;
    let messageIndex = 0;
    const steps = materialized.steps.flatMap((step): ReadonlyArray<OrchestratorV2ScenarioStep> => {
      // The hand-run worker settles the run, so the thread is never awaited idle.
      if (step.type !== "dispatch") return driveRetries ? [] : [step];
      if (step.command.type !== "message.dispatch") return [step];
      const modelSelection = selection(input.models[messageIndex++]!);
      return [{ ...step, command: { ...step.command, modelSelection } }];
    });
    const scenario = {
      name: input.scenario,
      transcript,
      commands: steps.flatMap((step) => (step.type === "dispatch" ? [step.command] : [])),
      steps,
      projectionThreadIds: materialized.projectionThreadIds,
      runtimePolicyOverride: { cwd: workspace },
    };
    const result = yield* (
      driveRetries
        ? Effect.gen(function* () {
            yield* runOrchestratorV2Scenario(scenario);
            const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
            for (let round = 0; round < 10; round++) {
              yield* worker.drain();
              const next = yield* worker.nextClaimableAt;
              if (Option.isNone(next)) break;
              const now = yield* DateTime.now;
              yield* TestClock.adjust(
                Math.max(0, DateTime.toEpochMillis(next.value) - DateTime.toEpochMillis(now)),
              );
            }
            return yield* runOrchestratorV2Scenario({ ...scenario, commands: [], steps: [] });
          })
        : runOrchestratorV2Scenario(scenario)
    ).pipe(
      Effect.provide(
        ProviderReplayHarness.layerProviderReplay(scenario, AcpRegistryOrchestratorReplayHarness, {
          runEffectWorker: !driveRetries,
        }),
      ),
    );
    const projection = projectionFor(result, input.scenario);
    return {
      runs: projection.runs,
      errors: projection.turnItems.flatMap((item) => (item.type === "error" ? [item] : [])),
    };
  });

const provideTestRuntime = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.scoped,
    provideDeterministicTestRuntime,
    Effect.provide(Layer.merge(IdAllocator.layer, NodeServices.layer)),
  );

describe("ACP model selection failure", () => {
  it.effect("names the model when the agent rejects it while the session opens", () =>
    Effect.gen(function* () {
      const { runs, errors } = yield* runMessages({
        scenario: "acp_model_rejected_on_open",
        firstTurn: false,
        after: [modelWrite("replay-model-b"), modelWriteRejected(-32602, AGENT_REASON)],
        models: ["replay-model-b"],
      });
      assert.equal(runs.at(-1)?.status, "failed");
      assert.equal(errors.length, 1);
      assert.equal(errors[0]?.title, "Provider session failed to open");
      assert.equal(
        errors[0]?.failure.message,
        'The agent did not accept the model "replay-model-b". Choose another model for this provider, then retry.',
      );
    }).pipe(provideTestRuntime),
  );

  it.effect("names the model when the session does not offer it", () =>
    Effect.gen(function* () {
      const { runs, errors } = yield* runMessages({
        scenario: "acp_model_not_offered_on_open",
        firstTurn: false,
        after: [],
        models: ["replay-model-missing"],
      });
      assert.equal(runs.at(-1)?.status, "failed");
      assert.equal(errors.length, 1);
      assert.equal(
        errors[0]?.failure.message,
        'The agent did not accept the model "replay-model-missing". Choose another model for this provider, then retry.',
      );
    }).pipe(provideTestRuntime),
  );

  it.effect("names the model when the agent rejects a switch between turns", () =>
    Effect.gen(function* () {
      const { runs, errors } = yield* runMessages({
        scenario: "acp_model_rejected_on_switch",
        firstTurn: true,
        after: [modelWrite("replay-model-b"), modelWriteRejected(-32602, AGENT_REASON)],
        models: ["replay-model-a", "replay-model-b"],
      });
      assert.deepEqual(
        runs.map((run) => run.status),
        ["completed", "failed"],
      );
      assert.equal(errors.length, 1);
      assert.equal(
        errors[0]?.failure.message,
        'The agent did not accept the model "replay-model-b". Choose another model for this provider, then retry.',
      );
    }).pipe(provideTestRuntime),
  );

  it.effect("keeps the open failure for a model write that needs sign-in", () =>
    Effect.gen(function* () {
      const { runs, errors } = yield* runMessages({
        scenario: "acp_model_write_needs_auth",
        firstTurn: false,
        after: [
          modelWrite("replay-model-b"),
          modelWriteRejected(-32000, "Authentication required"),
        ],
        models: ["replay-model-b"],
      });
      assert.equal(runs.at(-1)?.status, "failed");
      assert.equal(errors.length, 1);
      assert.match(
        errors[0]?.failure.message ?? "",
        /^Failed to open acpRegistry provider session \S+\.$/u,
      );
    }).pipe(provideTestRuntime),
  );
});

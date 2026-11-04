import { assert } from "@effect/vitest";
import type { ProviderReplayTranscript } from "@t3tools/contracts";

import type { OrchestratorV2ScenarioResult } from "../../OrchestratorScenario.ts";
import {
  assertBaseProjection,
  assertSemanticProjectionIntegrity,
  assertUserMessagesInclude,
  projectionFor,
} from "../shared.ts";
import { KIRO_EFFORT_LEVEL, KIRO_EFFORT_MODEL, KIRO_EFFORT_PROMPT } from "./input.ts";

interface ConfigOption {
  readonly id?: unknown;
  readonly currentValue?: unknown;
}
interface Frame {
  readonly kind?: unknown;
  readonly method?: unknown;
  readonly params?: {
    readonly configId?: unknown;
    readonly value?: unknown;
    readonly update?: {
      readonly sessionUpdate?: unknown;
      readonly configOptions?: ReadonlyArray<ConfigOption>;
    };
  };
  readonly result?: { readonly configOptions?: ReadonlyArray<ConfigOption> };
}

const effortOf = (configOptions: ReadonlyArray<ConfigOption> | undefined) =>
  configOptions?.find((option) => option.id === "effortLevel")?.currentValue;

/**
 * The turn runs at the thread's effort: T3 writes `effortLevel` only after
 * Kiro has advertised it for the written model, and Kiro reports the level
 * back before the prompt goes out.
 */
export function assertKiroEffortOutput(
  result: OrchestratorV2ScenarioResult,
  transcript: ProviderReplayTranscript,
) {
  assertBaseProjection({ result, transcript, runCount: 1, runStatuses: ["completed"] });
  const projection = projectionFor(result, transcript.scenario);
  assertSemanticProjectionIntegrity(projection);
  assertUserMessagesInclude(projection, [KIRO_EFFORT_PROMPT]);

  const frames = transcript.entries.flatMap((entry) =>
    entry.type === "expect_outbound" || entry.type === "emit_inbound"
      ? [{ direction: entry.type, frame: entry.frame as Frame }]
      : [],
  );
  const isWrite = (frame: Frame, configId: string) =>
    frame.kind === "request" &&
    frame.method === "session/set_config_option" &&
    frame.params?.configId === configId;
  const modelWrite = frames.findIndex(
    ({ direction, frame }) =>
      direction === "expect_outbound" &&
      isWrite(frame, "model") &&
      frame.params?.value === KIRO_EFFORT_MODEL,
  );
  const effortWrites = frames.flatMap(({ direction, frame }, index) =>
    direction === "expect_outbound" && isWrite(frame, "effortLevel")
      ? [{ index, value: frame.params?.value }]
      : [],
  );
  const prompt = frames.findIndex(
    ({ direction, frame }) => direction === "expect_outbound" && frame.method === "session/prompt",
  );
  assert.isAtLeast(modelWrite, 0, "the thread's model must be written");
  assert.deepEqual(
    effortWrites.map((write) => write.value),
    [KIRO_EFFORT_LEVEL],
  );
  const effortWrite = effortWrites[0]?.index ?? -1;
  assert.isAbove(effortWrite, modelWrite);
  assert.isBelow(effortWrite, prompt);

  // Kiro advertised the option for the written model before T3 wrote to it.
  const advertised = frames
    .slice(modelWrite, effortWrite)
    .some(
      ({ direction, frame }) =>
        direction === "emit_inbound" &&
        effortOf(frame.result?.configOptions ?? frame.params?.update?.configOptions) !== undefined,
    );
  assert.isTrue(advertised, "effortLevel must be written only after Kiro advertises it");
  // And reported the chosen level back before the prompt.
  const reported = frames
    .slice(effortWrite, prompt)
    .flatMap(({ direction, frame }) =>
      direction === "emit_inbound"
        ? [effortOf(frame.result?.configOptions ?? frame.params?.update?.configOptions)]
        : [],
    )
    .filter((value) => value !== undefined);
  assert.equal(reported.at(-1), KIRO_EFFORT_LEVEL);
  assert.equal(projection.runs[0]?.modelSelection.model, KIRO_EFFORT_MODEL);
}

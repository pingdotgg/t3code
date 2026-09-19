import { describe, expect, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { buildCheckpointDiffTargets } from "./checkpointDiff.ts";

const environmentId = EnvironmentId.make("environment-a");
const threadId = ThreadId.make("thread-a");

describe("buildCheckpointDiffTargets", () => {
  it("routes a single-turn first range through the turn diff query", () => {
    expect(
      buildCheckpointDiffTargets({
        environmentId,
        threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
        ignoreWhitespace: false,
      }),
    ).toEqual({
      fullThread: null,
      turn: {
        environmentId,
        input: {
          threadId,
          fromTurnCount: 0,
          toTurnCount: 1,
          ignoreWhitespace: false,
        },
      },
    });
  });

  it("routes a cumulative range past the first turn through the full-thread diff query", () => {
    expect(
      buildCheckpointDiffTargets({
        environmentId,
        threadId,
        fromTurnCount: 0,
        toTurnCount: 4,
        ignoreWhitespace: true,
      }),
    ).toEqual({
      fullThread: {
        environmentId,
        input: {
          threadId,
          toTurnCount: 4,
          ignoreWhitespace: true,
        },
      },
      turn: null,
    });
  });

  it("routes later ranges through the incremental turn diff query", () => {
    expect(
      buildCheckpointDiffTargets({
        environmentId,
        threadId,
        fromTurnCount: 3,
        toTurnCount: 4,
        ignoreWhitespace: false,
      }),
    ).toEqual({
      fullThread: null,
      turn: {
        environmentId,
        input: {
          threadId,
          fromTurnCount: 3,
          toTurnCount: 4,
          ignoreWhitespace: false,
        },
      },
    });
  });

  it("returns null targets when the selection is incomplete", () => {
    expect(
      buildCheckpointDiffTargets({
        environmentId: null,
        threadId,
        fromTurnCount: 0,
        toTurnCount: 1,
        ignoreWhitespace: false,
      }),
    ).toEqual({ fullThread: null, turn: null });
  });
});

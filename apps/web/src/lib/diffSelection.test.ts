import { EnvironmentId, ThreadId, TurnId } from "@forma/contracts";
import { describe, expect, it } from "vitest";
import type { DiffRouteSearch } from "../diffRouteSearch";
import type { TurnDiffSummary } from "../types";
import {
  orderTurnDiffSummariesByCheckpoint,
  resolveActiveCheckpointRange,
  resolveConversationCacheScope,
  resolveLikelyDiffPrefetchTarget,
} from "./diffSelection";

const environmentId = EnvironmentId.make("env-local");
const threadId = ThreadId.make("thread-local");

function createTurnDiffSummary(input: {
  turnId: string;
  completedAt: string;
  checkpointTurnCount?: number | undefined;
}): TurnDiffSummary {
  return {
    turnId: TurnId.make(input.turnId),
    completedAt: input.completedAt,
    files: [],
    ...(input.checkpointTurnCount !== undefined
      ? { checkpointTurnCount: input.checkpointTurnCount }
      : {}),
  };
}

describe("diffSelection", () => {
  it("resolves full conversation range when no turn is selected", () => {
    const orderedTurnDiffSummaries = orderTurnDiffSummariesByCheckpoint(
      [
        createTurnDiffSummary({
          turnId: "turn-1",
          completedAt: "2026-05-10T10:00:00.000Z",
          checkpointTurnCount: 1,
        }),
        createTurnDiffSummary({
          turnId: "turn-2",
          completedAt: "2026-05-10T11:00:00.000Z",
          checkpointTurnCount: 3,
        }),
      ],
      {},
    );

    expect(
      resolveActiveCheckpointRange({
        orderedTurnDiffSummaries,
        inferredCheckpointTurnCountByTurnId: {},
      }),
    ).toMatchObject({
      kind: "conversation",
      activeRange: {
        fromTurnCount: 0,
        toTurnCount: 3,
      },
      cacheScope: "conversation:turn-2,turn-1",
    });
  });

  it("resolves selected turn range from explicit checkpoint turn count", () => {
    const orderedTurnDiffSummaries = orderTurnDiffSummariesByCheckpoint(
      [
        createTurnDiffSummary({
          turnId: "turn-1",
          completedAt: "2026-05-10T10:00:00.000Z",
          checkpointTurnCount: 2,
        }),
      ],
      {},
    );

    expect(
      resolveActiveCheckpointRange({
        orderedTurnDiffSummaries,
        inferredCheckpointTurnCountByTurnId: {},
        selectedTurnId: TurnId.make("turn-1"),
      }),
    ).toMatchObject({
      kind: "turn",
      activeRange: {
        fromTurnCount: 1,
        toTurnCount: 2,
      },
      cacheScope: "turn:turn-1",
    });
  });

  it("resolves selected turn range from inferred checkpoint turn count", () => {
    const orderedTurnDiffSummaries = orderTurnDiffSummariesByCheckpoint(
      [
        createTurnDiffSummary({
          turnId: "turn-1",
          completedAt: "2026-05-10T10:00:00.000Z",
        }),
      ],
      {
        "turn-1": 4,
      },
    );

    expect(
      resolveActiveCheckpointRange({
        orderedTurnDiffSummaries,
        inferredCheckpointTurnCountByTurnId: {
          "turn-1": 4,
        },
        selectedTurnId: TurnId.make("turn-1"),
      }),
    ).toMatchObject({
      kind: "turn",
      activeRange: {
        fromTurnCount: 3,
        toTurnCount: 4,
      },
      cacheScope: "turn:turn-1",
    });
  });

  it("returns no prefetch target when there are no completed diffs", () => {
    const diffSearch: DiffRouteSearch = { panel: "1", panelView: "diff" };

    expect(
      resolveLikelyDiffPrefetchTarget({
        orderedTurnDiffSummaries: [],
        inferredCheckpointTurnCountByTurnId: {},
        diffSearch,
        environmentId,
        threadId,
      }),
    ).toBeNull();
  });

  it("keeps conversation cache scope stable for the same ordered turns", () => {
    const orderedTurnDiffSummaries = [
      createTurnDiffSummary({
        turnId: "turn-3",
        completedAt: "2026-05-10T12:00:00.000Z",
        checkpointTurnCount: 3,
      }),
      createTurnDiffSummary({
        turnId: "turn-2",
        completedAt: "2026-05-10T11:00:00.000Z",
        checkpointTurnCount: 2,
      }),
    ];

    expect(resolveConversationCacheScope(orderedTurnDiffSummaries)).toBe(
      resolveConversationCacheScope(orderedTurnDiffSummaries),
    );
  });
});

import type { ReplayFixture } from "./webAppReplayHarness/types.ts";
import {
  createBaseWebAppFixture,
  createCheckpointReplayState,
  createCheckpointSummaryInteractions,
  createSimpleDiffPatch,
  createTurnInteraction,
  createTwoTurnCheckpointSummaryInteractions,
} from "./webAppReplayHarness/testSupport/replayFixtureBuilders.ts";

const bootstrap = createBaseWebAppFixture();
const baseFixture = createBaseWebAppFixture();

const firstTurnPatch = createSimpleDiffPatch(
  "src/replay-harness.ts",
  "export const step = 0;",
  "export const step = 1;",
);
const secondTurnPatch = createSimpleDiffPatch(
  "src/replay-harness.ts",
  "export const step = 1;",
  "export const step = 2;",
);

const happyPath = {
  ...baseFixture,
  state: {
    ...baseFixture.state,
    ...createCheckpointReplayState(),
  },
  interactions: [
    ...baseFixture.interactions,
    createTurnInteraction(
      1,
      "Explain how the replay harness works.",
      "Replay harness response for the first message.\n",
    ),
    ...createCheckpointSummaryInteractions(firstTurnPatch),
  ],
} satisfies ReplayFixture;

const twoTurns = {
  ...baseFixture,
  state: {
    ...baseFixture.state,
    ...createCheckpointReplayState({ includeSecondTurn: true }),
  },
  interactions: [
    ...baseFixture.interactions,
    createTurnInteraction(1, "First question", "First assistant reply.\n"),
    createTurnInteraction(2, "Second question", "Second assistant reply.\n"),
    ...createTwoTurnCheckpointSummaryInteractions(firstTurnPatch, secondTurnPatch),
  ],
} satisfies ReplayFixture;

const providerOffline = {
  ...createBaseWebAppFixture(),
  providerStatuses: [
    {
      provider: "codex",
      status: "error",
      available: false,
      authStatus: "unauthenticated",
      message: "Codex unavailable",
      checkedAt: "2026-03-10T12:00:00.000Z",
    },
  ],
} satisfies ReplayFixture;

const fixtures: Record<string, ReplayFixture> = {
  bootstrap,
  happyPath,
  twoTurns,
  providerOffline,
};

export default fixtures;

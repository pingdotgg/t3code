import type { ReplayFixture } from "./webAppReplayHarness/types.ts";
import {
  createBaseWebAppFixture,
  createCheckpointReplayState,
  createCheckpointSummaryInteractions,
  createSimpleDiffPatch,
  createTurnInteraction,
  createWorktreeInteractions,
} from "./webAppReplayHarness/testSupport/replayFixtureBuilders.ts";

const worktreeTurnPatch = createSimpleDiffPatch(
  "src/worktree-example.ts",
  "export const env = \"local\";",
  "export const env = \"worktree\";",
);

const worktreeFlow = {
  ...createBaseWebAppFixture(),
  state: {
    ...createBaseWebAppFixture().state,
    ...createCheckpointReplayState(),
    worktreeReady: false,
  },
  interactions: [
    ...createBaseWebAppFixture().interactions,
    ...createWorktreeInteractions(),
    createTurnInteraction(
      1,
      "Run this in a worktree.",
      "Worktree thread created and response streamed.\n",
    ),
    ...createCheckpointSummaryInteractions(worktreeTurnPatch, {
      cwdRef: "state.worktreePath",
    }),
  ],
} satisfies ReplayFixture;

const fixtures: Record<string, ReplayFixture> = {
  worktreeFlow,
};

export default fixtures;

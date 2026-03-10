import type { ReplayFixture } from "./webAppReplayHarness/types.ts";
import {
  createBaseWebAppFixture,
  createCheckpointDiffInteractions,
  createCheckpointReplayState,
  createTurnInteraction,
} from "./webAppReplayHarness/testSupport/replayFixtureBuilders.ts";

const checkpointPatch = [
  "diff --git a/src/example.ts b/src/example.ts",
  "index 1111111..2222222 100644",
  "--- a/src/example.ts",
  "+++ b/src/example.ts",
  "@@ -1 +1 @@",
  "-export const answer = 41;",
  "+export const answer = 42;",
  "",
].join("\n");

const checkpointDiff = {
  ...createBaseWebAppFixture(),
  state: {
    ...createBaseWebAppFixture().state,
    ...createCheckpointReplayState({ includeDiffPanelQuery: true }),
  },
  interactions: [
    ...createBaseWebAppFixture().interactions,
    createTurnInteraction(
      1,
      "Update src/example.ts",
      "Updated src/example.ts with the requested change.\n",
    ),
    ...createCheckpointDiffInteractions(checkpointPatch),
  ],
} satisfies ReplayFixture;

const fixtures: Record<string, ReplayFixture> = {
  checkpointDiff,
};

export default fixtures;

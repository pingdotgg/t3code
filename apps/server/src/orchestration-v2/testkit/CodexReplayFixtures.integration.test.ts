import { describe } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { materializeReplayTranscriptWorkspace } from "@t3tools/provider-testing/replayTranscript";
import { CodexOrchestratorReplayHarness } from "../Adapters/CodexAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Codex replay fixtures", () => {
  itRunsReplayFixtures("codex", (input) =>
    runReplayFixture({
      ...input,
      harness: CodexOrchestratorReplayHarness,
      materializeWorkspace: (transcript, workspace) =>
        Effect.succeed(materializeReplayTranscriptWorkspace(transcript, workspace)),
    }),
  );
});

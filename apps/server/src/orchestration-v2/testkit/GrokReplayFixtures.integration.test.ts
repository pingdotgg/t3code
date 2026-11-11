import { describe } from "@effect/vitest";

import { GrokOrchestratorReplayHarness } from "../Adapters/GrokAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Grok replay fixtures", () => {
  itRunsReplayFixtures("grok", (input) =>
    runReplayFixture({ ...input, harness: GrokOrchestratorReplayHarness }),
  );
});

import { describe } from "@effect/vitest";

import { KiroOrchestratorReplayHarness } from "../Adapters/KiroAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Kiro replay fixtures", () => {
  itRunsReplayFixtures("kiro", (input) =>
    runReplayFixture({ ...input, harness: KiroOrchestratorReplayHarness }),
  );
});

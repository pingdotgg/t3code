import { describe } from "@effect/vitest";

import { FxOrchestratorReplayHarness } from "../Adapters/FxAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("fx replay fixtures", () => {
  itRunsReplayFixtures("fx", (input) =>
    runReplayFixture({ ...input, harness: FxOrchestratorReplayHarness }),
  );
});

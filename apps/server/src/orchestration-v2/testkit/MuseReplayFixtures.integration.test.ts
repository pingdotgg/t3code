import { describe } from "@effect/vitest";

import {
  materializeMuseReplayWorkspace,
  MuseOrchestratorReplayHarness,
} from "../Adapters/MuseAdapterV2.testkit.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("Muse replay fixtures", () => {
  itRunsReplayFixtures("muse", (input) =>
    runReplayFixture({
      ...input,
      harness: MuseOrchestratorReplayHarness,
      materializeWorkspace: materializeMuseReplayWorkspace,
    }),
  );
});

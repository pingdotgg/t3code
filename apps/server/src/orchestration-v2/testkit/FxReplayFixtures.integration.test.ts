import { describe } from "@effect/vitest";
import { FX_SUPPORTED_RUNTIME_MODES } from "@t3tools/provider-fx/testing";

import { FxOrchestratorReplayHarness } from "../Adapters/FxAdapterV2.testkit.ts";
import { providerRuntimeMode } from "../RuntimePolicy.ts";
import { itRunsReplayFixtures, runReplayFixture } from "./ProviderReplayFixtures.ts";

describe("fx replay fixtures", () => {
  // Recorded where fx's snapshot offers no Full access (0.0.13), so a thread
  // set to it runs as RuntimePolicy resolves it there: Supervised.
  itRunsReplayFixtures("fx", (input) =>
    runReplayFixture({
      ...input,
      buildInput: () => {
        const fixtureInput = input.buildInput();
        return {
          ...fixtureInput,
          runtimeMode: providerRuntimeMode(
            fixtureInput.runtimeMode ?? "full-access",
            FX_SUPPORTED_RUNTIME_MODES,
          ),
        };
      },
      harness: FxOrchestratorReplayHarness,
    }),
  );
});

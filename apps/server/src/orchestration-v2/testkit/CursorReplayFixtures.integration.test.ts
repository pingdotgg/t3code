import { describe, it } from "@effect/vitest";

import { CursorOrchestratorReplayHarness } from "../Adapters/CursorAdapterV2.testkit.ts";
import { messageRestartInput } from "./fixtures/message_steering/input.ts";
import {
  findReplayFixture,
  itRunsReplayFixtures,
  runReplayFixture,
} from "./ProviderReplayFixtures.ts";

describe("Cursor replay fixtures", () => {
  itRunsReplayFixtures("cursor", (input) =>
    runReplayFixture({ ...input, harness: CursorOrchestratorReplayHarness }),
  );

  const cursorSteeringProvider = findReplayFixture("message_steering")?.providers.find(
    (provider) => provider.driver === "cursor",
  );
  if (cursorSteeringProvider !== undefined) {
    it.effect("executes explicit Cursor restart_active through the recorded SDK boundary", () =>
      runReplayFixture({
        fixtureName: "message_steering",
        buildInput: messageRestartInput,
        driver: cursorSteeringProvider,
        harness: CursorOrchestratorReplayHarness,
      }),
    );
  }
});

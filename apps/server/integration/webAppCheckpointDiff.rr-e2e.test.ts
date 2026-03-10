import { describe, it } from "vitest";

import {
  chromiumInstalled,
  runReplayScenario,
  shouldRunReplayE2E,
} from "./webAppReplayHarness/testSupport/runReplayScenario.ts";
import { sendPromptInNewThread } from "./webAppReplayHarness/testSupport/threadScenarioHelpers.ts";

const RR_E2E_TIMEOUT_MS = 90_000;

describe("web app checkpoint diff rr e2e", () => {
  it.skipIf(!shouldRunReplayE2E || !chromiumInstalled)(
    "shows a checkpoint diff card for a completed turn",
    async () => {
      await runReplayScenario(import.meta.url, "checkpointDiff", async (app) => {
        await sendPromptInNewThread(
          app,
          "Update src/example.ts",
          "Updated src/example.ts with the requested change.",
        );

        await app.waitForTurnDiffCardText(/Changed files/i);
        await app.waitForTurnDiffCardText(/example\.ts/);
        await app.waitForTurnDiffCardText("View diff");
      });
    },
    RR_E2E_TIMEOUT_MS,
  );
});

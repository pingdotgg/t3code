import { describe, expect, it } from "vitest";

import {
  chromiumInstalled,
  runReplayScenario,
  shouldRunReplayE2E,
} from "./webAppReplayHarness/testSupport/runReplayScenario.ts";
import {
  completeTurn,
  createReadyThread,
} from "./webAppReplayHarness/testSupport/threadScenarioHelpers.ts";

const RR_E2E_TIMEOUT_MS = 90_000;

describe("web app worktree flow rr e2e", () => {
  it.skipIf(!shouldRunReplayE2E || !chromiumInstalled)(
    "creates a worktree on the first turn when new worktree mode is selected",
    async () => {
      await runReplayScenario(import.meta.url, "worktreeFlow", async (app) => {
        await createReadyThread(app);
        expect(await app.readEnvMode()).toBe("Local");

        await app.switchToWorktreeMode();
        await app.waitForBranchSelectorText(/From main/i);
        expect(await app.readEnvMode()).toBe("New worktree");

        await completeTurn(
          app,
          "Run this in a worktree.",
          "Worktree thread created and response streamed.",
        );

        expect(await app.readEnvMode()).toBe("Worktree");
      });
    },
    RR_E2E_TIMEOUT_MS,
  );
});

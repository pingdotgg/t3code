import type { BoatCloudStepProgress } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  completeStep,
  failProgress,
  markAcquired,
  startingProgress,
  withHolderSteps,
} from "./boatCloudStart.logic";

const states = (progress: ReturnType<typeof startingProgress>) =>
  Object.fromEntries(progress.steps.map((entry) => [entry.step, entry.state]));

const holderReport = (
  server: BoatCloudStepProgress["state"],
  repository: BoatCloudStepProgress["state"],
): ReadonlyArray<BoatCloudStepProgress> => [
  { step: "machine", state: "done", detail: "Using Boat cloud 1dca" },
  { step: "server", state: server, detail: null },
  { step: "repository", state: repository, detail: null },
];

describe("Boat cloud start progress", () => {
  it("connects while the checkout runs, and opens the project once both are done", () => {
    const reported = withHolderSteps(
      startingProgress("acme/app"),
      holderReport("active", "active"),
    );
    expect(reported.steps.find((entry) => entry.step === "repository")?.detail).toBe("acme/app");
    expect(reported.steps.find((entry) => entry.step === "machine")?.detail).toBe(
      "Using Boat cloud 1dca",
    );

    const connected = completeStep(markAcquired(reported), "connect");
    expect(states(connected)).toEqual({
      machine: "done",
      server: "done",
      repository: "active",
      connect: "done",
      project: "pending",
      thread: "pending",
    });
    expect(states(completeStep(connected, "repository"))).toMatchObject({ project: "active" });
  });

  it("fails what was running, keeping a failure the holder already reported", () => {
    const bothRunning = withHolderSteps(startingProgress(null), holderReport("active", "active"));
    expect(states(failProgress(bothRunning, "Boat did not answer in time."))).toMatchObject({
      server: "failed",
      repository: "failed",
      connect: "pending",
    });

    const cloneFailed = withHolderSteps(startingProgress(null), holderReport("active", "failed"));
    const failed = failProgress(cloneFailed, "Boat cannot clone acme/app.");
    expect(failed.error).toBe("Boat cannot clone acme/app.");
    expect(states(failed)).toMatchObject({ server: "pending", repository: "failed" });

    const pairingFailed = failProgress(
      markAcquired(startingProgress(null)),
      "Pairing expired.",
      "connect",
    );
    expect(states(pairingFailed)).toMatchObject({ repository: "pending", connect: "failed" });
  });
});

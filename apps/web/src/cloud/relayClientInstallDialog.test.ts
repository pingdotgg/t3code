import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  RelayClientInstallConfirmationConflictError,
  reportRelayClientInstallProgress,
  readRelayClientInstallDialogState,
  requestRelayClientInstallConfirmation,
  resetRelayClientInstallDialogForTests,
  respondToRelayClientInstallConfirmation,
} from "./relayClientInstallDialog";

describe("relay client install dialog coordinator", () => {
  beforeEach(() => {
    resetRelayClientInstallDialogForTests();
  });

  it("rejects concurrent confirmation with the active install state", async () => {
    const confirmation = requestRelayClientInstallConfirmation("2026.10.0");
    respondToRelayClientInstallConfirmation(true);
    await expect(confirmation).resolves.toBe(true);
    reportRelayClientInstallProgress({ type: "progress", stage: "downloading" });

    const error = await requestRelayClientInstallConfirmation("2026.11.0").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(RelayClientInstallConfirmationConflictError);
    expect(error).toMatchObject({
      requestedVersion: "2026.11.0",
      activeVersion: "2026.10.0",
      activeDialogStatus: "installing",
      activeInstallStage: "downloading",
    });
    expect(error).not.toHaveProperty("cause");
    expect((error as Error).message).toBe(
      "Cannot confirm relay client installation 2026.11.0; installation 2026.10.0 has dialog status installing.",
    );
  });

  it("retains download byte counts in the installing state", async () => {
    const confirmation = requestRelayClientInstallConfirmation("2026.11.0");
    respondToRelayClientInstallConfirmation(true);
    await expect(confirmation).resolves.toBe(true);

    reportRelayClientInstallProgress({
      type: "progress",
      stage: "downloading",
      downloadedBytes: 1024 * 1024,
      totalBytes: 2 * 1024 * 1024,
    });
    expect(readRelayClientInstallDialogState()).toMatchObject({
      status: "installing",
      stage: "downloading",
      downloadedBytes: 1024 * 1024,
      totalBytes: 2 * 1024 * 1024,
    });

    reportRelayClientInstallProgress({ type: "progress", stage: "verifying" });
    expect(readRelayClientInstallDialogState()).toMatchObject({
      status: "installing",
      stage: "verifying",
    });
    expect(readRelayClientInstallDialogState()).not.toHaveProperty("downloadedBytes");
  });
});

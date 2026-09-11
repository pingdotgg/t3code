import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  completeRelayClientInstallDialogClose,
  finishRelayClientInstall,
  readRelayClientInstallDialogState,
  RelayClientInstallConfirmationConflictError,
  reportRelayClientInstallProgress,
  requestRelayClientInstallConfirmation,
  resetRelayClientInstallDialogForTests,
  respondToRelayClientInstallConfirmation,
} from "./relayClientInstallDialog";

describe("relay client install dialog coordinator", () => {
  beforeEach(() => {
    resetRelayClientInstallDialogForTests();
  });

  it("moves a confirmed installation through streamed progress stages", async () => {
    const confirmation = requestRelayClientInstallConfirmation("2026.9.0");
    expect(readRelayClientInstallDialogState()).toEqual({
      status: "confirming",
      version: "2026.9.0",
    });

    respondToRelayClientInstallConfirmation(true);
    await expect(confirmation).resolves.toBe(true);
    expect(readRelayClientInstallDialogState()).toEqual({
      status: "installing",
      version: "2026.9.0",
      stage: "checking",
    });

    reportRelayClientInstallProgress({ type: "progress", stage: "downloading" });
    expect(readRelayClientInstallDialogState()).toEqual({
      status: "installing",
      version: "2026.9.0",
      stage: "downloading",
    });

    finishRelayClientInstall();
    expect(readRelayClientInstallDialogState()).toEqual({
      status: "closing",
      view: {
        status: "installing",
        version: "2026.9.0",
        stage: "downloading",
      },
    });

    completeRelayClientInstallDialogClose();
    expect(readRelayClientInstallDialogState()).toEqual({ status: "idle" });
  });

  it("returns to idle when installation is declined", async () => {
    const confirmation = requestRelayClientInstallConfirmation("2026.9.0");
    respondToRelayClientInstallConfirmation(false);

    await expect(confirmation).resolves.toBe(false);
    expect(readRelayClientInstallDialogState()).toEqual({
      status: "closing",
      view: {
        status: "confirming",
        version: "2026.9.0",
      },
    });

    completeRelayClientInstallDialogClose();
    expect(readRelayClientInstallDialogState()).toEqual({ status: "idle" });
  });

  it("rejects concurrent confirmation with the active install state", async () => {
    const confirmation = requestRelayClientInstallConfirmation("2026.9.0");
    respondToRelayClientInstallConfirmation(true);
    await expect(confirmation).resolves.toBe(true);
    reportRelayClientInstallProgress({ type: "progress", stage: "downloading" });

    const error = await requestRelayClientInstallConfirmation("2026.10.0").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(RelayClientInstallConfirmationConflictError);
    expect(error).toMatchObject({
      requestedVersion: "2026.10.0",
      activeVersion: "2026.9.0",
      activeDialogStatus: "installing",
      activeInstallStage: "downloading",
    });
    expect(error).not.toHaveProperty("cause");
    expect((error as Error).message).toBe(
      "Cannot confirm relay client installation 2026.10.0; installation 2026.9.0 has dialog status installing.",
    );
  });
});

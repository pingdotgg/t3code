import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import {
  RelayClientInstallConfirmationConflictError,
  cancelRelayClientInstall,
  onRelayClientInstallCancel,
  reportRelayClientInstallProgress,
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

  it.each(["before", "after"])("delivers cancellation %s the install subscribes", async (when) => {
    const confirmation = requestRelayClientInstallConfirmation("2026.10.0");
    respondToRelayClientInstallConfirmation(true);
    await expect(confirmation).resolves.toBe(true);
    if (when === "before") cancelRelayClientInstall();
    const cancelled = vi.fn();
    const unsubscribe = onRelayClientInstallCancel(cancelled);
    if (when === "after") cancelRelayClientInstall();
    cancelRelayClientInstall();
    expect(cancelled).toHaveBeenCalledTimes(1);
    unsubscribe();
  });
});

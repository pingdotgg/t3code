import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  requestAlertDialog,
  requestConfirmDialog,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "./confirmDialog";

function requireConfirmation(confirmation: Promise<boolean> | undefined): Promise<boolean> {
  if (!confirmation) {
    throw new Error("Expected a registered confirmation host.");
  }
  return confirmation;
}

function requireAlert(alert: Promise<void> | undefined): Promise<void> {
  if (!alert) {
    throw new Error("Expected a registered dialog host.");
  }
  return alert;
}

describe("confirm dialog coordinator", () => {
  beforeEach(() => {
    resetConfirmDialogForTests();
  });

  it("returns undefined until a themed host is mounted", () => {
    expect(requestConfirmDialog("Confirm this action?")).toBeUndefined();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("resolves a displayed confirmation and waits for its close transition", async () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(
      requestConfirmDialog("Delete this thread?", { variant: "destructive" }),
    );

    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      mode: "confirm",
      message: "Delete this thread?",
      variant: "destructive",
    });

    respondToConfirmDialog(true);
    await expect(confirmation).resolves.toBe(true);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      mode: "confirm",
      message: "Delete this thread?",
      variant: "destructive",
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("resolves a themed one-button alert", async () => {
    const unregister = registerConfirmDialogHost();
    const alert = requireAlert(
      requestAlertDialog({
        title: "Automatic updates are not available right now.",
        description: "Automatic updates are only available in packaged production builds.",
      }),
    );

    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      mode: "alert",
      title: "Automatic updates are not available right now.",
      description: "Automatic updates are only available in packaged production builds.",
    });

    respondToConfirmDialog(true);
    await expect(alert).resolves.toBeUndefined();
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      mode: "alert",
      title: "Automatic updates are not available right now.",
      description: "Automatic updates are only available in packaged production builds.",
    });

    completeConfirmDialogClose();
    unregister();
  });

  it("serializes concurrent confirmations", async () => {
    const unregister = registerConfirmDialogHost();
    const first = requireConfirmation(requestConfirmDialog("Delete the project?"));
    const second = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    respondToConfirmDialog(false);
    await expect(first).resolves.toBe(false);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      mode: "confirm",
      message: "Delete the project?",
      variant: "default",
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      mode: "confirm",
      message: "Delete the worktree too?",
      variant: "default",
    });

    respondToConfirmDialog(true);
    await expect(second).resolves.toBe(true);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("preserves alert and confirmation copy while advancing a mixed queue", async () => {
    const unregister = registerConfirmDialogHost();
    const alert = requireAlert(
      requestAlertDialog({ title: "Could not check for updates.", description: "Offline." }),
    );
    const confirmation = requireConfirmation(requestConfirmDialog("Install update?"));

    respondToConfirmDialog(true);
    await expect(alert).resolves.toBeUndefined();
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      mode: "confirm",
      message: "Install update?",
      variant: "default",
    });

    respondToConfirmDialog(false);
    await expect(confirmation).resolves.toBe(false);
    completeConfirmDialogClose();
    unregister();
  });

  it("cancels active and queued confirmations if the last host unmounts", async () => {
    const unregister = registerConfirmDialogHost();
    const active = requireConfirmation(requestConfirmDialog("Delete the thread?"));
    const queued = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    unregister();

    await expect(Promise.all([active, queued])).resolves.toEqual([false, false]);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("ignores responses after the active dialog has been closed", () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(requestConfirmDialog("Continue?"));

    respondToConfirmDialog(true);
    respondToConfirmDialog(false);
    completeConfirmDialogClose();

    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
    return expect(confirmation).resolves.toBe(true);
  });
});

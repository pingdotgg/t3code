import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
  requestConfirmDialog,
  resetConfirmDialogForTests,
  respondToConfirmDialog,
} from "./confirmDialog";
import type { ConfirmDialogResult } from "@t3tools/contracts";

function requireConfirmation(
  confirmation: Promise<ConfirmDialogResult> | undefined,
): Promise<ConfirmDialogResult> {
  if (!confirmation) {
    throw new Error("Expected a registered confirmation host.");
  }
  return confirmation;
}

const confirmed: ConfirmDialogResult = { confirmed: true, secondary: false };
const cancelled: ConfirmDialogResult = { confirmed: false, secondary: false };

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
      message: "Delete this thread?",
      variant: "destructive",
    });

    respondToConfirmDialog(confirmed);
    await expect(confirmation).resolves.toEqual(confirmed);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      message: "Delete this thread?",
      variant: "destructive",
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("carries custom labels and a secondary action through to the host", () => {
    registerConfirmDialogHost();
    requireConfirmation(
      requestConfirmDialog("Delete this thread?", {
        variant: "destructive",
        confirmLabel: "Delete thread",
        cancelLabel: "Cancel",
        secondary: { label: "Delete thread & worktree", variant: "destructive" },
      }),
    );

    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete this thread?",
      variant: "destructive",
      confirmLabel: "Delete thread",
      cancelLabel: "Cancel",
      secondary: { label: "Delete thread & worktree", variant: "destructive" },
    });
  });

  it("resolves the secondary action distinctly from the primary one", async () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(
      requestConfirmDialog("Delete this thread?", {
        variant: "destructive",
        secondary: { label: "Delete thread & worktree", variant: "destructive" },
      }),
    );

    respondToConfirmDialog({ confirmed: true, secondary: true });
    await expect(confirmation).resolves.toEqual({ confirmed: true, secondary: true });
    unregister();
  });

  it("serializes concurrent confirmations", async () => {
    const unregister = registerConfirmDialogHost();
    const first = requireConfirmation(requestConfirmDialog("Delete the project?"));
    const second = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    respondToConfirmDialog(cancelled);
    await expect(first).resolves.toEqual(cancelled);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      message: "Delete the project?",
      variant: "default",
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      message: "Delete the worktree too?",
      variant: "default",
    });

    respondToConfirmDialog(confirmed);
    await expect(second).resolves.toEqual(confirmed);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("cancels active and queued confirmations if the last host unmounts", async () => {
    const unregister = registerConfirmDialogHost();
    const active = requireConfirmation(requestConfirmDialog("Delete the thread?"));
    const queued = requireConfirmation(requestConfirmDialog("Delete the worktree too?"));

    unregister();

    await expect(Promise.all([active, queued])).resolves.toEqual([cancelled, cancelled]);
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
  });

  it("ignores responses after the active dialog has been closed", () => {
    const unregister = registerConfirmDialogHost();
    const confirmation = requireConfirmation(requestConfirmDialog("Continue?"));

    respondToConfirmDialog(confirmed);
    respondToConfirmDialog(cancelled);
    completeConfirmDialogClose();

    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
    return expect(confirmation).resolves.toEqual(confirmed);
  });
});

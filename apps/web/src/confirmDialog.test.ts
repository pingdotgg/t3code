import { beforeEach, describe, expect, it } from "vite-plus/test";

import {
  completeConfirmDialogClose,
  readConfirmDialogState,
  registerConfirmDialogHost,
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
      id: "confirm-1",
      message: "Delete this thread?",
      variant: "destructive",
      checkbox: undefined,
    });

    respondToConfirmDialog(true);
    await expect(confirmation).resolves.toBe(true);
    expect(readConfirmDialogState()).toEqual({
      status: "closing",
      id: "confirm-1",
      message: "Delete this thread?",
      variant: "destructive",
      checkbox: undefined,
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
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
      id: "confirm-1",
      message: "Delete the project?",
      variant: "default",
      checkbox: undefined,
    });

    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      id: "confirm-2",
      message: "Delete the worktree too?",
      variant: "default",
      checkbox: undefined,
    });

    respondToConfirmDialog(true);
    await expect(second).resolves.toBe(true);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });

  it("assigns distinct IDs to successive confirmations with identical messages", async () => {
    const unregister = registerConfirmDialogHost();
    const first = requireConfirmation(requestConfirmDialog("Same message?"));
    const second = requireConfirmation(requestConfirmDialog("Same message?"));

    const firstState = readConfirmDialogState();
    expect(firstState).toMatchObject({
      status: "confirming",
      id: "confirm-1",
      message: "Same message?",
    });

    respondToConfirmDialog(true);
    await expect(first).resolves.toBe(true);
    completeConfirmDialogClose();

    const secondState = readConfirmDialogState();
    expect(secondState).toMatchObject({
      status: "confirming",
      id: "confirm-2",
      message: "Same message?",
    });
    expect(secondState.status === "confirming" ? secondState.id : null).not.toBe(
      firstState.status === "confirming" ? firstState.id : null,
    );

    respondToConfirmDialog(true);
    await expect(second).resolves.toBe(true);
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

  it("passes checkbox options into confirming and queued states", async () => {
    const unregister = registerConfirmDialogHost();
    const onCheckedChange = () => undefined;
    const confirmation = requireConfirmation(
      requestConfirmDialog("Close terminal?", {
        variant: "destructive",
        checkbox: { label: "Don't ask again", checked: false, onCheckedChange },
      }),
    );

    expect(readConfirmDialogState()).toEqual({
      status: "confirming",
      id: "confirm-1",
      message: "Close terminal?",
      variant: "destructive",
      checkbox: { label: "Don't ask again", checked: false, onCheckedChange },
    });

    respondToConfirmDialog(true);
    await expect(confirmation).resolves.toBe(true);
    completeConfirmDialogClose();
    expect(readConfirmDialogState()).toEqual({ status: "idle" });
    unregister();
  });
});

import { describe, expect, it } from "vite-plus/test";
import { resolveAlertDismissal } from "./dialog-alert";

describe("resolveAlertDismissal", () => {
  const cancel = { text: "Cancel", style: "cancel" as const };
  const confirm = { text: "Delete", style: "destructive" as const };

  it("dismisses only cancelable alerts outright", () => {
    expect(
      resolveAlertDismissal({
        buttons: [cancel, confirm],
        options: { cancelable: true },
      }),
    ).toEqual({ kind: "dismiss" });
    expect(resolveAlertDismissal({ buttons: [confirm], options: { cancelable: false } })).toEqual({
      kind: "ignore",
    });
  });

  it("treats dismissal as the cancel button, or the only button", () => {
    expect(resolveAlertDismissal({ buttons: [confirm, cancel] })).toEqual({
      kind: "press",
      button: cancel,
    });
    expect(resolveAlertDismissal({ buttons: [confirm] })).toEqual({
      kind: "press",
      button: confirm,
    });
    expect(resolveAlertDismissal({ buttons: [{ text: "Retry" }, { text: "Undo" }] })).toEqual({
      kind: "ignore",
    });
  });
});

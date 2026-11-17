// @effect-diagnostics nodeBuiltinImport:off - Models Electron's native dialog events without a GUI.
import * as NodeEvents from "node:events";
import { expect, it, vi } from "vite-plus/test";
import { interceptNativeDialogs } from "./NativeDialogs.ts";

const setup = () => {
  const contents = Object.assign(new NodeEvents.EventEmitter(), {
    debugger: new NodeEvents.EventEmitter(),
  });
  const nativeDialog = vi.fn();
  const nativeCancel = vi.fn();
  contents.on("-run-dialog", nativeDialog);
  contents.on("-cancel-dialogs", nativeCancel);
  let owned = false;
  const detach = interceptNativeDialogs(contents, () => owned);
  return { contents, nativeDialog, nativeCancel, detach, own: () => (owned = true) };
};

it("keeps human dialogs native and holds agent dialogs for CDP, then restores the native handler", () => {
  const { contents, nativeDialog, detach, own } = setup();
  const human = vi.fn();
  const info = { dialogType: "alert", messageText: "Hello" };
  contents.emit("-run-dialog", info, human);
  expect(nativeDialog).toHaveBeenCalledExactlyOnceWith(info, human);
  expect(nativeDialog.mock.contexts[0]).toBe(contents);
  own();
  for (const dialogType of ["alert", "confirm", "prompt"]) {
    const callback = vi.fn();
    contents.emit("-run-dialog", { ...info, dialogType }, callback);
    expect(nativeDialog).toHaveBeenCalledTimes(1);
    expect(callback).not.toHaveBeenCalled();
    contents.debugger.emit("message", {}, "Page.javascriptDialogClosed", {});
  }
  detach();
  detach();
  expect(contents.rawListeners("-run-dialog")).toEqual([nativeDialog]);
  contents.emit("-run-dialog", info, human);
  expect(nativeDialog).toHaveBeenCalledTimes(2);
});

it.each(["cancel", "navigation", "destroy", "detach", "debugger detach"])(
  "settles a held native callback exactly once on %s",
  (end) => {
    const { contents, nativeDialog, nativeCancel, detach, own } = setup();
    own();
    const callback = vi.fn();
    contents.emit("-run-dialog", { dialogType: "confirm" }, callback);
    expect(nativeDialog).not.toHaveBeenCalled();
    contents.emit("did-start-navigation", {}, "#hash", true, true);
    contents.emit("did-start-navigation", {}, "https://frame.test", false, false);
    expect(callback).not.toHaveBeenCalled();
    switch (end) {
      case "cancel":
        contents.emit("-cancel-dialogs", {});
        expect(nativeCancel).toHaveBeenCalledTimes(1);
        break;
      case "navigation":
        contents.emit("did-start-navigation", {}, "https://next.test", false, true);
        break;
      case "destroy":
        contents.emit("destroyed");
        break;
      case "detach":
        detach();
        break;
      case "debugger detach":
        contents.debugger.emit("detach", {}, "target_closed");
        break;
    }
    detach();
    expect(callback).toHaveBeenCalledExactlyOnceWith(false, "");
    expect(contents.rawListeners("-run-dialog")).toEqual([nativeDialog]);
    expect(contents.listenerCount("did-start-navigation")).toBe(0);
    expect(contents.debugger.listenerCount("message")).toBe(0);
    expect(contents.debugger.listenerCount("detach")).toBe(0);
  },
);

it("does not invoke the native callback again after CDP resolves the dialog", () => {
  const { contents, detach, own } = setup();
  own();
  const callback = vi.fn();
  contents.emit("-run-dialog", { dialogType: "prompt" }, callback);
  contents.debugger.emit("message", {}, "Page.javascriptDialogClosed", {});
  detach();
  expect(callback).not.toHaveBeenCalled();
});

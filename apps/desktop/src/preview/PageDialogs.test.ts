import * as NodeEvents from "node:events";
import { describe, expect, it, vi } from "vite-plus/test";

import { holdPageDialogs } from "./PageDialogs.ts";

const info = { dialogType: "confirm", messageText: "Delete it?", defaultPromptText: "" };

function setup() {
  const contents = new NodeEvents.EventEmitter();
  const native = vi.fn();
  contents.on("-run-dialog", native);
  const changed = vi.fn();
  const hold = holdPageDialogs(contents, changed);
  const callback = vi.fn();
  return { contents, native, changed, hold, callback };
}

describe("holdPageDialogs", () => {
  it("keeps a page dialog pending instead of showing the native box", () => {
    const { contents, native, changed, callback } = setup();

    contents.emit("-run-dialog", info, callback);

    expect(native).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(changed).toHaveBeenLastCalledWith({
      id: 1,
      type: "confirm",
      message: "Delete it?",
      defaultValue: "",
    });
  });

  it("answers only the dialog it was meant for, once", () => {
    const { contents, changed, hold, callback } = setup();
    contents.emit("-run-dialog", info, callback);

    expect(hold.answer(true, 1)).toBe(true);
    expect(hold.answer(false)).toBe(false);
    expect(callback).toHaveBeenCalledExactlyOnceWith(true, "");
    expect(changed).toHaveBeenLastCalledWith(null);

    const next = vi.fn();
    contents.emit("-run-dialog", info, next);
    expect(hold.answer(true, 1)).toBe(false);
    expect(next).not.toHaveBeenCalled();

    contents.emit("-run-dialog", info, callback);
    expect(next).toHaveBeenCalledExactlyOnceWith(false, "");
  });

  // A frame without the renderer prompt override reaches the hold
  it("rejects a prompt at once like Electron and leaves a pending dialog alone", () => {
    const { contents, changed, hold, callback } = setup();
    contents.emit("-run-dialog", info, callback);
    changed.mockClear();

    const prompt = vi.fn();
    contents.emit("-run-dialog", { ...info, dialogType: "prompt" }, prompt);

    expect(prompt).toHaveBeenCalledExactlyOnceWith(false, "");
    expect(changed).not.toHaveBeenCalled();
    expect(hold.current()).toEqual({
      id: 1,
      type: "confirm",
      message: "Delete it?",
      defaultValue: "",
    });
    expect(callback).not.toHaveBeenCalled();
    expect(hold.answer(true)).toBe(true);
    expect(callback).toHaveBeenCalledExactlyOnceWith(true, "");

    contents.emit("-run-dialog", { ...info, dialogType: "prompt" }, prompt);
    expect(hold.current()).toBeNull();
  });

  it("drops a dialog that CDP or a navigation already closed without answering twice", () => {
    const { contents, changed, hold, callback } = setup();

    contents.emit("-run-dialog", info, callback);
    hold.closed();
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(hold.answer(true)).toBe(false);

    contents.emit("-run-dialog", info, callback);
    contents.emit("-cancel-dialogs");
    expect(changed).toHaveBeenLastCalledWith(null);
    expect(hold.answer(true)).toBe(false);
    expect(callback).not.toHaveBeenCalled();
  });

  it("dismisses a pending dialog when a main-frame navigation starts", () => {
    const { contents, changed, callback } = setup();
    contents.emit("-run-dialog", info, callback);

    contents.emit("did-start-navigation", { isMainFrame: false, isSameDocument: false });
    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: true });
    expect(callback).not.toHaveBeenCalled();

    contents.emit("did-start-navigation", { isMainFrame: true, isSameDocument: false });
    expect(callback).toHaveBeenCalledExactlyOnceWith(false, "");
    expect(changed).toHaveBeenLastCalledWith(null);
  });
});

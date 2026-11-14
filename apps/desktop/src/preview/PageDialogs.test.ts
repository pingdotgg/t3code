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
      type: "confirm",
      message: "Delete it?",
      defaultValue: "",
    });
  });

  it("answers the page once and clears the dialog", () => {
    const { contents, changed, hold, callback } = setup();
    contents.emit("-run-dialog", { ...info, dialogType: "prompt" }, callback);

    expect(hold.answer(true, "yes")).toBe(true);
    expect(hold.answer(false)).toBe(false);

    expect(callback).toHaveBeenCalledOnce();
    expect(callback).toHaveBeenCalledWith(true, "yes");
    expect(changed).toHaveBeenLastCalledWith(null);

    const first = vi.fn();
    contents.emit("-run-dialog", info, first);
    contents.emit("-run-dialog", info, callback);
    expect(first).toHaveBeenCalledExactlyOnceWith(false, "");
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

  it("dismisses a pending dialog and hands the native handler back on release", () => {
    const { contents, native, changed, hold, callback } = setup();
    contents.emit("-run-dialog", info, callback);
    callback.mockImplementation(() => {
      throw new Error("callback already used");
    });

    hold.release();

    expect(callback).toHaveBeenCalledWith(false, "");
    expect(changed).toHaveBeenLastCalledWith(null);
    contents.emit("-run-dialog", info, vi.fn());
    expect(native).toHaveBeenCalledOnce();
  });
});

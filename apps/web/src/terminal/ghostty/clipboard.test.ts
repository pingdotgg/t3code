import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { copyTerminalClipboardFromGesture, writeTerminalClipboard } from "./clipboard";

describe("application clipboard writes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it.each(["text", ""])("copies %j during a gesture and removes its copy handler", (text) => {
    const setData = vi.fn();
    const document = Object.assign(new EventTarget(), {
      execCommand: () =>
        document.dispatchEvent(
          Object.assign(new Event("copy", { cancelable: true }), { clipboardData: { setData } }),
        ),
    });
    vi.stubGlobal("document", document);
    expect(setData).not.toHaveBeenCalled();
    expect(copyTerminalClipboardFromGesture(text)).toBe(true);
    expect(setData.mock.calls).toEqual([["text/plain", text]]);
    document.execCommand();
    expect(setData).toHaveBeenCalledTimes(1);
  });

  it("reports a blocked gesture without leaving a copy handler installed", () => {
    const document = Object.assign(new EventTarget(), {
      execCommand: () => {
        throw new Error("denied");
      },
    });
    vi.stubGlobal("document", document);
    expect(copyTerminalClipboardFromGesture("blocked")).toBe(false);
    const setData = vi.fn();
    document.dispatchEvent(Object.assign(new Event("copy"), { clipboardData: { setData } }));
    expect(setData).not.toHaveBeenCalled();
  });

  it.each(["success", "denied"])(
    "serializes writes and keeps only the newest pending text after %s",
    async (result) => {
      let finishFirst!: () => void;
      const first = new Promise<void>((resolve) => {
        finishFirst = resolve;
      });
      let clipboard = "";
      const writeText = vi.fn(async (text: string) => {
        if (text === "first") {
          await first;
          if (result === "denied") throw new Error("NotAllowedError");
        }
        clipboard = text;
      });
      vi.stubGlobal("navigator", { clipboard: { writeText } });
      const writes = [
        writeTerminalClipboard("first"),
        writeTerminalClipboard("superseded"),
        writeTerminalClipboard("last"),
      ];
      const callsWhilePending = [...writeText.mock.calls];
      finishFirst();
      expect(await Promise.all(writes)).toEqual([
        result === "denied" ? "failed" : "written",
        "skipped",
        "written",
      ]);
      expect(callsWhilePending).toEqual([["first"]]);
      expect(writeText.mock.calls).toEqual([["first"], ["last"]]);
      expect(clipboard).toBe("last");
    },
  );

  it.each(["success", "denied", "unavailable"])(
    "keeps browser focus and consumes failures when clipboard access is %s",
    async (result) => {
      const writeText = vi.fn(() =>
        result === "denied" ? Promise.reject(new Error("NotAllowedError")) : Promise.resolve(),
      );
      const createElement = vi.fn();
      const execCommand = vi.fn();
      vi.stubGlobal("navigator", result === "unavailable" ? {} : { clipboard: { writeText } });
      vi.stubGlobal("document", { createElement, execCommand });
      await expect(writeTerminalClipboard("application text")).resolves.toBe(
        result === "success" ? "written" : "failed",
      );
      await expect(writeTerminalClipboard("inactive", () => false)).resolves.toBe("skipped");
      expect(writeText.mock.calls).toEqual(result === "unavailable" ? [] : [["application text"]]);
      expect(createElement).not.toHaveBeenCalled();
      expect(execCommand).not.toHaveBeenCalled();
    },
  );
});

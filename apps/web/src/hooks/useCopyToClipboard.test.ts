import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ClipboardApiUnavailableError,
  ClipboardWriteError,
  writeTextToClipboard,
} from "./useCopyToClipboard";

describe("writeTextToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports unavailable clipboard support with structural context", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", undefined);

    const error = await writeTextToClipboard("plan contents", "plan").then(
      () => undefined,
      (cause: unknown) => cause,
    );

    expect(error).toBeInstanceOf(ClipboardApiUnavailableError);
    expect(error).toMatchObject({
      target: "plan",
    });
    expect((error as Error).message).not.toContain("plan contents");
  });

  it("falls back to a selected textarea when the Clipboard API is unavailable", async () => {
    const focus = vi.fn();
    const restoreFocus = vi.fn();
    const appendChild = vi.fn();
    const execCommand = vi.fn(() => true);
    const remove = vi.fn();
    const select = vi.fn();
    const setAttribute = vi.fn();
    const setSelectionRange = vi.fn();
    const textarea = {
      focus,
      remove,
      select,
      setAttribute,
      setSelectionRange,
      style: {},
      value: "",
    };

    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", {
      activeElement: { focus: restoreFocus },
      body: { appendChild },
      createElement: vi.fn(() => textarea),
      execCommand,
    });

    await expect(writeTextToClipboard("remote command", "command")).resolves.toBe(true);

    expect(textarea.value).toBe("remote command");
    expect(appendChild).toHaveBeenCalledWith(textarea);
    expect(focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(select).toHaveBeenCalledOnce();
    expect(setSelectionRange).toHaveBeenCalledWith(0, "remote command".length);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(remove).toHaveBeenCalledOnce();
    expect(restoreFocus).toHaveBeenCalledOnce();
  });

  it("preserves the exact clipboard failure without exposing copied contents", async () => {
    const cause = new Error("browser clipboard failure");
    const writeText = vi.fn().mockRejectedValue(cause);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    const error = await writeTextToClipboard("secret clipboard contents", "error-message").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(writeText).toHaveBeenCalledWith("secret clipboard contents");
    expect(error).toBeInstanceOf(ClipboardWriteError);
    expect(error).toMatchObject({
      target: "error-message",
      cause,
    });
    expect((error as Error).message).not.toContain("secret clipboard contents");
  });

  it("keeps empty values as a no-op when clipboard support is available", async () => {
    const writeText = vi.fn();
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });

    await expect(writeTextToClipboard("", "plan")).resolves.toBe(false);
    expect(writeText).not.toHaveBeenCalled();
  });
});

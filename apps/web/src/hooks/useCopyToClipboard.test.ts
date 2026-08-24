import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import {
  ClipboardApiUnavailableError,
  ClipboardReadError,
  ClipboardReadUnavailableError,
  ClipboardWriteError,
  localizedClipboardErrorMessage,
  writeTextToClipboard,
} from "./useCopyToClipboard";
import type { Translate } from "../i18n";

const mappedTranslate = ((key, values) => `${key}:${values?.target ?? ""}`) as Translate;

describe("writeTextToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reports unavailable clipboard support with structural context", async () => {
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});

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

describe("localizedClipboardErrorMessage", () => {
  it.each([
    [
      new ClipboardApiUnavailableError({ target: "branch name" }),
      "clipboard.error.apiUnavailable:branch name",
    ],
    [
      new ClipboardWriteError({ target: "trace ID", cause: new Error("write failed") }),
      "clipboard.error.writeFailed:trace ID",
    ],
    [
      new ClipboardReadUnavailableError({ target: "terminal input" }),
      "clipboard.error.readUnavailable:terminal input",
    ],
    [
      new ClipboardReadError({ target: "terminal input", cause: new Error("read failed") }),
      "clipboard.error.readFailed:terminal input",
    ],
  ])("maps %s by tag while preserving its target", (error, expected) => {
    expect(localizedClipboardErrorMessage(error, mappedTranslate)).toBe(expected);
  });

  it("keeps the low-level English message available for diagnostics", () => {
    const error = new ClipboardWriteError({ target: "link", cause: new Error("write failed") });

    expect(error.message).toBe("Failed to copy link to the clipboard.");
  });
});

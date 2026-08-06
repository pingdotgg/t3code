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

  // Node test env has no DOM; stub a minimal document that drives the legacy
  // execCommand path, mirroring what a real browser provides.
  const stubLegacyDocument = (execCommand: ReturnType<typeof vi.fn>) => {
    const textarea = {
      value: "",
      setAttribute: vi.fn(),
      style: {},
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn(),
    };
    vi.stubGlobal("document", {
      createElement: vi.fn(() => textarea),
      execCommand,
      body: { appendChild: vi.fn() },
      activeElement: { focus: vi.fn() },
    });
    return textarea;
  };

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

  it("falls back to the legacy execCommand path when the async API is unavailable", async () => {
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    const textarea = stubLegacyDocument(execCommand);

    await expect(writeTextToClipboard("plan contents", "plan")).resolves.toBe(true);
    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.setSelectionRange).toHaveBeenCalledWith(0, "plan contents".length);
    expect(textarea.remove).toHaveBeenCalled();
  });

  it("falls back to the legacy execCommand path when the async API rejects", async () => {
    const cause = new Error("browser clipboard failure");
    const writeText = vi.fn().mockRejectedValue(cause);
    const execCommand = vi.fn(() => true);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    stubLegacyDocument(execCommand);

    await expect(writeTextToClipboard("secret clipboard contents", "error-message")).resolves.toBe(
      true,
    );
    expect(writeText).toHaveBeenCalledWith("secret clipboard contents");
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports unavailable clipboard support when both paths cannot copy", async () => {
    const execCommand = vi.fn(() => false);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {});
    stubLegacyDocument(execCommand);

    const error = await writeTextToClipboard("plan contents", "plan").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(ClipboardApiUnavailableError);
    expect(execCommand).toHaveBeenCalledWith("copy");
  });

  it("reports the original failure when the async API rejects and the legacy path cannot copy", async () => {
    const cause = new Error("browser clipboard failure");
    const writeText = vi.fn().mockRejectedValue(cause);
    const execCommand = vi.fn(() => false);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    stubLegacyDocument(execCommand);

    const error = await writeTextToClipboard("secret clipboard contents", "error-message").then(
      () => undefined,
      (failure: unknown) => failure,
    );

    expect(error).toBeInstanceOf(ClipboardWriteError);
    expect(error).toMatchObject({
      target: "error-message",
      cause,
    });
    expect(execCommand).toHaveBeenCalledWith("copy");
  });
});

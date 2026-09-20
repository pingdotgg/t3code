import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_CONTEXT_CLIPBOARD_MIME } from "@t3tools/shared/composerContextClipboard";

import {
  ClipboardApiUnavailableError,
  ClipboardWriteError,
  useCopyToClipboard,
  writeTextToClipboard,
} from "./useCopyToClipboard";

describe("writeTextToClipboard", () => {
  it("reserves plain text even when an extra flavor attempts to replace it", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    await expect(
      writeTextToClipboard("original", "message", {
        "text/plain": "replacement",
        "text/html": "<b>original</b>",
      }),
    ).resolves.toBe(true);
    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    expect(await items[0]!.data["text/plain"]!.text()).toBe("original");
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("keeps caller-built rich HTML when attaching a context fragment", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { write, writeText: vi.fn() } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    const fragment = JSON.stringify({ version: 1, source: {}, records: [] });
    const rich = "<p><strong>Message</strong></p>";

    await expect(
      writeTextToClipboard("Message", "message", {
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment,
        "text/html": rich,
      }),
    ).resolves.toBe(true);

    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    const html = await items[0]!.data["text/html"]!.text();
    expect(html).toContain(rich);
    expect(html).toContain("data-t3-context-fragment=");
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

  it.each(["success", "denied", "throws"] as const)(
    "cleans up the Clipboard API fallback when copying %s",
    async (result) => {
      const focus = vi.fn();
      const restoreFocus = vi.fn();
      const appendChild = vi.fn();
      const execCommand = vi.fn(() => {
        if (result === "throws") throw new Error("copy command failed");
        return result === "success";
      });
      const remove = vi.fn();
      const select = vi.fn();
      const setAttribute = vi.fn();
      const setSelectionRange = vi.fn();
      const textarea = {
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
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

      const pendingCopy = writeTextToClipboard("remote command", "command");
      // The fallback must run during the original user gesture, before any await.
      expect(execCommand).toHaveBeenCalledWith("copy");
      if (result === "success") {
        await expect(pendingCopy).resolves.toBe(true);
      } else {
        await expect(pendingCopy).rejects.toBeInstanceOf(ClipboardApiUnavailableError);
      }

      expect(textarea.value).toBe("remote command");
      expect(textarea.style).toMatchObject({ fontSize: "16px" });
      expect(appendChild).toHaveBeenCalledWith(textarea);
      expect(focus).toHaveBeenCalledWith({ preventScroll: true });
      expect(select).toHaveBeenCalledOnce();
      expect(setSelectionRange).toHaveBeenCalledWith(0, "remote command".length);
      expect(remove).toHaveBeenCalledOnce();
      expect(restoreFocus).toHaveBeenCalledOnce();
    },
  );

  it("uses the Clipboard API without touching the fallback when it is available", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const execCommand = vi.fn();
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.stubGlobal("document", { execCommand });

    await expect(writeTextToClipboard("remote command", "command")).resolves.toBe(true);

    expect(writeText).toHaveBeenCalledWith("remote command");
    expect(execCommand).not.toHaveBeenCalled();
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

  it.each([true, false])(
    "keeps empty values as a no-op with Clipboard API support: %s",
    async (available) => {
      const writeText = vi.fn();
      vi.stubGlobal("window", {});
      const execCommand = vi.fn();
      vi.stubGlobal("navigator", available ? { clipboard: { writeText } } : {});
      vi.stubGlobal("document", { execCommand });

      await expect(writeTextToClipboard("", "plan")).resolves.toBe(false);
      expect(writeText).not.toHaveBeenCalled();
      expect(execCommand).not.toHaveBeenCalled();
    },
  );
});

describe("useCopyToClipboard", () => {
  let root: Root;
  let latest: ReturnType<typeof useCopyToClipboard<undefined>> | null;
  let onCopy: ReturnType<typeof vi.fn<() => void>>;
  let onError: ReturnType<typeof vi.fn<(error: Error) => void>>;
  let execCommand: ReturnType<typeof vi.fn>;
  let textarea: {
    value: string;
    style: Record<string, string>;
    setAttribute: ReturnType<typeof vi.fn>;
    addEventListener: ReturnType<typeof vi.fn>;
    removeEventListener: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    select: ReturnType<typeof vi.fn>;
    setSelectionRange: ReturnType<typeof vi.fn>;
    remove: ReturnType<typeof vi.fn>;
  };

  function Probe() {
    // timeout: 0 keeps the copied state from resetting itself mid-assertion.
    latest = useCopyToClipboard<undefined>({ onCopy, onError, timeout: 0 });
    return null;
  }

  beforeEach(() => {
    execCommand = vi.fn(() => true);
    textarea = {
      value: "",
      style: {},
      setAttribute: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      focus: vi.fn(),
      select: vi.fn(),
      setSelectionRange: vi.fn(),
      remove: vi.fn(),
    };
    // One fake document serves both ReactDOM's event target and the
    // execCommand fallback the hook reaches on plain-HTTP pages.
    const document = {
      nodeType: 9,
      addEventListener() {},
      removeEventListener() {},
      activeElement: { focus: vi.fn() },
      body: { appendChild: vi.fn() },
      createElement: vi.fn(() => textarea),
      execCommand,
    };
    const container = {
      nodeType: 1,
      tagName: "DIV",
      namespaceURI: "http://www.w3.org/1999/xhtml",
      ownerDocument: document,
      addEventListener() {},
      removeEventListener() {},
    };
    vi.stubGlobal("document", document);
    vi.stubGlobal("window", { document, HTMLIFrameElement: EventTarget });
    vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
    onCopy = vi.fn();
    onError = vi.fn();
    latest = null;
    root = createRoot(container as unknown as HTMLElement);
  });

  afterEach(async () => {
    await act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("does not report copied until the write resolves", async () => {
    let resolveWrite!: () => void;
    const writeText = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveWrite = resolve;
        }),
    );
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await act(async () => {
      root.render(createElement(Probe));
    });

    await act(async () => {
      latest!.copyToClipboard("report", undefined);
    });

    expect(writeText).toHaveBeenCalledWith("report");
    expect(latest!.isCopied).toBe(false);
    expect(onCopy).not.toHaveBeenCalled();

    await act(async () => {
      resolveWrite();
    });

    expect(latest!.isCopied).toBe(true);
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("passes a rejected write to onError without a copied state or contents", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => {
      root.render(createElement(Probe));
    });

    await act(async () => {
      latest!.copyToClipboard("sensitive report body", undefined);
    });

    expect(latest!.isCopied).toBe(false);
    expect(onCopy).not.toHaveBeenCalled();
    expect(onError).toHaveBeenCalledWith(
      expect.objectContaining({ _tag: "ClipboardWriteError", target: "text" }),
      undefined,
    );
    expect(JSON.stringify(consoleError.mock.calls)).not.toContain("sensitive report body");
  });

  it("copies the same value again on retry after a failure", async () => {
    const writeText = vi
      .fn()
      .mockRejectedValueOnce(new Error("denied"))
      .mockResolvedValueOnce(undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await act(async () => {
      root.render(createElement(Probe));
    });

    await act(async () => {
      latest!.copyToClipboard("trace-123", undefined);
    });
    expect(latest!.isCopied).toBe(false);

    await act(async () => {
      latest!.copyToClipboard("trace-123", undefined);
    });

    expect(writeText).toHaveBeenNthCalledWith(2, "trace-123");
    expect(latest!.isCopied).toBe(true);
    expect(onCopy).toHaveBeenCalledOnce();
  });

  it("reports copied through the execCommand fallback used over plain HTTP", async () => {
    vi.stubGlobal("navigator", {});
    await act(async () => {
      root.render(createElement(Probe));
    });

    await act(async () => {
      latest!.copyToClipboard("remote command", undefined);
    });

    expect(execCommand).toHaveBeenCalledWith("copy");
    expect(textarea.value).toBe("remote command");
    expect(latest!.isCopied).toBe(true);
    expect(onCopy).toHaveBeenCalledOnce();
  });
});

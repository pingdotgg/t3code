import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_CONTEXT_CLIPBOARD_MIME } from "@t3tools/shared/composerContextClipboard";

import { writePngToClipboard, writeTextToClipboard } from "./useCopyToClipboard";

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
      writeTextToClipboard("original", undefined, {
        "text/plain": "replacement",
        "text/html": "<b>original</b>",
      }),
    ).resolves.toBe(true);
    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    expect(await items[0]!.data["text/plain"]!.text()).toBe("original");
  });
  it("reports a rejected HTML copy without silently copying only plain text", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", {});
    vi.stubGlobal("navigator", {
      clipboard: { write: vi.fn().mockRejectedValue(new Error("denied")), writeText },
    });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Blob>) {}
      },
    );
    await expect(
      writeTextToClipboard(
        "<table></table>",
        undefined,
        { "text/html": "<table></table>" },
        { requireHtml: true },
      ),
    ).rejects.toMatchObject({ _tag: "ClipboardWriteError" });
    expect(writeText).not.toHaveBeenCalled();
    await expect(writeTextToClipboard("plain")).resolves.toBe(true);
    expect(writeText).toHaveBeenCalledWith("plain");
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
      writeTextToClipboard("Message", undefined, {
        [COMPOSER_CONTEXT_CLIPBOARD_MIME]: fragment,
        "text/html": rich,
      }),
    ).resolves.toBe(true);

    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Blob> }>;
    const html = await items[0]!.data["text/html"]!.text();
    expect(html).toContain(rich);
    expect(html).toContain("data-t3-context-fragment=");
  });
});

describe("writePngToClipboard", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("starts the write before the image is ready, so the click still counts", async () => {
    const write = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("navigator", { clipboard: { write } });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Promise<Blob>>) {}
      },
    );
    let finish: (png: Blob) => void = () => {};
    const png = new Promise<Blob>((resolve) => {
      finish = resolve;
    });

    const copied = writePngToClipboard(() => png);
    expect(write).toHaveBeenCalledTimes(1);
    const items = write.mock.calls[0]![0] as Array<{ data: Record<string, Promise<Blob>> }>;
    expect(items[0]!.data["image/png"]).toBe(png);
    finish(new Blob([], { type: "image/png" }));
    await expect(copied).resolves.toBe(true);
  });

  it("leaves no unhandled rejection when the clipboard refuses before reading the image", async () => {
    vi.stubGlobal("navigator", {
      clipboard: { write: vi.fn().mockRejectedValue(new Error("denied")) },
    });
    vi.stubGlobal(
      "ClipboardItem",
      class {
        constructor(readonly data: Record<string, Promise<Blob>>) {}
      },
    );
    const png = Promise.reject(new Error("the render failed"));
    const handled = vi.spyOn(png, "catch");

    await expect(writePngToClipboard(() => png)).rejects.toMatchObject({
      _tag: "ClipboardWriteError",
    });
    // The clipboard never read the image, so only the copy's own handler covers its rejection.
    expect(handled).toHaveBeenCalled();
  });

  it("reports a clipboard without image support instead of drawing the image", async () => {
    vi.stubGlobal("navigator", { clipboard: { writeText: vi.fn() } });
    const draw = vi.fn(async () => new Blob());

    await expect(writePngToClipboard(draw)).rejects.toMatchObject({
      _tag: "ClipboardApiUnavailableError",
    });
    expect(draw).not.toHaveBeenCalled();
  });
});

import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { COMPOSER_CONTEXT_CLIPBOARD_MIME } from "@t3tools/shared/composerContextClipboard";

import { writeTextToClipboard } from "./useCopyToClipboard";

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

import type { AssetCreateUrlResult, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import {
  beginExternalFileOpen,
  isBrowserPreviewFile,
  openFileInExternalBrowser,
} from "./openFileInPreview";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const assetResult = (relativeUrl: string): AssetCreateUrlResult => ({
  relativeUrl,
  expiresAt: 1_750_000_000_000,
});

describe("isBrowserPreviewFile", () => {
  it.each(["report.html", "doc.HTM", "paper.pdf", "nested/page.html?x=1#top"])(
    "accepts %s",
    (path) => expect(isBrowserPreviewFile(path)).toBe(true),
  );
  it.each(["notes.md", "index.html.bak", "script.js"])("rejects %s", (path) => {
    expect(isBrowserPreviewFile(path)).toBe(false);
  });
});

describe("beginExternalFileOpen", () => {
  it("uses the desktop shell without opening a web tab", async () => {
    const openExternal = vi.fn(async () => undefined);
    const openWindow = vi.fn();
    const session = beginExternalFileOpen({ isDesktop: true, openExternal, openWindow });

    await session.open("http://environment.test/report.pdf");

    expect(openExternal).toHaveBeenCalledWith("http://environment.test/report.pdf");
    expect(openWindow).not.toHaveBeenCalled();
  });

  it("reserves and isolates a web tab before navigation", async () => {
    const replace = vi.fn();
    const close = vi.fn();
    const tab = { opener: {} as Window | null, location: { replace }, close };
    const session = beginExternalFileOpen({
      isDesktop: false,
      openExternal: vi.fn(),
      openWindow: () => tab as unknown as Pick<Window, "close" | "location" | "opener">,
    });

    expect(tab.opener).toBeNull();
    await session.open("http://environment.test/report.html");
    expect(replace).toHaveBeenCalledWith("http://environment.test/report.html");
    session.cancel();
    expect(close).toHaveBeenCalledOnce();
  });

  it("reports a blocked web tab", () => {
    expect(() =>
      beginExternalFileOpen({
        isDesktop: false,
        openExternal: vi.fn(),
        openWindow: () => null,
      }),
    ).toThrow("The browser blocked the new tab.");
  });
});

describe("openFileInExternalBrowser", () => {
  it("reserves the browser target before requesting the signed URL", async () => {
    const calls: string[] = [];
    const open = vi.fn(async (url: string): Promise<void> => {
      calls.push(`open:${url}`);
    });
    const cancel = vi.fn();
    const createAssetUrl = vi.fn(async () => {
      calls.push("asset");
      return AsyncResult.success(assetResult("/api/assets/token/report.html"));
    });

    const result = await openFileInExternalBrowser({
      threadRef,
      filePath: "artifacts/report.html",
      httpBaseUrl: "http://environment.test:1234",
      createAssetUrl,
      beginOpen: () => {
        calls.push("begin");
        return { open, cancel };
      },
    });

    expect(result._tag).toBe("Success");
    expect(calls).toEqual([
      "begin",
      "asset",
      "open:http://environment.test:1234/api/assets/token/report.html",
    ]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("closes the reserved target when signed URL creation fails", async () => {
    const cancel = vi.fn();
    const result = await openFileInExternalBrowser({
      threadRef,
      filePath: "artifacts/report.html",
      httpBaseUrl: "http://environment.test:1234",
      createAssetUrl: vi.fn(async () =>
        AsyncResult.failure<AssetCreateUrlResult, Error>(Cause.fail(new Error("missing"))),
      ),
      beginOpen: () => ({ open: vi.fn(), cancel }),
    });

    expect(result._tag).toBe("Failure");
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("closes the reserved target when signed URL creation rejects", async () => {
    const cancel = vi.fn();
    const failure = new Error("connection closed");
    await expect(
      openFileInExternalBrowser({
        threadRef,
        filePath: "artifacts/report.html",
        httpBaseUrl: "http://environment.test:1234",
        createAssetUrl: vi.fn(async () => Promise.reject(failure)),
        beginOpen: () => ({ open: vi.fn(), cancel }),
      }),
    ).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("closes the reserved target when navigation fails", async () => {
    const cancel = vi.fn();
    const failure = new Error("blocked");
    await expect(
      openFileInExternalBrowser({
        threadRef,
        filePath: "artifacts/report.pdf",
        httpBaseUrl: "http://environment.test:1234",
        createAssetUrl: vi.fn(async () =>
          AsyncResult.success(assetResult("/api/assets/token/report.pdf")),
        ),
        beginOpen: () => ({
          open: vi.fn(async () => Promise.reject(failure)),
          cancel,
        }),
      }),
    ).rejects.toBe(failure);
    expect(cancel).toHaveBeenCalledOnce();
  });
});

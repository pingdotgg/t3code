import type { AssetCreateUrlResult, ScopedThreadRef } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";

import { isBrowserPreviewFile, openFileInExternalBrowser } from "./openFileInPreview";

const threadRef = {
  environmentId: "local" as ScopedThreadRef["environmentId"],
  threadId: "thread-1" as ScopedThreadRef["threadId"],
};

const assetUrlResult = (relativeUrl: string): AssetCreateUrlResult => ({
  relativeUrl,
  expiresAt: 1_750_000_000_000,
});

describe("isBrowserPreviewFile", () => {
  it.each(["report.html", "doc.HTM", "paper.pdf", "nested/dir/page.html?x=1#top"])(
    "accepts %s",
    (path) => {
      expect(isBrowserPreviewFile(path)).toBe(true);
    },
  );

  it.each(["notes.md", "index.html.bak", "script.js"])("rejects %s", (path) => {
    expect(isBrowserPreviewFile(path)).toBe(false);
  });
});

describe("openFileInExternalBrowser", () => {
  it("opens the resolved asset URL externally", async () => {
    const createAssetUrl = vi
      .fn()
      .mockResolvedValue(AsyncResult.success(assetUrlResult("/api/assets/token/report.html")));
    const openExternal = vi.fn().mockResolvedValue(undefined);

    const result = await openFileInExternalBrowser({
      threadRef,
      filePath: "artifacts/report.html",
      httpBaseUrl: "http://environment.test:1234",
      createAssetUrl,
      openExternal,
    });

    expect(result._tag).toBe("Success");
    expect(createAssetUrl).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: "artifacts/report.html",
        },
      },
    });
    expect(openExternal).toHaveBeenCalledWith(
      "http://environment.test:1234/api/assets/token/report.html",
    );
  });

  it("propagates asset URL failures without opening anything", async () => {
    const failure = AsyncResult.failure(Cause.fail(new Error("no such file")));
    const createAssetUrl = vi.fn().mockResolvedValue(failure);
    const openExternal = vi.fn();

    const result = await openFileInExternalBrowser({
      threadRef,
      filePath: "artifacts/report.html",
      httpBaseUrl: "http://environment.test:1234",
      createAssetUrl,
      openExternal,
    });

    expect(result._tag).toBe("Failure");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("fails on an unresolvable asset URL without opening anything", async () => {
    const createAssetUrl = vi
      .fn()
      .mockResolvedValue(AsyncResult.success(assetUrlResult("/api/assets/token/report.html")));
    const openExternal = vi.fn();

    const result = await openFileInExternalBrowser({
      threadRef,
      filePath: "artifacts/report.html",
      httpBaseUrl: "not a base url",
      createAssetUrl,
      openExternal,
    });

    expect(result._tag).toBe("Failure");
    expect(openExternal).not.toHaveBeenCalled();
  });
});

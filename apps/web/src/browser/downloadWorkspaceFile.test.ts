import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import { downloadWorkspaceFile, startBrowserDownload } from "./downloadWorkspaceFile";

const threadRef = {
  environmentId: EnvironmentId.make("environment-1"),
  threadId: ThreadId.make("thread-1"),
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("downloadWorkspaceFile", () => {
  it("keeps fallback navigation out of the current app", () => {
    const anchor = {
      click: vi.fn(),
      download: "",
      hidden: false,
      href: "",
      rel: "",
      remove: vi.fn(),
      target: "",
    };
    const appendChild = vi.fn();
    vi.stubGlobal("document", {
      body: { appendChild },
      createElement: vi.fn(() => anchor),
    });

    startBrowserDownload("https://environment.example/api/assets/token/build.zip", "build.zip");

    expect(anchor).toMatchObject({
      download: "build.zip",
      hidden: true,
      href: "https://environment.example/api/assets/token/build.zip",
      rel: "noopener",
      target: "_blank",
    });
    expect(appendChild).toHaveBeenCalledWith(anchor);
    expect(anchor.click).toHaveBeenCalledOnce();
    expect(anchor.remove).toHaveBeenCalledOnce();
  });

  it("requests an attachment URL and starts the browser download", async () => {
    const createAssetUrl = vi.fn().mockResolvedValue(
      AsyncResult.success({
        relativeUrl: "/api/assets/token/build.zip",
        expiresAt: Date.now() + 1_000,
      }),
    );
    const startDownload = vi.fn();

    const result = await downloadWorkspaceFile({
      threadRef,
      filePath: "/workspace/artifacts/build.zip",
      httpBaseUrl: "https://environment.example/base/",
      createAssetUrl,
      startDownload,
    });

    expect(result._tag).toBe("Success");
    expect(createAssetUrl).toHaveBeenCalledWith({
      environmentId: threadRef.environmentId,
      input: {
        resource: {
          _tag: "workspace-file",
          threadId: threadRef.threadId,
          path: "/workspace/artifacts/build.zip",
          disposition: "attachment",
        },
      },
    });
    expect(startDownload).toHaveBeenCalledWith(
      "https://environment.example/api/assets/token/build.zip",
      "build.zip",
    );
  });

  it("does not start a download when the asset request fails", async () => {
    const failure = Cause.fail(new Error("asset unavailable"));
    const startDownload = vi.fn();

    const result = await downloadWorkspaceFile({
      threadRef,
      filePath: "artifact.bin",
      httpBaseUrl: "https://environment.example/",
      createAssetUrl: vi.fn().mockResolvedValue(AsyncResult.failure(failure)),
      startDownload,
    });

    expect(result).toEqual(AsyncResult.failure(failure));
    expect(startDownload).not.toHaveBeenCalled();
  });
});

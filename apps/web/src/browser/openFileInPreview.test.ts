vi.mock("~/state/taskWorkbench", () => ({ canLaunchWorkbenchOwner: vi.fn(() => true) }));
import { EnvironmentId, ThreadId, type PreviewSessionSnapshot } from "@t3tools/contracts";
import { AsyncResult } from "effect/unstable/reactivity";
import * as Cause from "effect/Cause";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const { applySnapshot, rememberUrl, openBrowser, supported } = vi.hoisted(() => ({
  applySnapshot: vi.fn(),
  rememberUrl: vi.fn(),
  openBrowser: vi.fn(),
  supported: vi.fn(() => true),
}));
vi.mock("~/assets/assetUrls", async () => {
  const { resolveAssetUrl } = await import("@t3tools/client-runtime/state/assets");
  return { resolveAssetUrl };
});
vi.mock("~/previewStateStore", () => ({
  applyPreviewServerSnapshot: applySnapshot,
  rememberPreviewUrl: rememberUrl,
  isPreviewSupportedInRuntime: supported,
}));
vi.mock("~/rightPanelStore", () => ({ useRightPanelStore: { getState: () => ({ openBrowser }) } }));
vi.mock("./browserDefaults", () => ({
  resolveBrowserDefaults: vi.fn(async () => ({ viewport: { _tag: "fill" }, profileId: "default" })),
  browserDefaultOpenViewport: () => ({ _tag: "fill" }),
  browserDefaultOpenProfileId: () => "default",
}));

import { resolveBrowserDefaults } from "./browserDefaults";
import { canLaunchWorkbenchOwner } from "~/state/taskWorkbench";
import { openFileInPreview, openUrlInPreview } from "./openFileInPreview";

const ownerRef = {
  environmentId: EnvironmentId.make("remote"),
  threadId: ThreadId.make("task:task-a"),
};
const snapshot: PreviewSessionSnapshot = {
  threadId: ownerRef.threadId,
  tabId: "tab-a",
  navStatus: { _tag: "Idle" },
  canGoBack: false,
  canGoForward: false,
  updatedAt: "2026-09-13T12:00:00Z",
};
function fixture() {
  return {
    ownerRef,
    filePath: "/foreign-checkout/docs/preview.html",
    sourceCwd: "/foreign-checkout",
    httpBaseUrl: "https://remote.example/",
    createAssetUrl: vi.fn(async () =>
      AsyncResult.success({
        relativeUrl: "/api/assets/token/docs/preview.html",
        expiresAt: 999999,
      }),
    ),
    openPreview: vi.fn(async () => AsyncResult.success(snapshot)),
  };
}

describe("openFileInPreview", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    supported.mockReturnValue(true);
  });

  it("mints from the foreign checkout and opens under the task owner on its environment", async () => {
    const input = fixture();
    expect((await openFileInPreview(input))._tag).toBe("Success");
    expect(input.createAssetUrl).toHaveBeenCalledWith({
      environmentId: ownerRef.environmentId,
      input: {
        resource: {
          _tag: "draft-workspace-file",
          cwd: "/foreign-checkout",
          path: "docs/preview.html",
        },
      },
    });
    expect(input.openPreview).toHaveBeenCalledWith({
      environmentId: ownerRef.environmentId,
      input: {
        threadId: ownerRef.threadId,
        url: "https://remote.example/api/assets/token/docs/preview.html",
        viewport: { _tag: "fill" },
        profileId: "default",
      },
    });
    expect(applySnapshot).toHaveBeenCalledWith(ownerRef, snapshot);
    expect(openBrowser).toHaveBeenCalledWith(ownerRef, "tab-a");
    expect(input.createAssetUrl.mock.invocationCallOrder[0]).toBeLessThan(
      input.openPreview.mock.invocationCallOrder[0]!,
    );
  });

  it("keeps outside-root documents exact and preserves source across an async navigation", async () => {
    const input = fixture();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    input.createAssetUrl.mockImplementation(async () => {
      await gate;
      return AsyncResult.success({
        relativeUrl: "/api/assets/token/report.pdf",
        expiresAt: 999999,
      });
    });
    const source = { cwd: "/foreign-checkout", ownerRef };
    const pending = openFileInPreview({
      ...input,
      filePath: "/outside/report.pdf",
      sourceCwd: source.cwd,
      ownerRef: source.ownerRef,
    });
    source.cwd = "/new-primary";
    source.ownerRef = { ...ownerRef, threadId: ThreadId.make("task:other") };
    release();
    await pending;
    expect(input.createAssetUrl).toHaveBeenCalledWith({
      environmentId: ownerRef.environmentId,
      input: {
        resource: {
          _tag: "draft-workspace-file",
          cwd: "/foreign-checkout",
          path: "/outside/report.pdf",
        },
      },
    });
    expect(openBrowser).toHaveBeenCalledWith(ownerRef, "tab-a");
  });

  it("does not mint or open without a source workspace", async () => {
    const input = fixture();
    expect((await openFileInPreview({ ...input, sourceCwd: undefined }))._tag).toBe("Failure");
    expect(input.createAssetUrl).not.toHaveBeenCalled();
    expect(input.openPreview).not.toHaveBeenCalled();
  });

  it("does not open a tab when minting fails", async () => {
    const input = fixture();
    const failure = () =>
      AsyncResult.failure<Awaited<ReturnType<typeof input.createAssetUrl>>["value"], Error>(
        Cause.fail(new Error("missing file")),
      );
    expect(
      (await openFileInPreview({ ...input, createAssetUrl: async () => failure() }))._tag,
    ).toBe("Failure");
    expect(input.openPreview).not.toHaveBeenCalled();
    expect(openBrowser).not.toHaveBeenCalled();
  });
});

it("blocks cached browser creation before the RPC", async () => {
  vi.mocked(canLaunchWorkbenchOwner).mockReturnValueOnce(false);
  const input = fixture();
  expect((await openUrlInPreview({ ...input, url: "https://example.com" }))._tag).toBe("Failure");
  expect(input.openPreview).not.toHaveBeenCalled();
});

it("checks launch authority after a delayed settings read", async () => {
  let release!: () => void;
  const wait = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(resolveBrowserDefaults).mockImplementationOnce(async () => {
    await wait;
    return {
      viewport: { _tag: "fill" },
      profileId: "default",
      zoomFactor: 1,
      appearance: "system",
      autoShowFloatingPreview: true,
      profiles: [],
    };
  });
  const input = fixture();
  const pending = openUrlInPreview({ ...input, url: "https://example.com" });
  vi.mocked(canLaunchWorkbenchOwner).mockReturnValueOnce(false);
  release();
  expect((await pending)._tag).toBe("Failure");
  expect(input.openPreview).not.toHaveBeenCalled();
});

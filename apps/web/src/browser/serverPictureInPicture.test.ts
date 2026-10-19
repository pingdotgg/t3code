import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

import { applyPreviewServerSnapshot, resetPreviewStateForTests } from "~/previewStateStore";
import { closeServerPictureInPicture, openServerPictureInPicture } from "./serverPictureInPicture";

vi.mock("~/state/previewStream", () => ({
  readPreviewStreamAccess: async () => ({}),
}));
vi.mock("@t3tools/client-runtime/preview/server-browser-stream", () => ({
  createPreviewFramePainter: () => ({ paint: vi.fn(), stop: vi.fn() }),
  createPreviewStreamClient: () => ({ stop: vi.fn() }),
}));

const ref = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const stopTrack = vi.fn();
const exitPictureInPicture = vi.fn(async () => {});

function navigate(url: string, tabId = "tab") {
  applyPreviewServerSnapshot(ref, {
    threadId: ref.threadId,
    tabId,
    navStatus: { _tag: "Success", url, title: "Document" },
    canGoBack: true,
    canGoForward: false,
    updatedAt: new Date().toISOString(),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  resetPreviewStateForTests();
  const video = {
    style: { cssText: "" },
    readyState: 4,
    play: async () => {},
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    remove: vi.fn(),
    requestPictureInPicture: vi.fn(async () => {}),
  };
  vi.stubGlobal("HTMLMediaElement", { HAVE_METADATA: 1 });
  vi.stubGlobal("document", {
    pictureInPictureEnabled: true,
    pictureInPictureElement: video,
    exitPictureInPicture,
    body: { append: vi.fn() },
    createElement: (tag: string) =>
      tag === "video"
        ? video
        : {
            getContext: () => ({ fillRect: vi.fn() }),
            captureStream: () => ({ getTracks: () => [{ stop: stopTrack }] }),
          },
  });
  navigate("https://environment.test/api/assets/token/index.html");
});

afterEach(() => {
  closeServerPictureInPicture();
  resetPreviewStateForTests();
  vi.unstubAllGlobals();
});

it("closes the video window and stream when its tab becomes a client-rendered PDF", async () => {
  await openServerPictureInPicture({ ...ref, tabId: "tab", seed: null });
  navigate("https://environment.test/api/assets/token/guide.PDF#page=2");
  expect(exitPictureInPicture).toHaveBeenCalledOnce();
  expect(stopTrack).toHaveBeenCalledOnce();
});

it("keeps PiP for ordinary navigation and PDFs in another tab", async () => {
  await openServerPictureInPicture({ ...ref, tabId: "tab", seed: null });
  navigate("https://environment.test/api/assets/token/guide.pdf", "another-tab");
  navigate("https://example.com/paper.pdf");
  navigate("https://environment.test/api/assets/token/next.html");
  expect(exitPictureInPicture).not.toHaveBeenCalled();
  expect(stopTrack).not.toHaveBeenCalled();
});

it("stops observing navigation when a PiP session closes", async () => {
  await openServerPictureInPicture({ ...ref, tabId: "tab", seed: null });
  closeServerPictureInPicture();
  navigate("https://environment.test/api/assets/token/guide.pdf");
  expect(exitPictureInPicture).toHaveBeenCalledOnce();
  expect(stopTrack).toHaveBeenCalledOnce();
});

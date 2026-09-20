import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import type { DesktopPreviewRecordingArtifact } from "@t3tools/contracts";
import type { runAttachmentUploadCycle } from "@t3tools/client-runtime/state/attachments";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";

const { uploadCycle, removeUpload } = vi.hoisted(() => ({
  uploadCycle: vi.fn<typeof runAttachmentUploadCycle>(),
  removeUpload: vi.fn(),
}));
vi.mock("@t3tools/client-runtime/state/attachments", () => ({
  runAttachmentUploadCycle: uploadCycle,
  deletePendingAttachmentUpload: removeUpload,
}));
vi.mock("~/rpc/atomRegistry", () => ({ appAtomRegistry: {} }));
vi.mock("~/state/attachments", () => ({ attachmentEnvironment: {} }));
vi.mock("~/state/session", () => ({ readPreparedConnection: vi.fn() }));

import { uploadBrowserRecording } from "./browserRecordingUpload";

const threadRef = { environmentId: EnvironmentId.make("env"), threadId: ThreadId.make("thread") };
const artifact: DesktopPreviewRecordingArtifact = {
  id: "recording",
  tabId: "tab",
  path: "/tmp/recording.webm",
  mimeType: "video/webm",
  sizeBytes: 5,
  createdAt: "2026-09-08T00:00:00.000Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(1000);
  uploadCycle.mockImplementation(async ({ transport }) => {
    const transfer = transport("http://example.test/upload");
    try {
      await transfer.done;
      return { status: "uploaded", attachmentId: "uploaded-file" };
    } catch (error) {
      return { status: "failed", step: "transfer", attachmentId: "uploaded-file", error };
    }
  });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("uploads within a short host budget without reserving response grace twice", async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 200 }));
  vi.stubGlobal("fetch", fetch);
  await expect(
    uploadBrowserRecording(threadRef, artifact, new Blob(["video"]), 1100),
  ).resolves.toBe("uploaded-file");
  expect(fetch).toHaveBeenCalledOnce();
  expect(removeUpload).not.toHaveBeenCalled();
});

it("reports a transport failure within the final second as a transfer error", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(null, { status: 500 })),
  );
  await expect(
    uploadBrowserRecording(threadRef, artifact, new Blob(["video"]), 1500),
  ).rejects.toMatchObject({ _tag: "PreviewAutomationRecordingTransferError" });
});

it("does not send bytes after the host deadline and releases the pending attachment", async () => {
  const fetch = vi.fn();
  vi.stubGlobal("fetch", fetch);
  await expect(
    uploadBrowserRecording(threadRef, artifact, new Blob(["video"]), 1000),
  ).rejects.toMatchObject({
    _tag: "PreviewAutomationRecordingDeadlineExpiredError",
  });
  expect(fetch).not.toHaveBeenCalled();
  expect(removeUpload).toHaveBeenCalledWith(
    expect.objectContaining({ attachmentId: "uploaded-file" }),
  );
});

it.each(["http", "transport"])(
  "preserves a late %s failure instead of making it retryable",
  async (kind) => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        vi.setSystemTime(1600);
        if (kind === "transport") throw new TypeError("connection failed");
        return new Response(null, { status: 500 });
      }),
    );
    await expect(
      uploadBrowserRecording(threadRef, artifact, new Blob(["video"]), 1500),
    ).rejects.toMatchObject({ _tag: "PreviewAutomationRecordingTransferError" });
  },
);

it("classifies a transport deadline abort as retryable", async () => {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    }),
  );
  await expect(
    uploadBrowserRecording(threadRef, artifact, new Blob(["video"]), 1500),
  ).rejects.toMatchObject({ _tag: "PreviewAutomationRecordingDeadlineExpiredError" });
});

import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  retain: vi.fn(),
  share: vi.fn(),
  exists: vi.fn(),
}));

vi.mock("../state/use-composer-drafts", () => ({
  retainComposerAttachmentFileForPreview: mocks.retain,
}));
vi.mock("./attachmentDownload", () => ({ shareLocalAttachment: mocks.share }));
vi.mock("expo-file-system", () => ({
  File: class {
    constructor(readonly uri: string) {}
    get exists(): boolean {
      return mocks.exists(this.uri);
    }
  },
  Paths: {
    document: {
      uri: "file:///var/mobile/Containers/Data/Application/22222222-2222-4222-8222-222222222222/Documents/",
    },
  },
}));

import { loadLocalAttachmentPreview } from "./localAttachmentPreview";

const attachment = {
  type: "file" as const,
  id: "draft-video",
  name: "clip.mov",
  mimeType: "video/quicktime",
  sizeBytes: 12,
  fileUri:
    "file:///var/mobile/Containers/Data/Application/11111111-1111-4111-8111-111111111111/Documents/t3-composer-attachments/33333333-3333-4333-8333-333333333333-clip.mov",
};

beforeEach(() => {
  mocks.retain.mockReset();
  mocks.share.mockReset();
  mocks.exists.mockReset();
  mocks.retain.mockImplementation(() => vi.fn());
  mocks.exists.mockReturnValue(true);
  mocks.share.mockResolvedValue(undefined);
});

describe("loadLocalAttachmentPreview", () => {
  it("retains and shares a PDF with its original filename and type", async () => {
    const pdf = { ...attachment, name: "report.pdf", mimeType: "application/pdf" };
    const preview = await loadLocalAttachmentPreview(pdf, new AbortController().signal);
    await preview!.share(new AbortController().signal);
    expect(mocks.share).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: { name: "report.pdf", mimeType: "application/pdf" },
      }),
    );
    expect(mocks.retain.mock.results[0]!.value).not.toHaveBeenCalled();
    preview!.dispose();
    expect(mocks.retain.mock.results[0]!.value).toHaveBeenCalledTimes(1);
  });
  it("resolves the current iOS container and releases its playback lease once", async () => {
    const preview = await loadLocalAttachmentPreview(attachment, new AbortController().signal);
    expect(preview?.uri).toContain("/22222222-2222-4222-8222-222222222222/Documents/");
    expect(mocks.retain).toHaveBeenCalledWith(attachment);
    const release = mocks.retain.mock.results[0]!.value;
    expect(release).not.toHaveBeenCalled();
    preview?.dispose();
    preview?.dispose();
    expect(release).toHaveBeenCalledTimes(1);
  });

  it.each([undefined, "share-button"])(
    "keeps a separate share lease after playback closes (source: %s)",
    async (sourceIdentifier) => {
      const shared = Promise.withResolvers<void>();
      mocks.share.mockReturnValue(shared.promise);
      const preview = await loadLocalAttachmentPreview(attachment, new AbortController().signal);
      const share = preview!.share(new AbortController().signal, sourceIdentifier);
      expect(mocks.retain).toHaveBeenCalledTimes(2);
      const releasePlayback = mocks.retain.mock.results[0]!.value;
      const releaseShare = mocks.retain.mock.results[1]!.value;
      preview!.dispose();
      expect(releasePlayback).toHaveBeenCalledTimes(1);
      expect(releaseShare).not.toHaveBeenCalled();
      shared.resolve();
      await share;
      expect(releaseShare).toHaveBeenCalledTimes(1);
    },
  );

  it("releases a failed share while keeping playback retained", async () => {
    mocks.share.mockRejectedValue(new Error("Sharing unavailable"));
    const preview = await loadLocalAttachmentPreview(attachment, new AbortController().signal);
    await expect(preview!.share(new AbortController().signal)).rejects.toThrow(
      "Sharing unavailable",
    );
    expect(mocks.retain.mock.results[1]!.value).toHaveBeenCalledTimes(1);
    expect(mocks.retain.mock.results[0]!.value).not.toHaveBeenCalled();
    preview!.dispose();
  });

  it("releases a load canceled during native module loading", async () => {
    const controller = new AbortController();
    const loading = loadLocalAttachmentPreview(attachment, controller.signal);
    controller.abort();
    await expect(loading).resolves.toBeNull();
    expect(mocks.retain.mock.results[0]!.value).toHaveBeenCalledTimes(1);
    expect(mocks.exists).not.toHaveBeenCalled();
  });

  it("reports missing files and releases their lease", async () => {
    mocks.exists.mockReturnValue(false);
    await expect(
      loadLocalAttachmentPreview(attachment, new AbortController().signal),
    ).rejects.toThrow("This attachment is no longer available. Attach the file again.");
    expect(mocks.retain.mock.results[0]!.value).toHaveBeenCalledTimes(1);
  });

  it("does not start sharing a disposed preview", async () => {
    const preview = await loadLocalAttachmentPreview(attachment, new AbortController().signal);
    preview!.dispose();
    await preview!.share(new AbortController().signal);
    expect(mocks.share).not.toHaveBeenCalled();
    expect(mocks.retain).toHaveBeenCalledTimes(1);
  });
});

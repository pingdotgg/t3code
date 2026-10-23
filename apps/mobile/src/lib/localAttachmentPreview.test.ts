import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  retain: vi.fn(),
  share: vi.fn(),
  exists: vi.fn(),
}));

vi.mock("./composerAttachmentPreviewRetention", () => ({
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
  it("keeps an image MIME type when its filename has a video extension", async () => {
    const image = {
      ...attachment,
      type: "image" as const,
      name: "photo.mov",
      mimeType: "image/png",
      previewUri: attachment.fileUri,
    };
    const preview = await loadLocalAttachmentPreview(image, new AbortController().signal);
    await preview!.share(new AbortController().signal);
    expect(mocks.share).toHaveBeenCalledWith(
      expect.objectContaining({
        attachment: { name: "photo.mov", mimeType: "image/png" },
      }),
    );
    preview!.dispose();
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
});

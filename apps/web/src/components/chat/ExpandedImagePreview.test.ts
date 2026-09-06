import { afterEach, describe, expect, it, vi } from "vite-plus/test";

import type { ComposerFileAttachment } from "../../composerDraftStore";
import {
  attachVideoThumbnail,
  buildExpandedImagePreview,
  resolveMarkdownMediaPreview,
} from "./ExpandedImagePreview";

describe("resolveMarkdownMediaPreview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each([
    ["t3code:", "https:"],
    ["t3code-dev:", "https:"],
    ["http:", "http:"],
    ["https:", "https:"],
  ])(
    "resolves protocol-relative media on %s without changing its source",
    async (pageProtocol, mediaProtocol) => {
      vi.stubGlobal("window", { location: { protocol: pageProtocol } });
      const source = "//cdn.example.com/recording.mp4?token=a%2FB&v=1#t=2";
      const preview = await resolveMarkdownMediaPreview({
        source,
        createAssetUrl: async () => {
          throw new Error("Remote media must not request a local asset URL.");
        },
      });

      expect(preview?.images[0]).toMatchObject({
        src: `${mediaProtocol}${source}`,
        originalUrl: source,
        actionsSource: {
          src: `${mediaProtocol}${source}`,
          reference: { kind: "url", url: source },
        },
      });
    },
  );
});

describe("buildExpandedImagePreview", () => {
  it("builds a video preview for a local video attachment", () => {
    const file = new File([new Uint8Array([1, 2, 3])], "demo.mp4", { type: "video/mp4" });
    const attachment: ComposerFileAttachment = {
      type: "file",
      id: "video-1",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      file,
    };

    const preview = buildExpandedImagePreview([attachment], attachment.id);

    expect(preview).toMatchObject({
      images: [{ name: "demo.mp4", type: "video" }],
      index: 0,
    });
    expect(preview?.images[0]?.src).toMatch(/^blob:/);
    URL.revokeObjectURL(preview?.images[0]?.src ?? "");
  });

  it("releases a video thumbnail URL when detached", async () => {
    const video = { src: "" } as HTMLVideoElement;
    const file = new File([new Uint8Array([1, 2, 3])], "demo.mp4", { type: "video/mp4" });

    const detach = attachVideoThumbnail(video, file);
    const url = video.src;

    expect((await fetch(url)).ok).toBe(true);
    detach();
    await expect(fetch(url)).rejects.toThrow();
  });

  it("uses the thumbnail previewUrl for composer images instead of the original file", () => {
    const thumbnailBytes = new Uint8Array([10, 20, 30, 40]);
    const previewUrl = URL.createObjectURL(new Blob([thumbnailBytes], { type: "image/jpeg" }));
    const file = new File([new Uint8Array(8_192).fill(9)], "huge.png", { type: "image/png" });
    const image = {
      type: "image" as const,
      id: "img-1",
      name: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
      previewUrl,
      file,
    };

    const createObjectURL = vi.spyOn(URL, "createObjectURL");
    const preview = buildExpandedImagePreview([image], image.id);

    expect(preview?.images[0]?.src).toBe(previewUrl);
    expect(createObjectURL).not.toHaveBeenCalled();
    createObjectURL.mockRestore();
    URL.revokeObjectURL(previewUrl);
  });

  it("prefers displayPreviewUrl over previewUrl for raster images", () => {
    const previewUrl = URL.createObjectURL(
      new Blob([new Uint8Array([1, 2, 3])], { type: "image/jpeg" }),
    );
    const displayPreviewUrl = URL.createObjectURL(
      new Blob([new Uint8Array([4, 5, 6])], { type: "image/jpeg" }),
    );
    const image = {
      type: "image" as const,
      id: "img-display",
      name: "photo.png",
      mimeType: "image/png",
      sizeBytes: 3,
      previewUrl,
      displayPreviewUrl,
    };

    const preview = buildExpandedImagePreview([image], image.id);

    expect(preview?.images[0]?.src).toBe(displayPreviewUrl);
    URL.revokeObjectURL(previewUrl);
    URL.revokeObjectURL(displayPreviewUrl);
  });
});

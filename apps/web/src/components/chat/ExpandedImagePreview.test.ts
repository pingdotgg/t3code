import { describe, expect, it, vi } from "vite-plus/test";

import type { ComposerFileAttachment } from "../../composerDraftStore";
import {
  attachVideoThumbnail,
  buildExpandedImagePreview,
  downloadVideoPreview,
} from "./ExpandedImagePreview";

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

  it("downloads a video through a local blob URL", async () => {
    vi.useFakeTimers();
    const source = URL.createObjectURL(new Blob([new Uint8Array([1, 2, 3])]));
    const click = vi.fn();
    const anchor = { href: "", download: "", click };
    vi.stubGlobal("document", { createElement: () => anchor });

    try {
      await downloadVideoPreview(source, "demo.mp4");

      expect(anchor.download).toBe("demo.mp4");
      expect(anchor.href).toMatch(/^blob:/);
      expect(anchor.href).not.toBe(source);
      expect(click).toHaveBeenCalledOnce();
      expect((await fetch(anchor.href)).ok).toBe(true);

      await vi.runAllTimersAsync();
      await expect(fetch(anchor.href)).rejects.toThrow();
    } finally {
      URL.revokeObjectURL(source);
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });
});

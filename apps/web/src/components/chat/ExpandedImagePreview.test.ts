import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import type { ComposerFileAttachment } from "../../composerDraftStore";
import {
  wrapExpandedImageIndex,
  attachVideoThumbnail,
  buildAttachmentVideoPreview,
  buildExpandedImagePreview,
  resolveMarkdownMediaPreview,
} from "./ExpandedImagePreview";

describe("resolveMarkdownMediaPreview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("opens private PR media links through their environment and retains a renewable resource", async () => {
    const environmentId = EnvironmentId.make("bitbucket-environment");
    const createAssetUrl = vi.fn(async () =>
      AsyncResult.success({ relativeUrl: "/api/assets/signed/demo.mp4", expiresAt: 1234 }),
    );
    const preview = await resolveMarkdownMediaPreview({
      source: "https://bitbucket.org/acme/web/downloads/demo.mp4#t=2",
      cwd: "/repo",
      environmentId,
      pullRequestMedia: true,
      httpBaseUrl: "https://remote.example",
      createAssetUrl,
    });
    const asset = {
      environmentId,
      resource: {
        _tag: "bitbucket-media",
        url: "https://api.bitbucket.org/2.0/repositories/acme/web/downloads/demo.mp4",
      },
    };
    expect(createAssetUrl).toHaveBeenCalledExactlyOnceWith({
      environmentId,
      input: { resource: asset.resource },
    });
    expect(preview?.images[0]).toMatchObject({
      type: "video",
      src: "https://remote.example/api/assets/signed/demo.mp4#t=2",
      srcFragment: "#t=2",
      actionsSource: { asset },
    });
  });

  it.each([
    "https://bitbucket.org/acme/web/downloads/demo.mp4?download=1#t=2",
    "https://raw.githubusercontent.com/acme/web/main/demo.mp4#t=2",
  ])("keeps public PR media links usable without signing: %s", async (source) => {
    const unsupported = new Error("Unsupported asset resource: bitbucket-media");
    const createAssetUrl = vi.fn().mockRejectedValue(unsupported);
    const preview = await resolveMarkdownMediaPreview({
      source,
      cwd: "/repo",
      environmentId: EnvironmentId.make("old-server"),
      pullRequestMedia: true,
      httpBaseUrl: "https://remote.example",
      createAssetUrl,
    });
    expect(preview?.images[0]).toMatchObject({
      src: source,
      originalUrl: source,
      type: "video",
    });
    expect(preview?.images[0]?.actionsSource?.asset).toBeUndefined();
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
  it("keeps MIME type for stored images without a filename extension", () => {
    const preview = buildExpandedImagePreview(
      [
        {
          type: "image",
          id: "heic-1",
          name: "photo",
          mimeType: "image/heic",
          sizeBytes: 3,
          previewUrl: "blob:heic",
        },
      ],
      "heic-1",
    );
    expect(preview?.images[0]).toMatchObject({
      name: "photo",
      mimeType: "image/heic",
      src: "blob:heic",
    });
  });

  it("builds a signed-asset preview for a persisted video attachment", () => {
    const preview = buildAttachmentVideoPreview(EnvironmentId.make("environment-1"), {
      type: "file",
      id: "attachment-video-1",
      name: "demo.mp4",
      mimeType: "video/mp4",
      sizeBytes: 42,
    });

    expect(preview).toEqual({
      images: [
        {
          src: null,
          name: "demo.mp4",
          type: "video",
          actionsSource: {
            kind: "video",
            name: "demo.mp4",
            src: null,
            asset: {
              environmentId: "environment-1",
              resource: {
                _tag: "attachment",
                attachmentId: "attachment-video-1",
                fileName: "demo.mp4",
                mimeType: "video/mp4",
              },
            },
          },
        },
      ],
      index: 0,
    });
  });

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
});

it("keeps backward media navigation visible beyond a complete cycle", () => {
  const images = ["first", "second"];
  expect(
    Array.from({ length: 7 }, (_, step) => images[wrapExpandedImageIndex(-step, images.length)]),
  ).toEqual(["first", "second", "first", "second", "first", "second", "first"]);
  let index = 0;
  for (let step = 1; step <= 7; step++) {
    index = wrapExpandedImageIndex(index - 1, images.length);
    expect(images[index]).toBe(step % 2 === 1 ? "second" : "first");
  }
});

import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";

import { buildExpandedImagePreview, resolveMarkdownMediaPreview } from "./ExpandedImagePreview";

describe("resolveMarkdownMediaPreview", () => {
  it("keeps the originating environment for remote images opened outside a thread", async () => {
    const environmentId = EnvironmentId.make("pull-request-environment");
    const preview = await resolveMarkdownMediaPreview({
      source: "https://images.example.com/image.png",
      environmentId,
      createAssetUrl: vi.fn(),
    });
    expect(preview?.images[0]?.actionsSource).toMatchObject({
      environmentId,
      src: "https://images.example.com/image.png",
    });
  });

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
});

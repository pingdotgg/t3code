import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";

import { buildExpandedImagePreview, resolveMarkdownMediaPreview } from "./ExpandedImagePreview";

describe("resolveMarkdownMediaPreview", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it.each(["gif", "mp4", "protocol-relative.gif"])(
    "authenticates a PR thumbnail's linked %s preview without a thread",
    async (extension) => {
      const protocolRelative = extension === "protocol-relative.gif";
      extension = protocolRelative ? "gif" : extension;
      vi.stubGlobal("window", { location: { protocol: "http:" } });
      const url = `https://dev.azure.com/org/project/_apis/git/repositories/repo/pullRequests/42/attachments/demo.${extension}#t=2`;
      const source = protocolRelative ? url.slice(6) : url;
      const environmentId = EnvironmentId.make("azure-environment");
      const resource = { _tag: "azure-devops-media", cwd: "/repo", url: url.split("#")[0] };
      const createAssetUrl = vi.fn(async () =>
        AsyncResult.success({
          relativeUrl: `/api/assets/signed/demo.${extension}`,
          expiresAt: 1000,
        }),
      );
      const preview = await resolveMarkdownMediaPreview({
        source,
        cwd: "/repo",
        environmentId,
        sourceControlMedia: true,
        httpBaseUrl: "https://remote.example/",
        createAssetUrl,
      });
      expect(createAssetUrl).toHaveBeenCalledWith({ environmentId, input: { resource } });
      expect(preview?.images[0]).toMatchObject({
        src: `https://remote.example/api/assets/signed/demo.${extension}#t=2`,
        originalUrl: source,
        ...(extension === "mp4" ? { type: "video" } : {}),
        actionsSource: { asset: { environmentId, resource } },
      });
    },
  );

  it("does not open private PR media directly when its environment is disconnected", async () => {
    await expect(
      resolveMarkdownMediaPreview({
        source:
          "https://dev.azure.com/org/project/_apis/git/repositories/repo/pullRequests/42/attachments/demo.mp4",
        cwd: "/repo",
        sourceControlMedia: true,
        createAssetUrl: vi.fn(),
      }),
    ).rejects.toThrow("Reconnect to this environment");
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

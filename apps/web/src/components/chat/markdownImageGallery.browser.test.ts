import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import {
  markdownImageGallery,
  markdownImageItems,
  resolveMarkdownImageGallery,
} from "./markdownImageGallery";
import { resolveMarkdownMediaPreview } from "./ExpandedImagePreview";

it("keeps the selected preview and other images available when a neighboring asset fails", async () => {
  const base =
    "https://dev.azure.com/org/project/_apis/git/repositories/repo/pullRequests/42/attachments";
  const environmentId = EnvironmentId.make("remote");
  const selected = { src: "https://remote.example/selected.gif", name: "Selected" };
  const failed = {
    src: "https://remote.example/thumbnail.gif",
    name: "Unavailable target",
    originalUrl: `${base}/failed.gif`,
  };
  const available = {
    src: `${base}/available.gif`,
    name: "Available",
    originalUrl: `${base}/available.gif`,
  };
  const createAssetUrl = vi.fn<Parameters<typeof resolveMarkdownMediaPreview>[0]["createAssetUrl"]>(
    async ({ input }) => {
      if ("url" in input.resource && input.resource.url.endsWith("failed.gif"))
        throw new Error("Asset unavailable");
      return AsyncResult.success({
        relativeUrl: "/api/assets/signed/available.gif",
        expiresAt: 2000,
      });
    },
  );
  const resolved = await resolveMarkdownImageGallery(
    { images: [selected, failed, available], index: 0 },
    {
      cwd: "/repo",
      environmentId,
      sourceControlMedia: true,
      httpBaseUrl: "https://remote.example",
      createAssetUrl,
    },
  );
  expect(resolved.index).toBe(0);
  expect(resolved.images[0]).toBe(selected);
  expect(resolved.images[1]).toBe(failed);
  expect(resolved.images[2]?.src).toBe("https://remote.example/api/assets/signed/available.gif");
  expect(createAssetUrl).toHaveBeenCalledTimes(2);
});

it.each([
  { linked: true, protocolRelative: false },
  { linked: false, protocolRelative: false },
  { linked: true, protocolRelative: true },
])(
  "keeps private gallery images authenticated ($linked, $protocolRelative)",
  async ({ linked, protocolRelative }) => {
    const base =
      "https://dev.azure.com/org/project/_apis/git/repositories/repo/pullRequests/42/attachments";
    const urls = [`${base}/first.gif#preview`, `${base}/second.gif#preview`].map((url) =>
      protocolRelative ? url.replace("https:", "") : url,
    );
    const container = document.createElement("div");
    container.setAttribute("data-image-gallery", "");
    document.body.append(container);
    using _cleanup = { [Symbol.dispose]: () => container.remove() };
    const images = urls.map((url, index) => {
      const parent = document.createElement(linked || index === 1 ? "a" : "span");
      if (parent instanceof HTMLAnchorElement) parent.href = url;
      const image = document.createElement("img");
      parent.append(image);
      container.append(parent);
      markdownImageItems.set(image, {
        src: `https://remote.example/thumb-${index}`,
        name: `Image ${index}`,
      });
      return image;
    });
    const environmentId = EnvironmentId.make("remote");
    const createAssetUrl = vi.fn<
      Parameters<typeof resolveMarkdownMediaPreview>[0]["createAssetUrl"]
    >(async ({ input }) =>
      AsyncResult.success({
        relativeUrl: `/api/assets/signed/${"url" in input.resource ? input.resource.url.split("/").pop() : "unexpected"}`,
        expiresAt: 2000,
      }),
    );
    const input = {
      source: urls[0]!,
      cwd: "/repo",
      environmentId,
      sourceControlMedia: true,
      httpBaseUrl: "https://remote.example",
      createAssetUrl,
    };
    const selected = (await resolveMarkdownMediaPreview(input))!.images[0]!;
    const gallery = await resolveMarkdownImageGallery(
      markdownImageGallery(images[0]!, selected),
      input,
    );
    const next = gallery.images[gallery.index + 1]!;
    expect(gallery.images).toHaveLength(2);
    expect(next.src).toBe("https://remote.example/api/assets/signed/second.gif#preview");
    expect(next.actionsSource?.asset).toEqual({
      environmentId,
      resource: {
        _tag: "azure-devops-media",
        cwd: "/repo",
        url: `${base}/second.gif`,
      },
    });
    if (!protocolRelative) expect(gallery.images[gallery.index]).toBe(selected);
    expect(gallery.images[gallery.index]?.src).toBe(
      "https://remote.example/api/assets/signed/first.gif#preview",
    );
    expect(createAssetUrl).toHaveBeenCalledTimes(2);
  },
);

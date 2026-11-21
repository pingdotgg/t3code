import { expect, it, vi } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { resolveMarkdownImageGallery } from "./markdownImageGallery";
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

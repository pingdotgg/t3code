import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { pullRequestImageRequest, pullRequestImageSource } from "./pullRequestMediaSource";

const location = {
  environmentId: EnvironmentId.make("test"),
  cwd: "/repo",
  repository: "enterprise/private",
};
const url = "https://github.com/user-attachments/assets/abc-123";

describe("PR media previews", () => {
  it("keeps every gallery image resolvable and the tapped image appears only once", () => {
    const first = pullRequestImageSource(url, location);
    const second = pullRequestImageSource(`${url}-second`, location);
    const selected = { ...second, sourceIdentifier: "tapped" };
    const gallery = filePreviewGallery(selected, [first, second]);
    expect(gallery).toEqual([first, selected]);
    expect(gallery).toMatchObject([
      { resource: { url, repository: location.repository } },
      { resource: { url: `${url}-second`, repository: location.repository } },
    ]);
  });

  it("authorizes host images the renderer loads itself and leaves others as written", async () => {
    const authorized: unknown[] = [];
    const authorize = async (_environmentId: unknown, resource: unknown) => {
      authorized.push(resource);
      return "https://env.test/asset/1";
    };
    const raw = "https://github.com/enterprise/private/raw/main/shot.png";
    await expect(pullRequestImageRequest(url, location, authorize)).resolves.toEqual({
      uri: "https://env.test/asset/1",
    });
    await expect(pullRequestImageRequest(raw, location, authorize)).resolves.toEqual({
      uri: "https://env.test/asset/1",
    });
    expect(authorized).toMatchObject([
      { url, repository: location.repository },
      { url: "https://raw.githubusercontent.com/enterprise/private/main/shot.png" },
    ]);
    await expect(
      pullRequestImageRequest("https://img.shields.io/badge/a-b-green.svg", location, authorize),
    ).resolves.toBeNull();
    await expect(pullRequestImageRequest(url, location, async () => null)).rejects.toThrow();
  });
});

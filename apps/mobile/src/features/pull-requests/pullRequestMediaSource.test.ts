import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { pullRequestImageGallery, pullRequestImageSource } from "./pullRequestMediaSource";

const location = {
  environmentId: EnvironmentId.make("test"),
  cwd: "/repo",
  repository: "enterprise/private",
};
const url = "https://github.com/user-attachments/assets/abc-123";

describe("PR media previews", () => {
  it("keeps every gallery image resolvable and the tapped image appears only once", () => {
    const protocolRelative =
      "//dev.azure.com/org/project/_apis/git/repositories/repo/pullRequests/42/attachments/demo.gif";
    for (const changeRequestUrl of [
      null,
      "https://dev.azure.com/org/project/_git/repo/pullrequest/42",
    ]) {
      expect(
        pullRequestImageGallery(
          `![Azure](${protocolRelative}) ![Video](${protocolRelative.replace(".gif", ".mp4")})`,
          location,
          changeRequestUrl,
        ),
      ).toEqual([pullRequestImageSource(`https:${protocolRelative}`, location)]);
    }
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
});

import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { mediaVideoPreviewUri, mediaVideoThumbnailKey } from "../../lib/videoPreviewSource";
import { pullRequestImageSource, pullRequestMediaSource } from "./pullRequestMediaSource";

const location = { environmentId: EnvironmentId.make("test"), cwd: "/repo" };
const url = "https://github.com/user-attachments/assets/abc-123";

describe("PR media previews", () => {
  it("renews Azure video and image capabilities in the destination environment", () => {
    const azure =
      "https://dev.azure.com/org/project/_apis/git/repositories/repo/pullRequests/42/attachments/demo.mp4";
    const source = {
      type: "media" as const,
      name: "Demo",
      mimeType: "video/mp4",
      ...pullRequestMediaSource(azure, location),
    };
    expect(source).toMatchObject({
      environmentId: location.environmentId,
      resource: { _tag: "azure-devops-media", cwd: "/repo", url: azure },
    });
    expect(mediaVideoPreviewUri(source, null)).toBeNull();
    expect(mediaVideoPreviewUri(source, "https://signed/renewed")).toBe("https://signed/renewed");
    expect(mediaVideoThumbnailKey(source)).toContain("azure-devops-media");
    expect(pullRequestImageSource(azure.replace(".mp4", ".gif"), location)).toMatchObject({
      kind: "image",
      resource: { _tag: "azure-devops-media" },
    });
  });
  it("keeps every gallery image resolvable and the tapped image appears only once", () => {
    const first = pullRequestImageSource(url, location);
    const second = pullRequestImageSource(`${url}-second`, location);
    const selected = { ...second, sourceIdentifier: "tapped" };
    const gallery = filePreviewGallery(selected, [first, second]);
    expect(gallery).toEqual([first, selected]);
    expect(gallery.every((item) => "resource" in item)).toBe(true);
  });
});

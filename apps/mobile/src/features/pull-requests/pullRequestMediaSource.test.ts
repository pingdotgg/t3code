import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { mediaVideoPreviewUri, mediaVideoThumbnailKey } from "../../lib/videoPreviewSource";
import { pullRequestImageSource, pullRequestMediaSource } from "./pullRequestMediaSource";

const location = { environmentId: EnvironmentId.make("test"), cwd: "/repo" };
const url = "https://github.com/user-attachments/assets/abc-123";

describe("PR media previews", () => {
  it("keeps a video resource pending until resolved and accepts refreshed capabilities", () => {
    const source = {
      type: "media" as const,
      name: "Video",
      mimeType: "video/mp4",
      ...pullRequestMediaSource(url, location),
    };
    expect(mediaVideoPreviewUri(source, null)).toBeNull();
    expect(mediaVideoPreviewUri(source, "https://signed/first")).toBe("https://signed/first");
    expect(mediaVideoPreviewUri(source, "https://signed/renewed")).toBe("https://signed/renewed");
    expect(mediaVideoThumbnailKey(source)).toContain("github-media");
  });

  it("keeps every gallery image resolvable and the tapped image appears only once", () => {
    const first = pullRequestImageSource(url, location);
    const second = pullRequestImageSource(`${url}-second`, location);
    const selected = { ...second, sourceIdentifier: "tapped" };
    const gallery = filePreviewGallery(selected, [first, second]);
    expect(gallery).toEqual([first, selected]);
    expect(gallery.every((item) => "resource" in item)).toBe(true);
  });

  it("resolves private Bitbucket downloads through the environment", () => {
    expect(
      pullRequestMediaSource("https://bitbucket.org/acme/web/downloads/demo.mp4#t=2", location),
    ).toEqual({
      environmentId: location.environmentId,
      fallbackUri: "https://bitbucket.org/acme/web/downloads/demo.mp4#t=2",
      srcFragment: "#t=2",
      resource: {
        _tag: "bitbucket-media",
        url: "https://api.bitbucket.org/2.0/repositories/acme/web/downloads/demo.mp4",
      },
    });
  });

  it("leaves custom-domain media as direct URLs", () => {
    const external = "https://drop.example/file.mp4";
    expect(pullRequestMediaSource(external, location)).toEqual({ uri: external });
  });
});

import { describe, expect, it } from "vite-plus/test";
import { EnvironmentId } from "@t3tools/contracts";
import { splitPullRequestBody } from "@t3tools/client-runtime/pull-request-markdown";
import { filePreviewGallery } from "../../lib/filePreviewGallery";
import { markdownReferenceDefinitions } from "../../lib/markdownDocument";
import { pullRequestImageSource, pullRequestMarkdownImages } from "./pullRequestMediaSource";

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

  it("populates mimeType and actionsSource for PR images", () => {
    expect(
      pullRequestImageSource("https://drop.example.com/shot.png?sig=1", null, "Before"),
    ).toEqual({
      kind: "image",
      uri: "https://drop.example.com/shot.png?sig=1",
      name: "Before",
      mimeType: "image/png",
      actionsSource: {
        uri: "https://drop.example.com/shot.png?sig=1",
        name: "Before",
        mimeType: "image/png",
      },
    });
    expect(
      pullRequestImageSource("https://drop.example.com/diagram.svg", location, "Diagram"),
    ).toMatchObject({
      mimeType: "image/svg+xml",
      actionsSource: {
        name: "Diagram",
        mimeType: "image/svg+xml",
      },
    });
    expect(
      pullRequestImageSource("file:///etc/hosts", null, "Hosts").actionsSource,
    ).toBeUndefined();
  });

  it("collects markdown images and bare image attachments in document order while skipping videos and non-HTTP URLs", () => {
    const body = [
      "![Before](https://github.com/user-attachments/assets/111)",
      "",
      "https://drop.example.com/middle.png",
      "",
      "![Middle caption](https://drop.example.com/middle.png)",
      "",
      "![Relative](/api/attachments/shot.png)",
      "",
      "![Local](screenshots/local.png)",
      "",
      "<table><tr><td>\n\nhttps://drop.example.com/table.png\n\n</td><td>\n\nhttps://drop.example.com/demo.mp4\n\n</td></tr></table>",
      "",
      "![Recording](https://drop.example.com/clip.mp4)",
      "",
      `<img src="${url}" alt="After" />`,
    ].join("\n");
    const segments = splitPullRequestBody(body, markdownReferenceDefinitions);
    expect(
      pullRequestMarkdownImages(segments, (href) =>
        href.startsWith("/") ? `https://forge.example.com${href}` : href,
      ),
    ).toEqual([
      { uri: "https://github.com/user-attachments/assets/111", alt: "Before" },
      { uri: "https://drop.example.com/middle.png", alt: "Middle caption" },
      { uri: "https://forge.example.com/api/attachments/shot.png", alt: "Relative" },
      { uri: "https://drop.example.com/table.png", alt: null },
      { uri: url, alt: "After" },
    ]);
  });
});

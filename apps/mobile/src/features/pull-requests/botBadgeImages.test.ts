import { describe, expect, it } from "vite-plus/test";
import { isBotBadgeImage } from "./botBadgeImages";

describe("bot badge images", () => {
  it("matches bot badges but not screenshots hosted by the same services", () => {
    const badges = [
      "https://static.devin.ai/assets/gh-devin-review-light.svg?v=4",
      "https://cursor.com/assets/images/open-in-web-dark.png",
      "https://storage.googleapis.com/coderabbit_public_assets/review-stack-in-coderabbit-ui.svg",
      "https://img.shields.io/badge/P1-orange",
      "https://greptile-static-assets.s3.amazonaws.com/badges/ViewArtifacts.svg?v=4",
      "https://www.gstatic.com/codereviewagent/high-priority.svg",
      "https://user-images.githubusercontent.com/23264/106598434-9e719e00-654f-11eb-9e59-6167043cfa01.png",
    ];
    const screenshots = [
      "https://cursor.com/artifacts/c/art-41567e7e-97f5-46ff-9e6e-df6a85723409",
      "https://www.cursor.com/artifacts/c/art-98360ed1-44f8-4459-bea3-43bf93cc74fc",
      "https://app.devin.ai/attachments/abc/ss_1.png",
      "https://user-images.githubusercontent.com/23264/1-other-upload.png",
      "https://storage.googleapis.com/some-bucket/before.png",
    ];
    expect(badges.filter(isBotBadgeImage)).toEqual(badges);
    expect(screenshots.filter(isBotBadgeImage)).toEqual([]);
  });
});

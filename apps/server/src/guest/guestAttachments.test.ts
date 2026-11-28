import { describe, expect, it } from "vite-plus/test";

import { classifyGuestUploads, guestHostImageType, repliesShowImage } from "./guestAttachments.ts";

describe("guest host images", () => {
  it.each([
    ["![a](/w/a.png)", "/w/a.png", "image/png"],
    ["![a](</w/my shot.jpg>)", "/w/my shot.jpg", "image/jpeg"],
    ["![a](/w/shot(1).png)", "/w/shot(1).png", "image/png"],
    ["![a](/w/shot\\_1.png) ![b](/w/a&amp;b.png)", "/w/shot_1.png", "image/png"],
    ["![a](/w/shot\\_1.png) ![b](/w/a&amp;b.png)", "/w/a&b.png", "image/png"],
    ["![a](file:///w/caf%c3%a9.png)", "/w/café.png", "image/png"],
    ["![a](file:///w/%73hot.png) ![b](/w/sh&#111;t2.png)", "/w/shot.png", "image/png"],
    ["![a](file:///w/%73hot.png) ![b](/w/sh&#111;t2.png)", "/w/shot2.png", "image/png"],
    ["![a][r]\n\n[r]: /w/ref.png", "/w/ref.png", "image/png"],
    ["![a](file:///w/url%20form.png)", "/w/url form.png", "image/png"],
    // Amp swaps local images for auth-only URLs and keeps the file in the fragment.
    [
      "![a](https://ampcode.com/user-content/attachments/a.png#amp-media-source=file%3A%2F%2F%2Fw%2Fshot.png)",
      "/w/shot.png",
      "image/png",
    ],
    ["![a](C:\\w\\win.png)", "C:\\w\\win.png", "image/png"],
    ["![a][r]\n\n[r]: C:\\w\\ref.png", "C:/w/ref.png", "image/png"],
    [
      '<picture><source media="(prefers-color-scheme: dark)" srcset="/w/dark.png"><img src="/w/light.png"></picture>',
      "/w/dark.png",
      "image/png",
    ],
    [
      '<picture><source media="(prefers-color-scheme: dark)" srcset="C:\\w\\dark.png"><img src="C:\\w\\light.png"></picture>',
      "C:/w/dark.png",
      "image/png",
    ],
    // Shown as a link, in code, or not at all: the guest sees no image, so none loads.
    ["[a](/w/link.png)", "/w/link.png", null],
    ["```\n![a](/w/code.png)\n```", "/w/code.png", null],
    ["`![a](/w/span.png)`", "/w/span.png", null],
    ["<!-- ![a](/w/comment.png) -->", "/w/comment.png", null],
    ["![a](/w/a.png)", "/a.png", null],
    ["![a](//host/s/x.png)", "//host/s/x.png", null],
    ["![a](\\\\host\\s\\x.png)", "\\\\host\\s\\x.png", null],
    ["![a](/w/a.svg)", "/w/a.svg", null],
    ["![a](/w/a.constructor)", "/w/a.constructor", null],
  ])("%j serves %j as %j", (text, path, type) => {
    const served = guestHostImageType(path) !== null && repliesShowImage(path, [{ text }]);
    expect(served ? guestHostImageType(path) : null).toBe(type);
  });
});

describe("guest upload names", () => {
  it("cuts a long name between characters, never inside an emoji", () => {
    const name = `${"a".repeat(254)}\u{1F600}.txt`;
    const classified = classifyGuestUploads([
      { name, contentType: "text/plain", sizeBytes: 1, header: new Uint8Array([0x61]) },
    ]);
    expect(classified.ok && classified.attachments[0]?.name).toBe("a".repeat(254));
  });
});

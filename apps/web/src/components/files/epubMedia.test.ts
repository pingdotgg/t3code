import { expect, it } from "vite-plus/test";

import { parseXml } from "./documentPreviewXml";
import { ttmlCaptions } from "./epubMedia";

it("keeps captions whose start and end are expressed in frames", () => {
  const captions = parseXml(`
    <tt xmlns="http://www.w3.org/ns/ttml" xmlns:ttp="http://www.w3.org/ns/ttml#parameter" ttp:frameRate="30">
      <body><div><p begin="45f" end="90f">Door closes</p></div></body>
    </tt>
  `);
  expect(ttmlCaptions(captions)).toContain("00:00:01.500 --> 00:00:03.000\nDoor closes");
});

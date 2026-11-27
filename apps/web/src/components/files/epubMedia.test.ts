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

const ttml = "http://www.w3.org/ns/ttml";
const dfxp = "http://www.w3.org/2006/04/ttaf1";

it.each([
  ["frame clock times", ttml, "", "00:01:01:15", "00:01:03:00", "00:01:01.500 --> 00:01:03.000"],
  [
    "frame offsets at 25 fps",
    ttml,
    'p:frameRate="25"',
    "25f",
    "50f",
    "00:00:01.000 --> 00:00:02.000",
  ],
  [
    "frame offsets at a fractional DFXP rate",
    dfxp,
    'p:frameRate="24" p:frameRateMultiplier="1000 1001"',
    "24f",
    "48f",
    "00:00:01.001 --> 00:00:02.002",
  ],
  [
    "frame clock times with subframes",
    ttml,
    'p:frameRate="24" p:subFrameRate="2"',
    "00:00:01:12.1",
    "00:00:02:00.0",
    "00:00:01.521 --> 00:00:02.000",
  ],
])("keeps captions using %s", (_label, namespace, parameters, begin, end, timing) => {
  const captions = parseXml(`
    <tt xmlns="${namespace}" xmlns:p="${namespace}#parameter" ${parameters}>
      <body><div><p begin="${begin}" end="${end}">Door closes</p></div></body>
    </tt>
  `);
  expect(ttmlCaptions(captions)).toBe(`WEBVTT\n\n${timing}\nDoor closes\n`);
});

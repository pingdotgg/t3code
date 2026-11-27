import { expect, it } from "vite-plus/test";

import { parseXml } from "./documentPreviewXml";
import { ttmlCaptions } from "./epubMedia";

const ttml = "http://www.w3.org/ns/ttml";
const dfxp = "http://www.w3.org/2006/04/ttaf1";
const smpte = 'p:timeBase="smpte" p:markerMode="continuous"';
const ntscRate = 'p:frameRate="30" p:frameRateMultiplier="1000 1001"';

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
  [
    "continuous non-drop SMPTE timecodes",
    ttml,
    `${smpte} p:dropMode="nonDrop" p:frameRate="25"`,
    "00:00:01:12",
    "00:00:02:00",
    "00:00:01.480 --> 00:00:02.000",
  ],
  [
    "continuous SMPTE timecodes at a fractional rate",
    ttml,
    `${smpte} ${ntscRate}`,
    "00:00:01:00",
    "00:00:02",
    "00:00:01.001 --> 00:00:02.002",
  ],
  [
    "continuous SMPTE NTSC drop-frame timecodes",
    ttml,
    `${smpte} ${ntscRate} p:dropMode="dropNTSC"`,
    "00:00:59:29",
    "00:01:00:02",
    "00:01:00.027 --> 00:01:00.060",
  ],
  [
    "continuous SMPTE PAL drop-frame timecodes",
    ttml,
    `${smpte} ${ntscRate} p:dropMode="dropPAL"`,
    "00:01:59:29",
    "00:02:00:04",
    "00:02:00.087 --> 00:02:00.120",
  ],
  [
    "continuous SMPTE NTSC clocks without a frame label at a drop minute",
    ttml,
    `${smpte} ${ntscRate} p:dropMode="dropNTSC"`,
    "00:00:59:27",
    "00:01:00",
    "00:00:59.960 --> 00:00:59.993",
  ],
  [
    "continuous SMPTE PAL clocks without a frame label at a drop minute",
    ttml,
    `${smpte} ${ntscRate} p:dropMode="dropPAL"`,
    "00:01:59:25",
    "00:02:00",
    "00:01:59.953 --> 00:01:59.987",
  ],
])("keeps captions using %s", (_label, namespace, parameters, begin, end, timing) => {
  const captions = parseXml(`
    <tt xmlns="${namespace}" xmlns:p="${namespace}#parameter" ${parameters}>
      <body><div><p begin="${begin}" end="${end}">Door closes</p></div></body>
    </tt>
  `);
  expect(ttmlCaptions(captions)).toBe(`WEBVTT\n\n${timing}\nDoor closes\n`);
});

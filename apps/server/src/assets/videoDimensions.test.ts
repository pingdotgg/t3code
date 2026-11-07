import { describe, expect, it } from "vite-plus/test";

import { readVideoDimensions } from "./videoDimensions.ts";

const concat = (...parts: ReadonlyArray<Uint8Array>) => {
  const bytes = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.length;
  }
  return bytes;
};

const box = (type: string, ...children: ReadonlyArray<Uint8Array>) => {
  const body = concat(...children);
  const header = new Uint8Array(8);
  new DataView(header.buffer).setUint32(0, 8 + body.length);
  header.set(new TextEncoder().encode(type), 4);
  return concat(header, body);
};

const IDENTITY = [0x10000, 0, 0, 0, 0x10000, 0, 0, 0, 0x40000000];
const QUARTER_TURN = [0, 0x10000, 0, -0x10000, 0, 0, 0, 0, 0x40000000];

function tkhd(width: number, height: number, options: { version?: 0 | 1; matrix?: number[] } = {}) {
  const matrixOffset = options.version === 1 ? 52 : 40;
  const body = new Uint8Array(matrixOffset + 44);
  const data = new DataView(body.buffer);
  body[0] = options.version ?? 0;
  (options.matrix ?? IDENTITY).forEach((value, index) =>
    data.setInt32(matrixOffset + index * 4, value),
  );
  data.setUint32(matrixOffset + 36, width * 0x10000);
  data.setUint32(matrixOffset + 40, height * 0x10000);
  return box("tkhd", body);
}

const ftyp = box("ftyp", new TextEncoder().encode("isom"));
const mdat = box("mdat", new Uint8Array(4096));

const ebmlSize = (size: number) => new Uint8Array([0x01, 0, 0, 0, 0, 0, size >> 8, size & 0xff]);
const UNKNOWN_SIZE = new Uint8Array([0x01, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff]);
const idBytes = (id: number) => {
  const bytes: number[] = [];
  for (let value = id; value > 0; value = Math.floor(value / 0x100)) bytes.unshift(value & 0xff);
  return new Uint8Array(bytes);
};
const element = (id: number, ...children: ReadonlyArray<Uint8Array>) => {
  const body = concat(...children);
  return concat(idBytes(id), ebmlSize(body.length), body);
};
const uint = (id: number, value: number) => element(id, new Uint8Array([value >> 8, value & 0xff]));

const ebmlHeader = element(0x1a45dfa3, element(0x4282, new TextEncoder().encode("webm")));
const videoTrack = (...video: ReadonlyArray<Uint8Array>) =>
  element(0xae, uint(0x83, 1), element(0xe0, ...video));
const audioTrack = element(0xae, uint(0x83, 2), element(0xe1, uint(0xb5, 48000)));
const cluster = element(0x1f43b675, new Uint8Array(64));
const liveSegment = (...children: ReadonlyArray<Uint8Array>) =>
  concat(idBytes(0x18538067), UNKNOWN_SIZE, ...children);

async function dimensionsOf(bytes: Uint8Array) {
  return readVideoDimensions(
    async (offset, length) => bytes.subarray(offset, offset + length),
    bytes.length,
  );
}

describe("readVideoDimensions", () => {
  it.each([
    {
      name: "an MP4 whose moov follows the media data",
      bytes: concat(ftyp, mdat, box("moov", box("trak", tkhd(1080, 1920)))),
      expected: { width: 1080, height: 1920 },
    },
    {
      name: "the first video track after an audio track",
      bytes: concat(
        ftyp,
        box(
          "moov",
          box("mvhd", new Uint8Array(100)),
          box("trak", tkhd(0, 0)),
          box("trak", tkhd(1920, 1080)),
        ),
      ),
      expected: { width: 1920, height: 1080 },
    },
    {
      name: "a version 1 track header",
      bytes: concat(ftyp, box("moov", box("trak", tkhd(640, 480, { version: 1 })))),
      expected: { width: 640, height: 480 },
    },
    {
      name: "a phone recording rotated a quarter turn",
      bytes: concat(ftyp, box("moov", box("trak", tkhd(1920, 1080, { matrix: QUARTER_TURN })))),
      expected: { width: 1080, height: 1920 },
    },
    {
      name: "a live WebM with an unknown segment size",
      bytes: concat(
        ebmlHeader,
        liveSegment(
          element(0x1654ae6b, audioTrack, videoTrack(uint(0xb0, 720), uint(0xba, 1280))),
          cluster,
        ),
      ),
      expected: { width: 720, height: 1280 },
    },
    {
      name: "a WebM display size over its pixel size",
      bytes: concat(
        ebmlHeader,
        element(
          0x18538067,
          element(
            0x1654ae6b,
            videoTrack(uint(0xb0, 720), uint(0xba, 576), uint(0x54b0, 1024), uint(0x54ba, 576)),
          ),
        ),
      ),
      expected: { width: 1024, height: 576 },
    },
    {
      name: "a WebM whose tracks come after its first cluster",
      bytes: concat(
        ebmlHeader,
        liveSegment(cluster, element(0x1654ae6b, videoTrack(uint(0xb0, 720), uint(0xba, 1280)))),
      ),
      expected: null,
    },
    {
      name: "an MP4 with no video track",
      bytes: concat(ftyp, box("moov", box("trak", tkhd(0, 0)))),
      expected: null,
    },
    {
      name: "a box that claims more bytes than the file holds",
      bytes: concat(ftyp, box("moov", box("trak", tkhd(1080, 1920))).subarray(0, 40)),
      expected: null,
    },
    {
      name: "a file that is not a video",
      bytes: new TextEncoder().encode("media"),
      expected: null,
    },
  ])("reads $name", async ({ bytes, expected }) => {
    expect(await dimensionsOf(bytes)).toEqual(expected);
  });
});

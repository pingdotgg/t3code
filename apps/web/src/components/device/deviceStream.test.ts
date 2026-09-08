import { describe, expect, it } from "vite-plus/test";

import { AvccDemuxer, avcCodecString, parseSemuPacket, scanAccessUnit } from "./deviceStream";

const envelope = (tag: number, payload: number[]) => {
  const length = 1 + payload.length;
  return [
    (length >>> 24) & 0xff,
    (length >>> 16) & 0xff,
    (length >>> 8) & 0xff,
    length & 0xff,
    tag,
    ...payload,
  ];
};

describe("AvccDemuxer", () => {
  it("reassembles envelopes split across reads", () => {
    const demuxer = new AvccDemuxer();
    const bytes = new Uint8Array([
      ...envelope(1, [1, 0x64, 0x00, 0x1f]),
      ...envelope(2, [9, 9, 9]),
      ...envelope(0x7f, [0]),
      ...envelope(3, [4]),
    ]);
    const first = demuxer.push(bytes.subarray(0, 7));
    const rest = demuxer.push(bytes.subarray(7));
    const chunks = [...first, ...rest];
    expect(chunks.map((chunk) => chunk.type)).toEqual(["description", "keyframe", "delta"]);
    expect(Array.from(chunks[0]!.payload)).toEqual([1, 0x64, 0x00, 0x1f]);
    expect(Array.from(chunks[1]!.payload)).toEqual([9, 9, 9]);
  });

  it("derives the WebCodecs codec string from the avcC record", () => {
    expect(avcCodecString(new Uint8Array([1, 0x64, 0x00, 0x1f]))).toBe("avc1.64001f");
    expect(avcCodecString(new Uint8Array([1]))).toBe("avc1.42E01E");
  });
});

describe("serve-emu frames", () => {
  it("strips the SEMU header and reads the keyframe flag and timestamp", () => {
    const buffer = new ArrayBuffer(16 + 3);
    const view = new DataView(buffer);
    view.setUint32(0, 0x53454d55);
    view.setUint8(4, 1);
    view.setUint8(5, 1);
    view.setBigUint64(8, 123456n);
    new Uint8Array(buffer).set([7, 8, 9], 16);
    const packet = parseSemuPacket(buffer);
    expect(packet.isKey).toBe(true);
    expect(packet.timestamp).toBe(123456);
    expect(Array.from(packet.data)).toEqual([7, 8, 9]);
  });

  it("treats a frame without the header as raw data", () => {
    const packet = parseSemuPacket(new Uint8Array([0, 0, 1, 0x65]).buffer);
    expect(packet.isKey).toBeNull();
    expect(packet.data.length).toBe(4);
  });

  it("finds the SPS and IDR NAL units in an Annex-B access unit", () => {
    const unit = new Uint8Array([0, 0, 0, 1, 0x67, 0x64, 0x00, 0x1f, 0, 0, 1, 0x65, 0xaa]);
    const scanned = scanAccessUnit(unit);
    expect(scanned.isKey).toBe(true);
    expect(scanned.sps && avcCodecString(scanned.sps)).toBe("avc1.64001f");
    expect(scanAccessUnit(new Uint8Array([0, 0, 1, 0x41, 0x00])).isKey).toBe(false);
  });
});

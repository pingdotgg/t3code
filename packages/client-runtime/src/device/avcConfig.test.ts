import { describe, expect, it } from "vite-plus/test";

import { simulatorAvcConfig } from "./avcConfig.ts";

// Captured from the hub before and after its encoder falls back from low-latency rate control.
const lowLatency = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 22, 39, 100, 0, 51, 172, 19, 20, 60, 4, 192, 20, 158, 106, 154, 129,
  1, 1, 3, 194, 1, 8, 248, 1, 0, 4, 40, 238, 60, 176,
]);
const fallback = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 12, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 164, 1, 0, 4, 40,
  238, 60, 176,
]);
const repaired = Uint8Array.from([
  1, 100, 0, 51, 255, 225, 0, 17, 39, 100, 0, 51, 172, 86, 128, 76, 1, 73, 230, 168, 6, 208, 68, 35,
  80, 1, 0, 4, 40, 238, 60, 176,
]);

describe("simulator AVC reorder metadata", () => {
  it("adds zero reordering and one reference frame to the captured fallback SPS", () => {
    expect(simulatorAvcConfig(fallback)).toEqual(repaired);
    expect(simulatorAvcConfig(repaired)).toBe(repaired);
  });

  it("preserves existing VUI and leaves the original codec description untouched", () => {
    const original = fallback.slice();
    simulatorAvcConfig(fallback);
    expect(fallback).toEqual(original);
    expect(simulatorAvcConfig(lowLatency)).toBe(lowLatency);
  });

  it("repairs multiple SPS entries while preserving PPS and profile extensions", () => {
    const extensions = [0xfd, 0xf8, 0xf8, 0];
    const description = Uint8Array.from([
      ...fallback.subarray(0, 5),
      0xe2,
      ...fallback.subarray(6, 20),
      ...lowLatency.subarray(6, 30),
      ...fallback.subarray(20),
      ...extensions,
    ]);
    expect(simulatorAvcConfig(description)).toEqual(
      Uint8Array.from([
        ...description.subarray(0, 6),
        ...repaired.subarray(6, 25),
        ...lowLatency.subarray(6, 30),
        ...fallback.subarray(20),
        ...extensions,
      ]),
    );
  });

  it("passes through every truncated prefix of the captured configurations", () => {
    for (const config of [fallback, lowLatency]) {
      for (let length = 0; length < config.length; length++) {
        const truncated = config.subarray(0, length);
        expect(simulatorAvcConfig(truncated)).toBe(truncated);
      }
    }
  });

  it("does not modify unsupported profiles, scaling lists, or invalid parameter-set lengths", () => {
    const unsupportedProfile = fallback.slice();
    unsupportedProfile[9] = 110;
    const scalingLists = fallback.slice();
    scalingLists[12] = scalingLists[12]! | 1;
    const invalidSpsLength = fallback.slice();
    invalidSpsLength[6] = 0xff;
    const invalidPpsLength = fallback.slice();
    invalidPpsLength[21] = 0xff;
    for (const config of [unsupportedProfile, scalingLists, invalidSpsLength, invalidPpsLength]) {
      expect(simulatorAvcConfig(config)).toBe(config);
    }
  });

  it("requires valid SPS trailing bits before appending VUI metadata", () => {
    const invalidPadding = fallback.slice();
    invalidPadding[19] = 0;
    expect(simulatorAvcConfig(invalidPadding)).toBe(invalidPadding);
  });

  it("passes through invalid NAL headers and unterminated Exp-Golomb values", () => {
    const forbiddenBit = fallback.slice();
    forbiddenBit[8] = forbiddenBit[8]! | 0x80;
    expect(simulatorAvcConfig(forbiddenBit)).toBe(forbiddenBit);
    const unterminated = fallback.slice();
    unterminated.fill(0, 12, 20);
    expect(simulatorAvcConfig(unterminated)).toBe(unterminated);
    const overlong = Uint8Array.from([
      ...fallback.subarray(0, 6),
      0,
      13,
      39,
      100,
      0,
      51,
      0,
      0,
      3,
      0,
      0,
      3,
      0,
      0,
      0,
      ...fallback.subarray(20),
    ]);
    expect(simulatorAvcConfig(overlong)).toBe(overlong);
  });

  it("bounds parsing of oversized configurations and SPS data", () => {
    const oversizedConfig = new Uint8Array(64 * 1024 + 1);
    oversizedConfig.set(fallback);
    expect(simulatorAvcConfig(oversizedConfig)).toBe(oversizedConfig);
    const oversizedSps = new Uint8Array(6 + 2 + 4097 + 7);
    oversizedSps.set(fallback.subarray(0, 6));
    oversizedSps.set([0x10, 1], 6);
    oversizedSps.set(fallback.subarray(8, 20), 8);
    oversizedSps.set(fallback.subarray(20), 8 + 4097);
    expect(simulatorAvcConfig(oversizedSps)).toBe(oversizedSps);
  });
});

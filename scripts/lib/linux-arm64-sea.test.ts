// TEMPORARY one-time Node fix. Remove when fixed: https://github.com/nodejs/node/issues/67048
import { describe, expect, it } from "@effect/vitest";
import { assertLinuxArm64PageCompatibility } from "./linux-arm64-sea.ts";

function elf(loads: Array<{ offset: bigint; address: bigint; size: bigint }>) {
  const bytes = new Uint8Array(64 + loads.length * 56);
  const view = new DataView(bytes.buffer);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 2, 1]);
  view.setUint16(18, 183, true);
  view.setBigUint64(32, 64n, true);
  view.setUint16(54, 56, true);
  view.setUint16(56, loads.length, true);
  loads.forEach((load, index) => {
    const start = 64 + index * 56;
    view.setUint32(start, 1, true);
    view.setBigUint64(start + 8, load.offset, true);
    view.setBigUint64(start + 16, load.address, true);
    view.setBigUint64(start + 40, load.size, true);
    view.setBigUint64(start + 48, 0x1000n, true);
  });
  return bytes;
}

describe("Linux ARM64 SEA page compatibility", () => {
  it("rejects the relocated SEA note from nightly 3512", () => {
    expect(() =>
      assertLinuxArm64PageCompatibility(
        elf([{ offset: 0x8faf000n, address: 0x1015d000n, size: 0x1003000n }]),
      ),
    ).toThrow(/64 KiB/);
  });

  it("accepts congruent offsets even with a smaller declared alignment", () => {
    expect(() =>
      assertLinuxArm64PageCompatibility(
        elf([
          { offset: 0n, address: 0x400000n, size: 0x10000n },
          { offset: 0x20000n, address: 0x420000n, size: 0x10000n },
        ]),
      ),
    ).not.toThrow();
  });

  it("rejects segments that share a 64 KiB page", () => {
    expect(() =>
      assertLinuxArm64PageCompatibility(
        elf([
          { offset: 0n, address: 0x400000n, size: 0x11000n },
          { offset: 0x11000n, address: 0x411000n, size: 0x1000n },
        ]),
      ),
    ).toThrow(/overlap/);
  });

  it("rejects missing or malformed program headers", () => {
    expect(() => assertLinuxArm64PageCompatibility(elf([]))).toThrow();
    expect(() => assertLinuxArm64PageCompatibility(new Uint8Array(64))).toThrow();
    expect(() =>
      assertLinuxArm64PageCompatibility(
        elf([{ offset: 0n, address: 0x400000n, size: 1n }]).subarray(0, 70),
      ),
    ).toThrow();
  });
});

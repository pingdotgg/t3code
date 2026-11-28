import { decodeFilePreviewText } from "@t3tools/shared/filePreview";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";

const NodeTextDecoder = globalThis.TextDecoder;

class HermesTextDecoder extends NodeTextDecoder {
  constructor(label = "utf-8", options?: TextDecoderOptions) {
    if (!/^utf-(8|16le|16be)$/i.test(label)) throw new RangeError(`Unsupported encoding: ${label}`);
    super(label, options);
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("text decoder polyfill", () => {
  it("lets a runtime without GB18030 preview a GBK source file", async () => {
    vi.stubGlobal("TextDecoder", HermesTextDecoder);
    const gbk = new Uint8Array([
      0x2f, 0x2f, 0x20, 0xd6, 0xd0, 0xce, 0xc4, 0xd7, 0xa2, 0xca, 0xcd, 0x0a, 0x69, 0x6e, 0x74,
      0x20, 0x61, 0x20, 0x3d, 0x20, 0x31, 0x3b, 0x0a,
    ]);
    expect(() => decodeFilePreviewText(gbk)).toThrow("UTF-8");

    await import("./text-decoder-polyfill");

    expect(decodeFilePreviewText(gbk).text).toBe("// 中文注释\nint a = 1;\n");
    expect(new TextDecoder()).toBeInstanceOf(HermesTextDecoder);
  });
});

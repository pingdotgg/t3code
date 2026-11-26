import { decodeFilePreviewText } from "@t3tools/shared/filePreview";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { withLegacyEncodings } from "./textDecoderPolyfill";

const NodeTextDecoder = globalThis.TextDecoder;

class Utf8OnlyTextDecoder extends NodeTextDecoder {
  constructor(label = "utf-8", options?: TextDecoderOptions) {
    if (!/^utf-?8$/i.test(label)) throw new RangeError(`Unsupported encoding: ${label}`);
    super(label, options);
  }
}

afterEach(() => {
  globalThis.TextDecoder = NodeTextDecoder;
});

describe("withLegacyEncodings", () => {
  it("lets a UTF-8-only runtime preview GBK text", () => {
    globalThis.TextDecoder = Utf8OnlyTextDecoder;
    // "中文" encoded as GBK.
    const gbk = new Uint8Array([0xd6, 0xd0, 0xce, 0xc4]);
    expect(() => decodeFilePreviewText(gbk)).toThrow("UTF-8");

    globalThis.TextDecoder = withLegacyEncodings(Utf8OnlyTextDecoder, () => NodeTextDecoder);
    expect(decodeFilePreviewText(gbk).text).toBe("中文");
    expect(new globalThis.TextDecoder()).toBeInstanceOf(Utf8OnlyTextDecoder);
    expect(() => decodeFilePreviewText(new Uint8Array([0xff]))).toThrow("UTF-8");
  });

  it("keeps a native decoder that already supports GB18030", () => {
    expect(withLegacyEncodings(NodeTextDecoder, () => Utf8OnlyTextDecoder)).toBe(NodeTextDecoder);
  });
});

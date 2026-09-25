import { describe, expect, it } from "vite-plus/test";

import { splitStringByUtf8Bytes } from "./utf8.ts";

describe("splitStringByUtf8Bytes", () => {
  it.each([0, -1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid chunk budget %s",
    (maxBytes) => {
      expect(() => splitStringByUtf8Bytes("output", maxBytes)).toThrow(RangeError);
    },
  );

  it("preserves whole code points even when a positive budget is smaller than one", () => {
    expect(splitStringByUtf8Bytes("a🙂名", 1)).toEqual([
      { data: "a", byteLength: 1 },
      { data: "🙂", byteLength: 4 },
      { data: "名", byteLength: 3 },
    ]);
  });
});

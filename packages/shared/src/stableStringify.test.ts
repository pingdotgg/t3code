import { describe, expect, it } from "@effect/vitest";

import { stableStringify } from "./stableStringify.ts";

describe("stableStringify", () => {
  it("canonicalizes object keys recursively", () => {
    expect(
      stableStringify({
        z: 1,
        a: {
          y: true,
          b: null,
        },
        list: [{ c: "three", a: "one" }],
      }),
    ).toBe('{"a":{"b":null,"y":true},"list":[{"a":"one","c":"three"}],"z":1}');
  });
});

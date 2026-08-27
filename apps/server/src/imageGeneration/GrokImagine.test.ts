import { describe, expect, it } from "vite-plus/test";

import { grokImagineOptionsFromToolInput } from "./GrokImagine.ts";

describe("grokImagineOptionsFromToolInput", () => {
  it("defaults aspect ratio to auto and resolution to 1k", () => {
    expect(grokImagineOptionsFromToolInput({ prompt: "a red circle" })).toEqual({
      aspectRatio: "auto",
      resolution: "1k",
    });
  });

  it("passes quality and 2k through when the tool sets them", () => {
    expect(
      grokImagineOptionsFromToolInput({
        prompt: "a poster",
        aspectRatio: "16:9",
        quality: "high",
        resolution: "2k",
      }),
    ).toEqual({
      aspectRatio: "16:9",
      resolution: "2k",
      quality: "high",
    });
  });
});

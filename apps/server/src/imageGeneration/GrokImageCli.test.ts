import { describe, expect, it } from "vite-plus/test";

import { grokImagineOptionsFromToolInput } from "./GrokImageCli.ts";

describe("grokImagineOptionsFromToolInput", () => {
  it("defaults aspect ratio to auto and resolution to 1k", () => {
    expect(grokImagineOptionsFromToolInput({ prompt: "a red circle" })).toEqual({
      aspectRatio: "auto",
      resolution: "1k",
    });
  });

  it("maps high quality to medium because Imagine only accepts low and medium", () => {
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
      quality: "medium",
    });
  });
});

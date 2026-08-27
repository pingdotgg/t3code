import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import {
  DEFAULT_GROK_IMAGE_MODEL,
  DEFAULT_IMAGE_GENERATION_PROVIDER,
  GenerateImageInput,
  GROK_IMAGE_MODELS,
  GrokImageModel,
  ImageGenerationProvider,
  resolveImageGenerationProvider,
} from "./imageGeneration.ts";

const decodeGenerate = Schema.decodeUnknownSync(GenerateImageInput);
const isGrokModel = Schema.is(GrokImageModel);
const isProvider = Schema.is(ImageGenerationProvider);

describe("image generation contracts", () => {
  it("defaults the provider to Codex and the Grok model to Imagine 2.0", () => {
    expect(DEFAULT_IMAGE_GENERATION_PROVIDER).toBe("codex");
    expect(DEFAULT_GROK_IMAGE_MODEL).toBe("grok-imagine-image-2.0");
    expect(GROK_IMAGE_MODELS).toContain(DEFAULT_GROK_IMAGE_MODEL);
  });

  it("accepts a prompt-only generate call so aspect ratio can stay auto", () => {
    expect(decodeGenerate({ prompt: "a red circle" }).prompt).toBe("a red circle");
    expect(decodeGenerate({ prompt: "a red circle" }).aspectRatio).toBeUndefined();
  });

  it("accepts quality and 1k/2k resolution overrides", () => {
    const decoded = decodeGenerate({
      prompt: "a poster",
      quality: "high",
      resolution: "2k",
      aspectRatio: "16:9",
    });
    expect(decoded.quality).toBe("high");
    expect(decoded.resolution).toBe("2k");
    expect(decoded.aspectRatio).toBe("16:9");
  });

  it("accepts an explicit Grok provider on a generate call", () => {
    expect(decodeGenerate({ prompt: "a red circle", provider: "grok" }).provider).toBe("grok");
    expect(decodeGenerate({ prompt: "a red circle" }).provider).toBeUndefined();
  });

  it("uses the requested provider and falls back to Settings", () => {
    expect(resolveImageGenerationProvider(undefined, "codex")).toBe("codex");
    expect(resolveImageGenerationProvider(undefined, "grok")).toBe("grok");
    expect(resolveImageGenerationProvider("grok", "codex")).toBe("grok");
    expect(resolveImageGenerationProvider("codex", "grok")).toBe("codex");
  });

  it("rejects unknown providers and Grok models", () => {
    expect(isProvider("codex")).toBe(true);
    expect(isProvider("grok")).toBe(true);
    expect(isProvider("openai")).toBe(false);
    expect(isGrokModel("grok-imagine-image-2.0")).toBe(true);
    expect(isGrokModel("gpt-image-2")).toBe(false);
  });
});

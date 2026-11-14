import { describe, expect, it } from "vitest";
import {
  computeRmsLevel,
  downsampleFloat32,
  float32FromPcm16Base64,
  pcm16Base64FromFloat32,
} from "./geminiLiveAudio";
import { summarizeMarkdownForVoice } from "./geminiLiveTypes";

describe("summarizeMarkdownForVoice", () => {
  it("strips fenced code blocks and file links for natural voice narration", () => {
    const input = [
      "I updated [ChatView.tsx](file:///C:/repo/apps/web/src/components/ChatView.tsx) with the new voice button.",
      "```tsx",
      "export function Demo() { return <div />; }",
      "```",
      "Everything compiled cleanly with `tsc`.",
    ].join("\n");

    const summary = summarizeMarkdownForVoice(input);
    expect(summary).toBe(
      "I updated ChatView.tsx with the new voice button. [code block] Everything compiled cleanly with tsc.",
    );
  });

  it("truncates long responses to the requested maxLength", () => {
    const input = "word ".repeat(200);
    const summary = summarizeMarkdownForVoice(input, 50);
    expect(summary.length).toBeLessThanOrEqual(53);
    expect(summary.endsWith("...")).toBe(true);
  });
});

describe("geminiLiveAudio PCM16 conversion", () => {
  it("round-trips Float32 audio samples through 16-bit PCM base64", () => {
    const original = new Float32Array([0, 0.5, -0.5, 0.99, -0.99]);
    const base64 = pcm16Base64FromFloat32(original, 16000, 16000);
    const decoded = float32FromPcm16Base64(base64);

    expect(decoded.length).toBe(original.length);
    for (let i = 0; i < original.length; i++) {
      expect(decoded[i]).toBeCloseTo(original[i] ?? 0, 2);
    }
  });

  it("downsamples 48kHz audio to 16kHz", () => {
    const input = new Float32Array(480).fill(0.25);
    const output = downsampleFloat32(input, 48000, 16000);
    expect(output.length).toBe(160);
    expect(output[0]).toBeCloseTo(0.25, 4);
  });

  it("computes normalized RMS level", () => {
    const silence = new Float32Array(128).fill(0);
    const tone = new Float32Array(128).fill(0.25);
    expect(computeRmsLevel(silence)).toBe(0);
    expect(computeRmsLevel(tone)).toBeCloseTo(1, 2);
  });
});

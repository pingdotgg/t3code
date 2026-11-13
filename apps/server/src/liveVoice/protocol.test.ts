import { describe, it, expect } from "@effect/vitest";
import { voiceContextChunks, voiceDelegation } from "./protocol.ts";

describe("subscription voice protocol", () => {
  it("accepts only bounded client delegations, not transcripts or hosted tasks", () => {
    const item = {
      id: "task-1",
      type: "delegation",
      target: "client",
      content: [
        { type: "input_text", text: "Check the build" },
        { type: "image", text: "ignored" },
      ],
    };
    expect(voiceDelegation({ type: "delegation.created", item })).toEqual({
      id: "task-1",
      text: "Check the build",
    });
    expect(voiceDelegation({ type: "input_transcript.added", item })).toBeNull();
    expect(
      voiceDelegation({ type: "delegation.created", item: { ...item, target: "responses" } }),
    ).toBeNull();
    expect(
      voiceDelegation({
        type: "delegation.created",
        item: { ...item, content: [{ type: "input_text", text: "x".repeat(16385) }] },
      }),
    ).toBeNull();
  });
  it("keeps Unicode results intact within the wire's byte limit", () => {
    const text = "Result: 中文 𝄞 café. ".repeat(100);
    const chunks = voiceContextChunks(text);
    expect(chunks.join("")).toBe(text);
    expect(chunks.every((chunk) => new TextEncoder().encode(chunk).length <= 480)).toBe(true);
    expect(voiceContextChunks("")).toEqual([]);
  });
});

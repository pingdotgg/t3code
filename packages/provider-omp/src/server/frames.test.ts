import { expect, it } from "vite-plus/test";
import { encodeOmpRequest, makeOmpFrameDecoder } from "./frames.ts";
import { readTokenUsage } from "./protocol.ts";

it("reassembles a large JSONL frame without corrupting UTF-8 across chunk boundaries", () => {
  const frame = { type: "response", data: "你好🙂".repeat(120_000) };
  const bytes = Buffer.from(JSON.stringify(frame));
  const chunkBytes = 256 * 1024;
  const count = Math.ceil(bytes.length / chunkBytes);
  const lines = Array.from({ length: count }, (_, index) =>
    JSON.stringify({
      type: "rpc_chunk",
      chunkId: "fixture",
      count,
      index,
      byteLength: bytes.length,
      data: bytes.subarray(index * chunkBytes, (index + 1) * chunkBytes).toString("base64"),
    }),
  );
  const decode = makeOmpFrameDecoder();
  for (const line of lines.slice(0, -1)) expect(decode(line)).toBeUndefined();
  expect(decode(lines.at(-1)!)).toEqual(frame);
  expect(() => makeOmpFrameDecoder()(lines[1]!)).toThrow("Invalid Oh My Pi RPC chunk sequence");
  expect(encodeOmpRequest(frame)?.toString()).toBe(`${JSON.stringify(frame)}\n`);
});

it("uses the occupied context and last message counters, excluding lifetime totals", () => {
  const now = "2026-11-25T00:00:00.000Z";
  const stats = { tokens: { input: 10_000 }, contextUsage: { tokens: 640, contextWindow: 16_384 } };
  expect(readTokenUsage(stats, { input: 300, cacheRead: 320, output: 20 }, now)).toEqual({
    usedTokens: 640,
    maxTokens: 16_384,
    inputTokens: 300,
    cachedInputTokens: 320,
    outputTokens: 20,
    updatedAt: now,
  });
  expect(readTokenUsage({ tokens: stats.tokens }, null, now)).toBeUndefined();
});

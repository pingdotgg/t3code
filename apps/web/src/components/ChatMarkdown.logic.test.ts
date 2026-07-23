import { describe, expect, it } from "vite-plus/test";

import {
  STREAMING_MARKDOWN_RENDER_INTERVAL_MS,
  streamingMarkdownRenderDelay,
} from "./ChatMarkdown.logic";

describe("streamingMarkdownRenderDelay", () => {
  it("coalesces updates inside the render interval", () => {
    expect(streamingMarkdownRenderDelay({ lastRenderedAt: 1_000, now: 1_020 })).toBe(30);
  });

  it("allows an immediate refresh once the interval elapsed", () => {
    expect(
      streamingMarkdownRenderDelay({
        lastRenderedAt: 1_000,
        now: 1_000 + STREAMING_MARKDOWN_RENDER_INTERVAL_MS,
      }),
    ).toBe(0);
    expect(streamingMarkdownRenderDelay({ lastRenderedAt: 1_000, now: 2_000 })).toBe(0);
  });

  it("handles a clock moving backwards without exceeding the interval", () => {
    expect(streamingMarkdownRenderDelay({ lastRenderedAt: 1_000, now: 900 })).toBe(
      STREAMING_MARKDOWN_RENDER_INTERVAL_MS,
    );
  });
});

export const STREAMING_MARKDOWN_RENDER_INTERVAL_MS = 50;

export function streamingMarkdownRenderDelay(input: {
  lastRenderedAt: number;
  now: number;
}): number {
  const elapsed = Math.max(0, input.now - input.lastRenderedAt);
  return Math.max(0, STREAMING_MARKDOWN_RENDER_INTERVAL_MS - elapsed);
}

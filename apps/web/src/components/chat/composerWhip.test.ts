import { describe, expect, it } from "vite-plus/test";

import { WHIP_PROMPTS, buildWhipQueuedMessage } from "./composerWhip";

describe("buildWhipQueuedMessage", () => {
  it("rotates through the prompts and wraps around", () => {
    const prompts = Array.from(
      { length: WHIP_PROMPTS.length + 1 },
      (_, crack) => buildWhipQueuedMessage({ queuedAfterToolActivityId: null, crack }).prompt,
    );

    expect(new Set(prompts.slice(0, WHIP_PROMPTS.length)).size).toBe(WHIP_PROMPTS.length);
    expect(prompts.at(-1)).toBe(prompts[0]);
  });

  it("sends immediately as a plain foreground message with no attachments", () => {
    const message = buildWhipQueuedMessage({ queuedAfterToolActivityId: "tool-1", crack: 0 });

    expect(message).toMatchObject({
      submissionIntent: "foreground",
      queuedAfterToolActivityId: "tool-1",
      images: [],
      files: [],
    });
  });
});

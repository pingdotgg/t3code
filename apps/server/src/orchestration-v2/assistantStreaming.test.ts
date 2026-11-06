import { describe, expect, it } from "vite-plus/test";
import { splitBufferedAssistantText } from "./assistantStreaming.ts";

describe("V2 assistant streaming", () => {
  it("keeps code fences intact", () => {
    expect(splitBufferedAssistantText("Intro\n\n```ts\nx()\n\n")).toEqual({
      ready: "Intro\n\n",
      rest: "```ts\nx()\n\n",
    });
    expect(splitBufferedAssistantText("```ts\nx()\n```\nrest")).toEqual({
      ready: "```ts\nx()\n```\n",
      rest: "rest",
    });
  });
});

it("holds a streamed section heading until its content has a boundary", () => {
  expect(splitBufferedAssistantText("Intro\n\n## Results\n\n")).toEqual({
    ready: "Intro\n\n",
    rest: "## Results\n\n",
  });
  expect(splitBufferedAssistantText("**Results**\n\nBody\n\nNext")).toEqual({
    ready: "**Results**\n\nBody\n\n",
    rest: "Next",
  });
});

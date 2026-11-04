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

  it("streams past a line that starts with inline triple-backtick code", () => {
    expect(
      splitBufferedAssistantText("```npm test``` runs the suite.\n\nNext paragraph.\n\nTail"),
    ).toEqual({
      ready: "```npm test``` runs the suite.\n\nNext paragraph.\n\n",
      rest: "Tail",
    });
    expect(splitBufferedAssistantText("```a``` is inline.\n\n```\ncode\n\nmore\n")).toEqual({
      ready: "```a``` is inline.\n\n",
      rest: "```\ncode\n\nmore\n",
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

import { describe, expect, it } from "vite-plus/test";

import { completedSentencesSince, speakableText, speechChunks } from "./speechText";
import { createSpeechTracker, nextSpeechActions, type ObservedMessage } from "./agentSpeech.logic";

const OPTIONS = {
  readCodeBlocks: false,
  readTerminalOutput: false,
  maxCharacters: 2_000,
  pronunciations: [],
};

describe("speakableText", () => {
  it("summarizes code and terminal output and drops markup", () => {
    const text = speakableText(
      [
        "## Fixed the **login** bug",
        "See [the docs](https://example.com) and `AuthService`.",
        "```ts",
        "const a = 1;",
        "```",
        "```console",
        "$ vp test",
        "ok",
        "```",
        "- one item",
      ].join("\n"),
      OPTIONS,
    );
    expect(text).toBe(
      [
        "Fixed the login bug",
        "See the docs and AuthService.",
        "(ts code block omitted.)",
        "(Terminal output omitted.)",
        "one item",
      ].join("\n"),
    );
  });

  it("reads code when enabled and applies pronunciations as whole words", () => {
    const text = speakableText("Restart nginx.\n```py\nprint(1)\n```\nnginxes stay.", {
      ...OPTIONS,
      readCodeBlocks: true,
      pronunciations: [{ from: "nginx", to: "engine x" }],
    });
    expect(text).toBe("Restart engine x.\nprint(1)\nnginxes stay.");
  });

  it("shortens long messages at a sentence", () => {
    const text = speakableText("First sentence here. Second sentence is longer than that.", {
      ...OPTIONS,
      maxCharacters: 30,
    });
    expect(text).toBe("First sentence here. (Message shortened.)");
  });
});

describe("speechChunks", () => {
  it("keeps sentences together under the limit and splits long ones at spaces", () => {
    expect(speechChunks("One. Two! Three?", 10)).toEqual(["One. Two!", "Three?"]);
    const long = speechChunks("word ".repeat(30).trim(), 40);
    expect(long.every((chunk) => chunk.length <= 40)).toBe(true);
    expect(long.join(" ")).toBe("word ".repeat(30).trim());
  });
});

describe("completedSentencesSince", () => {
  it("returns only finished sentences and never stops inside a code fence", () => {
    expect(completedSentencesSince("Hello there. And", 0)).toEqual({
      text: "Hello there.",
      end: 12,
    });
    expect(completedSentencesSince("Hello there. And", 12)).toBeNull();
    const fenced = "Intro.\n```ts\nconst a = 1;\n";
    expect(completedSentencesSince(fenced, 0)).toEqual({ text: "Intro.\n", end: 7 });
  });
});

describe("nextSpeechActions", () => {
  const message = (patch: Partial<ObservedMessage>): ObservedMessage => ({
    id: "m1",
    role: "assistant",
    text: "",
    streaming: false,
    createdAt: 2_000,
    ...patch,
  });

  it("never reads history present when the thread opened", () => {
    const tracker = createSpeechTracker([message({ text: "Old." })], 5_000);
    expect(
      nextSpeechActions(tracker, [message({ text: "Old." })], {
        readMode: "completed",
        maxCharacters: 2_000,
      }),
    ).toEqual([]);
    const older = message({ id: "m0", text: "Paged in later.", createdAt: 1_000 });
    expect(
      nextSpeechActions(tracker, [older], { readMode: "completed", maxCharacters: 2_000 }),
    ).toEqual([]);
  });

  it("reads a completed message once", () => {
    const tracker = createSpeechTracker([], 1_000);
    const settings = { readMode: "completed", maxCharacters: 2_000 } as const;
    expect(
      nextSpeechActions(tracker, [message({ text: "Hi.", streaming: true })], settings),
    ).toEqual([]);
    expect(nextSpeechActions(tracker, [message({ text: "Hi. Done." })], settings)).toEqual([
      { type: "speak", messageId: "m1", markdown: "Hi. Done." },
    ]);
    expect(nextSpeechActions(tracker, [message({ text: "Hi. Done." })], settings)).toEqual([]);
  });

  it("streams finished sentences, then the remainder", () => {
    const tracker = createSpeechTracker([], 1_000);
    const settings = { readMode: "streaming", maxCharacters: 2_000 } as const;
    expect(
      nextSpeechActions(tracker, [message({ text: "One. Tw", streaming: true })], settings),
    ).toEqual([{ type: "speak", messageId: "m1", markdown: "One." }]);
    expect(
      nextSpeechActions(tracker, [message({ text: "One. Two. Thr", streaming: true })], settings),
    ).toEqual([{ type: "append", messageId: "m1", markdown: " Two." }]);
    expect(nextSpeechActions(tracker, [message({ text: "One. Two. Three" })], settings)).toEqual([
      { type: "append", messageId: "m1", markdown: " Three" },
    ]);
  });
});

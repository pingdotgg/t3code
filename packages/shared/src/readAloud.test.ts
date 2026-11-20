import { expect, it } from "vite-plus/test";
import {
  readAloudPosition,
  readAloudSpeech,
  readAloudText,
  splitReadAloudSpans,
  splitReadAloudText,
  spokenWordAt,
} from "./readAloud.ts";

it("reads visible prose and identifiers without link targets or fenced code", () => {
  const text =
    "# Findings\n\nUse **readAloud** and `message.id`. [Details](https://example.com/private).\n\n```ts\nsecret();\n```\n\nDone.";
  expect(readAloudText(text, true)).toBe(
    "Findings.\nUse readAloud and message.id. Details.\nDone.",
  );
  expect(readAloudText(text, false)).toContain("secret();");
  expect(readAloudText("![image](https://example.com/image)\n\n<!-- hidden -->", true)).toBe("");
  expect(readAloudText("Hello  \nworld.\n\n> First.\n>\n> Second.", true)).toBe(
    "Hello.\nworld.\nFirst.\nSecond.",
  );
});

it("ends every heading, list item, and table row as its own sentence", () => {
  const text = [
    "## Next steps",
    "1. Run the tests\n2. Push the branch:\n   - check CI",
    "| File | Change |\n| --- | --- |\n| a.ts | Adds `x` |",
    "See (the docs)",
  ].join("\n\n");
  expect(readAloudText(text, true)).toBe(
    "Next steps.\nRun the tests.\nPush the branch:\ncheck CI.\nFile, Change.\na.ts, Adds x.\nSee (the docs).",
  );
});

it("maps each spoken word back to its markdown, leaving added punctuation unmapped", () => {
  const markdown =
    "# Findings\n\nUse **readAloud** and `message.id`.\nNext  line\n\nTom &amp; Jerry\n\n| a | b |\n| - | - |\n| c | d |\n\n```ts\ncode();\n```";
  const speech = readAloudSpeech(markdown, false);
  const source = (word: string) => {
    const at = speech.text.indexOf(word);
    const mapped = speech.sources.slice(at, at + word.length);
    return markdown.slice(Math.min(...mapped), Math.max(...mapped) + 1);
  };
  expect(source("readAloud")).toBe("readAloud");
  expect(source("message.id")).toBe("message.id");
  expect(source("code();")).toBe("code();");
  expect(source("Next line")).toBe("Next  line");
  expect(speech.sources[speech.text.indexOf("Findings.") + "Findings".length]).toBe(-1);
  expect(speech.sources[speech.text.indexOf("c, d") + 1]).toBe(-1);
  expect(
    speech.blocks.map((block) => [
      speech.text.slice(block.spokenStart, block.spokenEnd),
      markdown.slice(block.sourceStart, block.sourceEnd),
    ]),
  ).toEqual([
    ["Findings.", "# Findings"],
    [
      "Use readAloud and message.id.\nNext line.",
      "Use **readAloud** and `message.id`.\nNext  line",
    ],
    ["Tom & Jerry.", "Tom &amp; Jerry"],
    ["a, b.", "| a | b |"],
    ["c, d.", "| c | d |"],
    ["code();", "```ts\ncode();\n```"],
  ]);
});

it("locates a spoken word by markdown range and by its repeats in the block", () => {
  const markdown = "Intro.\n\nThe cat saw the **cat**.";
  const speech = readAloudSpeech(markdown, true);
  const second = speech.text.lastIndexOf("cat.");
  const position = readAloudPosition(speech, second, second + "cat.".length);
  expect(position).toEqual({
    block: {
      start: markdown.indexOf("The"),
      end: markdown.length,
      first: { text: "The", occurrence: 0 },
      last: { text: "cat.", occurrence: 0 },
    },
    word: {
      start: markdown.lastIndexOf("cat"),
      end: markdown.length,
      cue: { text: "cat.", occurrence: 0 },
    },
  });
  const cat = speech.text.indexOf("cat");
  expect(readAloudPosition(speech, second, second + 3)?.word.cue).toEqual({
    text: "cat",
    occurrence: 1,
  });
  expect(readAloudPosition(speech, cat, cat + 3)?.word.cue).toEqual({ text: "cat", occurrence: 0 });
  expect(spokenWordAt(speech.text, speech.text.indexOf("saw") + 1)).toEqual({
    start: speech.text.indexOf("saw"),
    end: speech.text.indexOf("saw") + 3,
  });
});

it("splits long replies without losing content or cutting surrogate pairs", () => {
  const text = "First sentence. " + "🙂".repeat(15) + " tail";
  const chunks = splitReadAloudText(text, 20);
  expect(chunks[0]).toBe("First sentence.");
  expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
  expect(chunks.join("").replaceAll(" ", "")).toBe(text.replaceAll(" ", ""));
  expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
  const padded = `  ${text}\n`;
  for (const span of splitReadAloudSpans(padded, 20))
    expect(padded.slice(span.start, span.start + span.text.length)).toBe(span.text);
});

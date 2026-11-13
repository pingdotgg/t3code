import { expect, it } from "vite-plus/test";
import { readAloudText, splitReadAloudText, speechAudioMimeType } from "./readAloud.ts";

it.each([
  { bytes: [0xff, 0xf9, 0x58, 0x40], mime: "audio/aac" },
  { bytes: [0xff, 0xf1, 0x58, 0x40], mime: "audio/aac" },
  { bytes: [0xff, 0xfb, 0x90, 0], mime: "audio/mpeg" },
  { bytes: [82, 73, 70, 70], mime: "audio/wav" },
])("recognizes $mime audio without treating MPEG frames as AAC", ({ bytes, mime }) => {
  expect(speechAudioMimeType(Uint8Array.from(bytes))).toBe(mime);
});

it("reads visible prose and identifiers without link targets or fenced code", () => {
  const text =
    "# Findings\n\nUse **readAloud** and `message.id`. [Details](https://example.com/private).\n\n```ts\nsecret();\n```\n\nDone.";
  expect(readAloudText(text, true)).toBe(
    "Findings\nUse readAloud and message.id. Details.\n\nDone.",
  );
  expect(readAloudText(text, false)).toContain("secret();");
  expect(readAloudText("![image](https://example.com/image)\n\n<!-- hidden -->", true)).toBe("");
  expect(readAloudText("Hello  \nworld.\n\n> First.\n>\n> Second.", true)).toBe(
    "Hello\nworld.\nFirst.\nSecond.",
  );
});

it("splits long replies without losing content or cutting surrogate pairs", () => {
  const text = "First sentence. " + "🙂".repeat(15) + " tail";
  const chunks = splitReadAloudText(text, 20);
  expect(chunks[0]).toBe("First sentence.");
  expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
  expect(chunks.join("").replaceAll(" ", "")).toBe(text.replaceAll(" ", ""));
  expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
});

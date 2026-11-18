import { expect, it } from "vite-plus/test";
import { readAloudText, splitReadAloudText } from "./readAloud.ts";

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

it("splits long replies without losing content or cutting surrogate pairs", () => {
  const text = "First sentence. " + "🙂".repeat(15) + " tail";
  const chunks = splitReadAloudText(text, 20);
  expect(chunks[0]).toBe("First sentence.");
  expect(chunks.every((chunk) => chunk.length <= 20)).toBe(true);
  expect(chunks.join("").replaceAll(" ", "")).toBe(text.replaceAll(" ", ""));
  expect(chunks.every((chunk) => !/[\uD800-\uDBFF]$/.test(chunk))).toBe(true);
});

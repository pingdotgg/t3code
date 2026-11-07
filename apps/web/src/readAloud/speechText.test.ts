import { describe, expect, it } from "vite-plus/test";

import { markdownToSpeechText, splitSpeechText } from "./speechText";

describe("markdownToSpeechText", () => {
  it("says 'Code block.' instead of reading code", () => {
    const text = markdownToSpeechText(
      [
        "Run this:",
        "",
        "```powershell",
        "Get-ChildItem C:\\Users",
        "```",
        "",
        "Then restart.",
      ].join("\n"),
    );
    expect(text).toBe("Run this:\nCode block.\nThen restart.");
  });

  it("reads file paths as their file names", () => {
    expect(
      markdownToSpeechText(
        "Edited `apps/web/src/components/Sidebar.tsx` and C:\\Users\\alex\\notes.md, see src/main.ts:42.",
      ),
    ).toBe("Edited Sidebar.tsx and notes.md, see main.ts.");
  });

  it("keeps link words, drops URLs and markdown symbols", () => {
    expect(
      markdownToSpeechText(
        "## Result\n\n- **Done:** see [the discussion](https://github.com/pingdotgg/t3code/discussions/6762)\n- Raw https://example.com/x",
      ),
    ).toBe("Result.\nDone: see the discussion.\nRaw link.");
  });

  it("drops emoji instead of reading their names", () => {
    expect(markdownToSpeechText("You click 🔊 on a reply ✅")).toBe("You click on a reply.");
  });

  it("reads table cells and skips separator rows", () => {
    expect(markdownToSpeechText("| Voice | Kind |\n|---|---|\n| Ava | natural |")).toBe(
      "Voice, Kind.\nAva, natural.",
    );
  });

  it("keeps short inline code but not long snippets", () => {
    expect(
      markdownToSpeechText(
        "Use `uv` then `const value = await fetchEverythingFromTheServer(options, retries)`.",
      ),
    ).toBe("Use uv then code.");
  });
});

describe("splitSpeechText", () => {
  it("keeps the first piece short so playback starts quickly", () => {
    const sentence = "This sentence has a fair number of words in it.";
    const chunks = splitSpeechText(Array.from({ length: 30 }, () => sentence).join(" "), 100, 400);
    expect(chunks[0]!.length).toBeLessThanOrEqual(100);
    expect(chunks.slice(1).every((chunk) => chunk.length <= 400)).toBe(true);
    expect(chunks.join(" ")).toBe(Array.from({ length: 30 }, () => sentence).join(" "));
  });

  it("returns nothing for empty text", () => {
    expect(splitSpeechText("   ")).toEqual([]);
  });
});

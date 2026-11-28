import { expect, it } from "vite-plus/test";
import {
  readAloudPosition,
  readAloudShownText,
  readAloudSourceAtShown,
  readAloudTapAtShown,
  readAloudBlockFrom,
  readAloudSpeech,
  readAloudText,
  readAloudSentenceStart,
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

it("never reads diagram source, and reads formulas as the words it is given for them", () => {
  const diagram = "Flow:\n\n```mermaid\ngraph TD\n  A-->B\n```\n\nDone.";
  expect(readAloudText(diagram, false)).toBe("Flow:\nDone.");

  const markdown = "Area is $\\pi r^2$ here.\n\n$$\n\\frac{a}{b}\n$$\n\nCosts $5 or $10.";
  const words: Record<string, string> = { "\\pi r^2": "pi r squared", "\\frac{a}{b}": "a over b" };
  const speech = readAloudSpeech(markdown, true, { math: (tex) => words[tex] });
  expect(speech.text).toBe("Area is pi r squared here.\na over b.\nCosts $5 or $10.");
  // The words stand for the formula, so they map back into its source.
  const squared = speech.text.indexOf("squared");
  const formula = markdown.indexOf("$\\pi");
  expect(speech.sources[squared]).toBeGreaterThanOrEqual(formula);
  expect(speech.sources[squared]).toBeLessThan(markdown.indexOf(" here"));
  // Without a reader, formulas read as the TeX the reply shows.
  expect(readAloudText(markdown, true)).toContain("$\\pi r^2$");
});

it("reads file chips as they show, and bare addresses as a person would say them", () => {
  expect(
    readAloudText(
      "Open `apps/server/src/SpeechAligner.ts:120`, [`a.ts:4`](/repo/a.ts#L4), `b.ts:10-20`, and [the reader](src/reader.ts).",
      true,
    ),
  ).toBe("Open SpeechAligner.ts line 120, a.ts line 4, b.ts lines 10 to 20, and the reader.");
  expect(
    readAloudText(
      [
        "https://github.com/pingdotgg/t3code/pull/35910",
        "https://github.com/pingdotgg/t3code/commit/7ff4ccb5231f9e0a8d6c4b2e1f0a9b8c7d6e5f4a",
        "https://github.com/pingdotgg/t3code/blob/main/apps/web/src/index.css#L4",
        "https://gitlab.com/group/sub/proj/-/merge_requests/7",
        "<https://t3.codes/docs>",
        "https://example.com/api/v2/users?filter=active",
        "[labeled](https://example.com/a/b/c)",
      ].join(", "),
      true,
    ),
  ).toBe(
    "t3code pull request 35910, t3code commit 7ff4ccb, index.css in t3code, proj merge request 7, t3.codes/docs, example.com, labeled.",
  );
});

it("reads shortcut symbols as key names, leaving arrows in prose to the voice", () => {
  expect(readAloudText("Press ⌘K or `⌥⇧↓`, then ⎋. A → B.", true)).toBe(
    "Press Command K or Option Shift Down, then Escape. A → B.",
  );
});

it("reads emoji by the names it is given, mapped back to the emoji", () => {
  const markdown = "Done 🎉, all pass 👍.";
  const names: Record<string, string> = { "🎉": "party popper", "👍": "thumbs up" };
  const speech = readAloudSpeech(markdown, true, { emoji: (emoji) => names[emoji] });
  expect(speech.text).toBe("Done party popper, all pass thumbs up.");
  expect(speech.sources[speech.text.indexOf("popper")]).toBe(markdown.indexOf("🎉") + 1);
  expect(readAloudText(markdown, true)).toBe(markdown);
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

it("leaves rendered formulas out of the cues a renderer searches its text for", () => {
  const markdown = "Predict the start of word $i$.";
  const math = (tex: string) => (tex === "i" ? "i" : undefined);
  const speech = readAloudSpeech(markdown, true, { math });
  const formula = speech.text.lastIndexOf("i");
  const position = readAloudPosition(speech, formula, formula + 1);
  // The rendered paragraph's text ends "word ." since the formula shows as math.
  expect(position?.block.last).toEqual({ text: ".", occurrence: 0 });
  expect(position?.word.cue).toBeNull();
  // Shown as TeX without math rendering, the formula is text like any other.
  const plain = readAloudSpeech(markdown, true);
  const tex = plain.text.indexOf("$i$");
  expect(readAloudPosition(plain, tex, tex + 3)?.word.cue).toEqual({ text: "$i$", occurrence: 0 });
});

it("places words spoken for a block formula, which shows no text a renderer can search", () => {
  const markdown = "Euler wrote:\n\n$$\ne^{i\\pi} + 1 = 0\n$$\n\nAnd that was that.";
  const math = () => "e to the i pi plus one equals zero";
  const speech = readAloudSpeech(markdown, true, { math });
  const plus = speech.text.indexOf("plus");
  const position = readAloudPosition(speech, plus, plus + 4);
  const formula = { start: markdown.indexOf("$$"), end: markdown.lastIndexOf("$$") + 2 };
  expect(position?.block).toMatchObject({ ...formula, first: null, last: null });
  expect(position?.word.cue).toBeNull();
  expect(position?.word.start).toBeGreaterThanOrEqual(formula.start);
  expect(position?.word.end).toBeLessThanOrEqual(formula.end);
});

it("finds the block and word being read in text a renderer shows", () => {
  const markdown = [
    "# Plan",
    "Use **readAloud** and see [the docs](https://example.com).",
    "- First item\n- Second item",
    "| File | Change |\n| --- | --- |\n| a.ts | Adds `x` |",
    "```ts\ncode();\n```",
    "The cat saw the **cat**.",
  ].join("\n\n");
  const shown =
    "Plan\nUse readAloud and see the docs.\n• First item\n• Second item\nFile\tChange\na.ts\tAdds x\ncode();\nThe cat saw the cat.";
  const speech = readAloudSpeech(markdown, true);
  const locate = readAloudShownText(markdown, shown);
  const at = (spoken: string, from = 0) => {
    const start = speech.text.indexOf(spoken, from);
    const position = readAloudPosition(speech, start, start + spoken.length);
    if (!position) throw new Error(`no position for ${spoken}`);
    const found = locate(position);
    const slice = (range: { start: number; end: number } | null) =>
      range && shown.slice(range.start, range.end);
    return { block: slice(found.block), word: slice(found.word) };
  };
  expect(at("readAloud")).toEqual({ block: "Use readAloud and see the docs.", word: "readAloud" });
  expect(at("docs.")).toEqual({ block: "Use readAloud and see the docs.", word: "docs." });
  // The block is its whole line, marker included.
  expect(at("Second")).toEqual({ block: "• Second item", word: "Second" });
  expect(at("Adds")).toEqual({ block: "a.ts\tAdds x", word: "Adds" });
  expect(at("cat.")).toEqual({ block: "The cat saw the cat.", word: "cat." });

  // A renderer that shows only part of the reply still finds the words it shows.
  const tail = readAloudShownText(markdown, "The cat saw the cat.");
  const cat = speech.text.lastIndexOf("cat");
  const position = readAloudPosition(speech, cat, cat + 3);
  expect(position && tail(position)).toEqual({
    block: { start: 0, end: 20 },
    word: { start: 16, end: 20 },
  });
  const first = speech.text.indexOf("First");
  const elsewhere = readAloudPosition(speech, first, first + 5);
  expect(elsewhere && tail(elsewhere)).toEqual({ block: null, word: null });
});

it("finds words a renderer shows some other way between the words around them", () => {
  const markdown = [
    "Einstein wrote $E = mc^2$ in 1905.",
    "$x^2$",
    "See the `apps/web/src/ThreadList.tsx` file for the list.",
  ].join("\n\n");
  // Formulas show as attachments, and the file as a chip with its name.
  const shown = "Einstein wrote \uFFFC in 1905.\n\uFFFC\nSee the ThreadList file for the list.";
  const words: Record<string, string> = { "E = mc^2": "E equals m c squared", "x^2": "x squared" };
  const speech = readAloudSpeech(markdown, true, { math: (tex) => words[tex] });
  const locate = readAloudShownText(markdown, shown);
  const at = (spoken: string) => {
    const start = speech.text.indexOf(spoken);
    const position = readAloudPosition(speech, start, start + spoken.length);
    if (!position) throw new Error(`no position for ${spoken}`);
    const found = locate(position);
    const slice = (range: { start: number; end: number } | null) =>
      range && shown.slice(range.start, range.end);
    return { block: slice(found.block), word: slice(found.word) };
  };
  expect(at("squared")).toEqual({ block: "Einstein wrote \uFFFC in 1905.", word: "\uFFFC" });
  // A block of nothing but a formula still has a place.
  expect(at("x")).toEqual({ block: "\uFFFC", word: "\uFFFC" });
  expect(at("ThreadList.tsx")).toEqual({
    block: "See the ThreadList file for the list.",
    word: "ThreadList",
  });
});

it("matches the words beside a formula drawn as math", () => {
  const markdown = "It minimizes $L$ over $n$ samples.";
  const shown = "It minimizes \uFFFC over \uFFFC samples.";
  const speech = readAloudSpeech(markdown, true, { math: (tex) => tex.toLowerCase() });
  const locate = readAloudShownText(markdown, shown, { math: true });
  const at = (spoken: string) => {
    const start = speech.text.indexOf(spoken);
    const position = readAloudPosition(speech, start, start + spoken.length)!;
    const found = locate(position).word;
    return found && shown.slice(found.start, found.end);
  };
  expect(at("over")).toBe("over");
  expect(at("l")).toBe("\uFFFC");
  // Without drawn math, the TeX words take the matches next to them.
  const word = readAloudShownText(
    markdown,
    shown,
  )(readAloudPosition(speech, speech.text.indexOf("over"), speech.text.indexOf("over") + 4)!).word;
  expect(word && shown.slice(word.start, word.end)).not.toBe("over");
});

it("reads from a tapped word, else from the block of the line tapped", () => {
  const markdown = "Einstein wrote $E = mc^2$.\n\nNext paragraph.";
  const shown = "Einstein wrote \uFFFC.\nNext paragraph.";
  const speech = readAloudSpeech(markdown, true, { math: () => "E equals m c squared" });
  expect(speech.text).toContain("squared");
  expect(readAloudTapAtShown(markdown, shown, shown.indexOf("wrote"))).toEqual({
    from: markdown.indexOf("wrote"),
    word: true,
  });
  // Past the line's last matched word, the tap reads its block rather than the next one.
  expect(readAloudTapAtShown(markdown, shown, shown.indexOf("\uFFFC"))).toEqual({
    from: markdown.indexOf("Einstein"),
    word: false,
  });
  expect(readAloudTapAtShown(markdown, "\uFFFC", 0)).toBeNull();
});

it("maps a place in the text a renderer shows to the block reading starts from", () => {
  const markdown = [
    "# Plan",
    "Use **readAloud** here.",
    "- First item\n- Second item",
    "```ts\ncode();\n```",
    "Yes.",
    "Yes.",
  ].join("\n\n");
  const shown = "Plan\nUse readAloud here.\n• First item\n• Second item\ncode();\nYes.\nYes.";
  const speech = readAloudSpeech(markdown, true);
  const startsAt = (offset: number) => {
    const source = readAloudSourceAtShown(markdown, shown, offset);
    const block = source === null ? undefined : readAloudBlockFrom(speech, source);
    return block && speech.text.slice(block.spokenStart, block.spokenEnd);
  };
  expect(startsAt(shown.indexOf("readAloud"))).toBe("Use readAloud here.");
  // The bullet is not spoken, so it starts the item it marks.
  expect(startsAt(shown.indexOf("• Second"))).toBe("Second item.");
  // Repeated paragraphs keep their own place.
  expect(startsAt(shown.lastIndexOf("Yes."))).toBe("Yes.");
  expect(readAloudSourceAtShown(markdown, shown, shown.lastIndexOf("Yes."))).toBe(
    markdown.lastIndexOf("Yes."),
  );
  // A skipped code block starts the next block read.
  expect(readAloudBlockFrom(speech, markdown.indexOf("code();"))?.sourceStart).toBe(
    markdown.indexOf("Yes."),
  );
  expect(readAloudSourceAtShown(markdown, shown, shown.length)).toBeNull();
  expect(readAloudBlockFrom(speech, markdown.length)).toBeUndefined();
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

it("picks speech up from the start of a word's sentence, unless that runs too long", () => {
  const text = "Done.\nReads the manifest first. Streams a terminal result.";
  expect(readAloudSentenceStart(text, text.indexOf("terminal"))).toBe(text.indexOf("Streams"));
  expect(readAloudSentenceStart(text, text.indexOf("manifest"))).toBe(text.indexOf("Reads"));
  expect(readAloudSentenceStart(text, 2)).toBe(0);
  const long = `${"word ".repeat(100)}end`;
  expect(readAloudSentenceStart(long, long.indexOf("end"))).toBe(long.indexOf("end"));
});

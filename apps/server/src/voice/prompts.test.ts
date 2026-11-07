import { expect, it } from "vite-plus/test";

import {
  capResult,
  delegationText,
  FRONT_SYSTEM_PROMPT,
  limitSpeech,
  makeFrontHistory,
} from "./prompts.ts";

const reply = (speech: string) => ({ action: "reply" as const, speech });

it("keeps a stable prefix and trims from 40 messages to 20 only after a turn", () => {
  const history = makeFrontHistory();
  for (let turn = 0; turn < 20; turn++)
    history.commit([{ type: "user", text: `question ${turn}` }], reply(`answer ${turn}`));
  expect(history.length).toBe(40);
  const before = history.messages([{ type: "user", text: "next" }]);
  expect(before[0]).toEqual({ role: "system", content: FRONT_SYSTEM_PROMPT });
  expect(before.at(-1)).toEqual({ role: "user", content: "next" });
  // A turn after the trim reuses the trimmed prefix unchanged.
  history.commit([{ type: "user", text: "next" }], reply("sure"));
  expect(history.length).toBe(20);
  const after = history.messages([]);
  expect(after[1]).toEqual({ role: "user", content: "question 11" });
  history.commit([{ type: "user", text: "again" }], reply("yes"));
  expect(history.messages([]).slice(0, 21)).toEqual(after);
});

it("sends adjacent user words as one turn and agent results as their own", () => {
  const messages = makeFrontHistory().messages([
    { type: "user", text: "check the" },
    { type: "user", text: "build logs" },
    { type: "result", status: "completed", text: "The build passed." },
    { type: "result", status: "failed", text: "" },
  ]);
  expect(messages.slice(1)).toEqual([
    { role: "user", content: "check the build logs" },
    { role: "user", content: "[Agent finished]\nThe build passed." },
    { role: "user", content: "[Agent stopped: failed]" },
  ]);
});

it("caps a relayed result near 500 tokens at a word boundary", () => {
  const long = "word ".repeat(1000);
  const capped = capResult(long);
  expect(capped.length).toBeLessThanOrEqual(2000 + " [truncated]".length);
  expect(capped.endsWith("word [truncated]")).toBe(true);
  expect(capResult("  short  ")).toBe("short");
});

it.each([
  ["One. Two. Three.", "One. Two."],
  ["One. Two. Want more?", "One. Two. Want more?"],
  ["One. Two. Three? Four?", "One. Two. Three?"],
  ["Just this", "Just this"],
])("limits %j to two sentences and a question", (text, expected) => {
  expect(limitSpeech(text)).toBe(expected);
});

it("sends the user's words, the front's reading, and held notes", () => {
  expect(
    delegationText({
      words: "run the test suite",
      task: "Run the full test suite and report failures.",
      notes: ['The user said "mm-hm".'],
    }),
  ).toBe(
    'run the test suite\n\nVoice assistant\'s reading: Run the full test suite and report failures.\n\nNotes from the voice call:\n- The user said "mm-hm".',
  );
  expect(delegationText({ words: "fix it", task: "fix it", notes: [] })).toBe("fix it");
});

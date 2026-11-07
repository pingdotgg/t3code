import { expect, it } from "vite-plus/test";

import { classifyInterruption, heardOnlyEcho, isBackchannel, splitAtCursor } from "./turnTaking.ts";

const ms = (value: number) => value * 16;

it.each([
  ["Mm-hm.", true],
  ["yeah yeah", true],
  ["Okay", true],
  ["got it", true],
  ["Uh huh.", true],
  ["got", false],
  ["yeah, but wait", false],
  ["stop", false],
  ["", false],
])("hears %j as a listening sound: %s", (text, expected) => {
  expect(isBackchannel(text)).toBe(expected);
});

it.each([
  ["the tests pass", true],
  ["The tests, pass!", true],
  ["the tests fail", false],
  ["", false],
])("treats %j as echo of recently played words: %s", (text, expected) => {
  expect(heardOnlyEcho(text, new Set(["all", "the", "tests", "pass"]))).toBe(expected);
});

const echo = new Set(["running", "the", "tests", "now"]);
it.each([
  // Still speaking, or too soon after it to judge.
  ["", 0, ms(500), ms(500), "pending"],
  ["mm", 0, ms(400), ms(500), "pending"],
  ["got", 0, ms(450), ms(500), "pending"],
  // A word the voice never said is a turn at once.
  ["wait", 0, ms(500), ms(500), "turn"],
  ["yeah, but", 0, ms(500), ms(500), "turn"],
  // Settled: a short listening sound resumes the voice and becomes a note.
  ["mm-hm", 0, ms(600), ms(1000), "backchannel"],
  ["got it", ms(500), ms(1600), ms(2000), "backchannel"],
  // Too long for a listening sound.
  ["okay", 0, ms(1300), ms(1700), "turn"],
  // Only the voice's own words, or nothing recognizable, comes back as echo.
  ["the tests", 0, ms(900), ms(1500), "echo"],
  ["running the tests now", 0, ms(2500), ms(3000), "echo"],
  ["", 0, ms(600), ms(1000), "echo"],
] as const)(
  "judges %j heard from %i to %i, at %i: %s",
  (text, start, voicedUntil, samples, verdict) => {
    expect(classifyInterruption({ text, start, voicedUntil, samples, echo })).toBe(verdict);
  },
);

it.each([
  [0, { played: "", rest: "Sure thing. Running the tests now." }],
  [1000, { played: "Sure thing.", rest: "Running the tests now." }],
  // 70% of "Running the tests now." by characters.
  [1700, { played: "Sure thing. Running the", rest: "tests now." }],
  [2000, { played: "Sure thing. Running the tests now.", rest: "" }],
])("splits spoken text at cursor %i", (sample, expected) => {
  const sentences = [
    { text: "Sure thing.", end: 1000 },
    { text: "Running the tests now.", end: 2000 },
  ];
  expect(splitAtCursor(sentences, sample)).toEqual(expected);
});

it("leaves sentences not rendered yet unheard", () => {
  expect(splitAtCursor([{ text: "One two.", end: 800 }, { text: "Three four." }], 800)).toEqual({
    played: "One two.",
    rest: "Three four.",
  });
});

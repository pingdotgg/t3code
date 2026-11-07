import { expect, it } from "vite-plus/test";
import { splitSentences } from "./sentences.ts";

it.each([
  ["Sure. I'll run it now!", ["Sure.", "I'll run it now!"]],
  ["Version 3.5 passed. Done?", ["Version 3.5 passed.", "Done?"]],
  ["First line\nSecond line", ["First line", "Second line"]],
  ["Okay... ", ["Okay..."]],
  ["- ", []],
  ["", []],
])("splits %j into sentences", (text, sentences) => {
  expect(splitSentences(text)).toEqual(sentences);
});

it("breaks an overlong sentence at a clause, then at a space", () => {
  expect(splitSentences("alpha beta, gamma delta epsilon", 20)).toEqual([
    "alpha beta,",
    "gamma delta epsilon",
  ]);
  expect(splitSentences("alpha beta gamma delta epsilon", 12)).toEqual([
    "alpha beta",
    "gamma delta",
    "epsilon",
  ]);
});

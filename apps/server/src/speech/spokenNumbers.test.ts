import { readAloudText } from "@t3tools/shared/read-aloud";
import { expect, it } from "vite-plus/test";
import { spokenNumbers } from "./spokenNumbers.ts";

// The first two rows hold digits a Realtime voice misread when it spelled them itself.
it.each([
  [
    "Merged #35910 after 840 tests.",
    "Merged number three five nine one zero after eight hundred forty tests.",
  ],
  [
    "Fixed CVE ID 123633 on 100.64.0.10.",
    "Fixed CVE ID one two three six three three on one hundred dot sixty-four dot zero dot ten.",
  ],
  [
    "Released v2.5 and t3@1.5.13 on 2026-11-24 at 17:05.",
    "Released version two point five and t3 version one point five point thirteen on the twenty-fourth of November, twenty twenty-six at seventeen oh five.",
  ],
  [
    "It costs $4,500, or 92% of 41,693, at 0.089 a minute.",
    "It costs four thousand five hundred US dollars, or ninety-two percent of forty-one thousand six hundred ninety-three, at zero point zero eight nine a minute.",
  ],
  // Digits joined to other characters stay whole rather than half spelled.
  [
    "Took 1.2s and 1,000ms, 2x faster, for 3-5 MB in utf-8 at 9:00, not 12:30pm.",
    "Took 1.2s and 1,000ms, 2x faster, for 3-5 MB in utf-8 at nine o'clock, not 12:30pm.",
  ],
])("spells %j for the voice", (text, spoken) => {
  expect(spokenNumbers(text, "auto")).toBe(spoken);
  expect(spokenNumbers(text, "en-US")).toBe(spoken);
});

it.each([
  ["Hay 17 archivos.", "es"],
  ["Größe: 17 Dateien.", "auto"],
  ["Готово: 17 файла.", "auto"],
])("keeps the digits of %j in a reply that is not English", (text, language) => {
  expect(spokenNumbers(text, language)).toBe(text);
});

it("keeps every table row and value in order, with the numbers spelled", () => {
  const table = readAloudText(
    "| PR | Tests | Pass rate |\n|---|---|---|\n| #35910 | 840 | 99.5% |\n| #41809 | 1,204 | 100% |",
    true,
  );
  expect(spokenNumbers(table, "auto").split("\n")).toEqual([
    "PR, Tests, Pass rate.",
    "number three five nine one zero, eight hundred forty, ninety-nine point five percent.",
    "number four one eight zero nine, one thousand two hundred four, one hundred percent.",
  ]);
});

import { expect, it } from "vite-plus/test";
import { countThreadSearchOccurrences, findThreadSearchRanges } from "./threadSearch.ts";

it("finds non-overlapping occurrences without invalidating Unicode offsets", () => {
  expect(findThreadSearchRanges("Deploy the Deployment", "deploy")).toEqual([
    { start: 0, end: 6 },
    { start: 11, end: 17 },
  ]);
  expect(findThreadSearchRanges("aaaa", "aa")).toEqual([
    { start: 0, end: 2 },
    { start: 2, end: 4 },
  ]);
  expect(findThreadSearchRanges("İİİ needle", "needle")).toEqual([{ start: 4, end: 10 }]);
});

it("matches both Greek sigma forms without changing source offsets", () => {
  expect(findThreadSearchRanges("ΟΣ ος οσ", "Σ")).toEqual([
    { start: 1, end: 2 },
    { start: 4, end: 5 },
    { start: 7, end: 8 },
  ]);
  expect(findThreadSearchRanges("ΟΣ ος οσ", "ς")).toEqual([
    { start: 1, end: 2 },
    { start: 4, end: 5 },
    { start: 7, end: 8 },
  ]);
  expect(findThreadSearchRanges("İ ΟΣ", "Σ")).toEqual([{ start: 3, end: 4 }]);
});

it("matches straight and curly apostrophes without changing source offsets", () => {
  expect(findThreadSearchRanges("don't don’t", "don’t")).toEqual([
    { start: 0, end: 5 },
    { start: 6, end: 11 },
  ]);
  expect(findThreadSearchRanges("İ don‘t", "don't")).toEqual([{ start: 2, end: 7 }]);
});

it("matches dotted capital I without changing source offsets", () => {
  expect(findThreadSearchRanges("📍 İstanbul ıstanbul i\u0307stanbul", "istanbul")).toEqual([
    { start: 3, end: 11 },
  ]);
  expect(findThreadSearchRanges("Istanbul istanbul", "İSTANBUL")).toEqual([
    { start: 0, end: 8 },
    { start: 9, end: 17 },
  ]);
});

it.each([
  { text: "prefix canary\r\n    migration", query: "canary migration", start: 7, end: 28 },
  { text: "one.+\t two", query: "one.+ two", start: 0, end: 10 },
])("counts a phrase and returns its full source range in $text", ({ text, query, start, end }) => {
  expect(countThreadSearchOccurrences(text, query)).toBe(1);
  expect(findThreadSearchRanges(text, query)).toEqual([{ start, end }]);
});

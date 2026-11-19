import { expect, it } from "vite-plus/test";
import { countThreadSearchOccurrences, findThreadSearchOccurrences } from "./threadSearch.ts";

it.each([
  {
    text: "📍 İstanbul İstanbul ıstanbul ístanbul i\u0307stanbul",
    query: "istanbul",
    offsets: [3, 12],
  },
  { text: "Istanbul istanbul", query: "İSTANBUL", offsets: [0, 9] },
])("finds dotted capital I matches in $text for $query", ({ text, query, offsets }) => {
  expect(findThreadSearchOccurrences(text, query)).toEqual(offsets);
  expect(countThreadSearchOccurrences(text, query)).toBe(offsets.length);
});

it("finds non-overlapping occurrences without invalidating Unicode offsets", () => {
  expect(findThreadSearchOccurrences("Deploy the Deployment", "deploy")).toEqual([0, 11]);
  expect(findThreadSearchOccurrences("aaaa", "aa")).toEqual([0, 2]);
  expect(findThreadSearchOccurrences("İİİ needle", "needle")).toEqual([4]);
});

it("matches both Greek sigma forms without changing source offsets", () => {
  expect(findThreadSearchOccurrences("ΟΣ ος οσ", "Σ")).toEqual([1, 4, 7]);
  expect(findThreadSearchOccurrences("ΟΣ ος οσ", "ς")).toEqual([1, 4, 7]);
  expect(findThreadSearchOccurrences("İ ΟΣ", "Σ")).toEqual([3]);
});

it("matches straight and curly apostrophes without changing source offsets", () => {
  expect(findThreadSearchOccurrences("don't don’t", "don’t")).toEqual([0, 6]);
  expect(findThreadSearchOccurrences("İ don‘t", "don't")).toEqual([2]);
});

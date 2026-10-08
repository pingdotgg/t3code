import { expect, it } from "vite-plus/test";
import { findThreadSearchOccurrences, splitThreadSearchText } from "./threadSearch.ts";

it("finds non-overlapping occurrences without invalidating Unicode offsets", () => {
  expect(findThreadSearchOccurrences("Deploy the Deployment", "deploy")).toEqual([0, 11]);
  expect(findThreadSearchOccurrences("aaaa", "aa")).toEqual([0, 2]);
  expect(findThreadSearchOccurrences("İİİ needle", "needle")).toEqual([4]);
});

it("splits search text into highlighted and unhighlighted parts", () => {
  expect(splitThreadSearchText("one TWO three two", " two ")).toEqual([
    { text: "one ", highlighted: false, start: 0 },
    { text: "TWO", highlighted: true, start: 4 },
    { text: " three ", highlighted: false, start: 7 },
    { text: "two", highlighted: true, start: 14 },
  ]);
});

it("matches both Greek sigma forms without changing source offsets", () => {
  expect(findThreadSearchOccurrences("ΟΣ ος οσ", "Σ")).toEqual([1, 4, 7]);
  expect(findThreadSearchOccurrences("ΟΣ ος οσ", "ς")).toEqual([1, 4, 7]);
  expect(findThreadSearchOccurrences("İ ΟΣ", "Σ")).toEqual([3]);
});

import { expect, it } from "vite-plus/test";
import { findThreadSearchOccurrences } from "./threadSearch.ts";

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

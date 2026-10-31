import { expect, it } from "vite-plus/test";

import { shouldFinishDictationOnRelease } from "./useDictationShortcut";

it("treats a short auto press as a latched recording and a hold as push to talk", () => {
  expect(shouldFinishDictationOnRelease("auto", 299)).toBe(false);
  expect(shouldFinishDictationOnRelease("auto", 300)).toBe(true);
  expect(shouldFinishDictationOnRelease("hold", 20)).toBe(true);
  expect(shouldFinishDictationOnRelease("toggle", 500)).toBe(false);
});

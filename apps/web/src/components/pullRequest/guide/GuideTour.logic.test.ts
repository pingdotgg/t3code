import type { FileDiffMetadata } from "@pierre/diffs";
import { expect, it } from "vite-plus/test";
import { guideViewedFiles } from "./GuideTour.logic";

it("uses only displayed file revisions and waits for every requested file", () => {
  const files = new Map([
    ["a.ts", { newObjectId: "displayed-a" } as FileDiffMetadata],
    ["b.ts", { newObjectId: "displayed-b" } as FileDiffMetadata],
    ["unknown.ts", {} as FileDiffMetadata],
  ]);
  expect(guideViewedFiles(files, ["a.ts", "b.ts"])).toEqual([
    { path: "a.ts", revision: "displayed-a" },
    { path: "b.ts", revision: "displayed-b" },
  ]);
  expect(guideViewedFiles(files, ["a.ts", "missing.ts"])).toBeNull();
  expect(guideViewedFiles(files, ["unknown.ts"])).toBeNull();
});

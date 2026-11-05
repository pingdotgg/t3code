import { parsePatchFiles } from "@pierre/diffs/utils/parsePatchFiles";
import { describe, expect, it } from "vite-plus/test";

import { diffViewedEntry, diffViewedFingerprint, useDiffViewedStore } from "./diffViewedStore";

function patchFile(index: string, hunk: string) {
  return parsePatchFiles(
    `diff --git a/a.ts b/a.ts\nindex ${index} 100644\n--- a/a.ts\n+++ b/a.ts\n${hunk}`,
    "a.ts",
  )[0]!.files[0]!;
}

const WITH_WHITESPACE = "@@ -1,2 +1,2 @@\n-a  =  1\n+a = 1\n-b\n+c\n";
const WITHOUT_WHITESPACE = "@@ -2 +2 @@\n-b\n+c\n";

function setup() {
  useDiffViewedStore.setState({ viewedByThreadKey: {} });
  return useDiffViewedStore.getState();
}

describe("diffViewedFingerprint", () => {
  it("survives the whitespace toggle and changes with the file contents", () => {
    const viewed = patchFile("1111111..2222222", WITH_WHITESPACE);
    expect(diffViewedFingerprint(patchFile("1111111..2222222", WITHOUT_WHITESPACE))).toBe(
      diffViewedFingerprint(viewed),
    );
    expect(diffViewedFingerprint(patchFile("1111111..3333333", WITH_WHITESPACE))).not.toBe(
      diffViewedFingerprint(viewed),
    );
  });

  it("falls back to the diff content without blob ids", () => {
    const withoutIndex = (hunk: string) =>
      parsePatchFiles(`diff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n${hunk}`, "a.ts")[0]!
        .files[0]!;
    expect(diffViewedFingerprint(withoutIndex(WITHOUT_WHITESPACE))).not.toBe(
      diffViewedFingerprint(withoutIndex(WITH_WHITESPACE)),
    );
  });
});

describe("useDiffViewedStore", () => {
  it("keeps one fingerprint per file, so a changed file reads as unviewed", () => {
    const store = setup();
    store.setFileViewed("thread", "a.ts", "old", true);
    store.setFileViewed("thread", "a.ts", "new", true);
    expect(useDiffViewedStore.getState().viewedByThreadKey.thread).toEqual([
      diffViewedEntry("a.ts", "new"),
    ]);
    store.setFileViewed("thread", "a.ts", "new", false);
    expect(useDiffViewedStore.getState().viewedByThreadKey).toEqual({});
  });

  it("drops the oldest files and the least recently reviewed threads past the caps", () => {
    const store = setup();
    for (let index = 0; index <= 2000; index += 1) {
      store.setFileViewed("big", `file-${index}.ts`, "v", true);
    }
    const files = useDiffViewedStore.getState().viewedByThreadKey.big;
    expect(files).toHaveLength(2000);
    expect(files?.[0]).toBe(diffViewedEntry("file-1.ts", "v"));

    for (let index = 0; index < 100; index += 1) {
      store.setFileViewed(`thread-${index}`, "a.ts", "v", true);
    }
    store.setFileViewed("thread-0", "b.ts", "v", true);
    const threads = Object.keys(useDiffViewedStore.getState().viewedByThreadKey);
    expect(threads).toHaveLength(100);
    expect(threads).not.toContain("big");
    expect(threads.at(-1)).toBe("thread-0");
  });
});

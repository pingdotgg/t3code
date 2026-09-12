import { afterEach, assert, it, vi } from "vite-plus/test";

import { appAtomRegistry } from "../../state/atom-registry";
import { getCachedNativeReviewDiffData } from "./nativeReviewDiffAdapter";
import * as ReviewModel from "./reviewModel";
import { getCachedReviewParsedDiff, MAX_CACHED_REVIEW_SOURCE_CHARACTERS } from "./reviewState";
import { getReviewDiffPrewarmSections, prewarmReviewDiffSection } from "./useReviewDiffPrewarming";

const threadKey = "env:thread-prewarm";
const reviewDiff = [
  "diff --git a/src/a.ts b/src/a.ts",
  "new file mode 100644",
  "--- /dev/null",
  "+++ b/src/a.ts",
  "@@ -0,0 +1 @@",
  "+export const value = 1;",
].join("\n");

function makeSection(index: number, diff: string | null = reviewDiff) {
  return {
    id: `turn:${index}`,
    kind: "turn",
    title: `Turn ${index}`,
    subtitle: null,
    isLoading: false,
    diff,
  } satisfies ReviewModel.ReviewSectionItem;
}

function prepareSelection(
  sections: ReadonlyArray<ReviewModel.ReviewSectionItem>,
  selectedSectionId: string,
) {
  const section = sections.find((candidate) => candidate.id === selectedSectionId);
  assert.ok(section);
  const input = { threadKey, sectionId: section.id, diff: section.diff };
  const parsed = getCachedReviewParsedDiff(input);
  const native = getCachedNativeReviewDiffData({ parsedDiff: parsed });
  for (const pending of getReviewDiffPrewarmSections({ threadKey, sections, selectedSectionId })) {
    prewarmReviewDiffSection({ threadKey: input.threadKey, section: pending });
  }
  assert.strictEqual(getCachedReviewParsedDiff(input), parsed);
  assert.strictEqual(getCachedNativeReviewDiffData({ parsedDiff: parsed }), native);
  return { parsed, native };
}

afterEach(() => {
  appAtomRegistry.reset();
  vi.restoreAllMocks();
});

it("warms the nearest sections within the remaining entry budget", () => {
  const sections = Array.from({ length: 12 }, (_, index) => makeSection(index));

  const pending = getReviewDiffPrewarmSections({
    threadKey,
    sections,
    selectedSectionId: "turn:5",
  });

  assert.deepStrictEqual(
    pending.map((section) => section.id),
    ["turn:4", "turn:6", "turn:3", "turn:7", "turn:2", "turn:8", "turn:1"],
  );
});

it("reserves the selected source budget and skips unloaded or oversized sections", () => {
  const halfBudget = "x".repeat(2 * 1024 * 1024);
  const sections = [
    makeSection(0),
    makeSection(1, halfBudget),
    makeSection(2, "x".repeat(MAX_CACHED_REVIEW_SOURCE_CHARACTERS + 1)),
    makeSection(3, halfBudget),
    makeSection(4, null),
    makeSection(5),
  ];

  const pending = getReviewDiffPrewarmSections({
    threadKey,
    sections,
    selectedSectionId: "turn:3",
  });

  assert.deepStrictEqual(
    pending.map((section) => section.id),
    ["turn:1"],
  );
  prepareSelection(sections, "turn:3");
});

it("reserves a larger retained source when the selected input loses whitespace", () => {
  const parsed = getCachedReviewParsedDiff({
    threadKey,
    sectionId: "turn:0",
    diff: reviewDiff.padEnd(MAX_CACHED_REVIEW_SOURCE_CHARACTERS, " "),
  });
  const native = getCachedNativeReviewDiffData({ parsedDiff: parsed });

  const selected = prepareSelection([makeSection(0), makeSection(1)], "turn:0");

  assert.strictEqual(selected.parsed, parsed);
  assert.strictEqual(selected.native, native);
});

it("reserves a larger retained source when a neighboring input loses whitespace", () => {
  const parsed = getCachedReviewParsedDiff({
    threadKey,
    sectionId: "turn:1",
    diff: reviewDiff.padEnd(MAX_CACHED_REVIEW_SOURCE_CHARACTERS - reviewDiff.length, " "),
  });
  const native = getCachedNativeReviewDiffData({ parsedDiff: parsed });

  prepareSelection([makeSection(0), makeSection(1), makeSection(2)], "turn:0");

  assert.strictEqual(
    getCachedReviewParsedDiff({
      threadKey,
      sectionId: "turn:1",
      diff: reviewDiff,
    }),
    parsed,
  );
  assert.strictEqual(getCachedNativeReviewDiffData({ parsedDiff: parsed }), native);
});

it.each([null, "turn:missing"])(
  "does not prewarm without a selected section: %s",
  (selectedSectionId) => {
    assert.deepStrictEqual(
      getReviewDiffPrewarmSections({ threadKey, sections: [makeSection(0)], selectedSectionId }),
      [],
    );
  },
);

it("does not prewarm when the selected section exceeds the source budget", () => {
  const sections = [
    makeSection(0, "x".repeat(MAX_CACHED_REVIEW_SOURCE_CHARACTERS + 1)),
    makeSection(1),
  ];

  assert.deepStrictEqual(
    getReviewDiffPrewarmSections({ threadKey, sections, selectedSectionId: "turn:0" }),
    [],
  );
});

it("does not parse an oversized direct prewarm that the cache cannot retain", () => {
  const parse = vi.spyOn(ReviewModel, "buildReviewParsedDiff");

  prewarmReviewDiffSection({
    threadKey,
    section: makeSection(0, "x".repeat(MAX_CACHED_REVIEW_SOURCE_CHARACTERS + 1)),
  });

  assert.strictEqual(parse.mock.calls.length, 0);
});

it("reuses selected and native results across repeated nearby selections", () => {
  const parse = vi.spyOn(ReviewModel, "buildReviewParsedDiff");
  const sections = Array.from({ length: 10 }, (_, index) => makeSection(index));
  const first = prepareSelection(sections, "turn:0");
  assert.strictEqual(parse.mock.calls.length, 8);
  parse.mockClear();
  const second = prepareSelection(sections, "turn:1");

  for (let pass = 0; pass < 3; pass += 1) {
    const firstAgain = prepareSelection(sections, "turn:0");
    assert.strictEqual(firstAgain.parsed, first.parsed);
    assert.strictEqual(firstAgain.native, first.native);
    const secondAgain = prepareSelection(sections, "turn:1");
    assert.strictEqual(secondAgain.parsed, second.parsed);
    assert.strictEqual(secondAgain.native, second.native);
  }

  assert.strictEqual(parse.mock.calls.length, 0);
});

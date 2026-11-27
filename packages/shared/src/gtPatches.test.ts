import { gtFallback } from "gt-i18n";
import { hashMessage } from "gt-i18n/internal";
import { expect, it } from "vite-plus/test";

// Both tests cover caches that our patches in `patches/` add to GT.

const reviewLine = (verb: string) => [
  { t: "Text", i: 1, c: { i: 2, k: "_gt_value_2", v: "v" as const } },
  { t: "Text", i: 3, c: verb },
];

// Both lines once shared a cache key, so the second took the first one's translation.
it("gives each <T> source the hash its catalog entry is stored under", () => {
  expect(hashMessage(reviewLine(" approved"), { $format: "JSX" })).toBe("434c5d09b87ac637");
  expect(hashMessage(reviewLine(" requested changes"), { $format: "JSX" })).toBe(
    "e07dc0fde524c9ad",
  );
});

it("selects the plural branch with each locale's own rules", () => {
  const format = ($locale: string) =>
    gtFallback("{count, plural, one {one} few {few} other {other}}", { count: 3, $locale });
  expect(["en", "ru", "en"].map(format)).toEqual(["other", "few", "other"]);
});

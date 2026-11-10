import * as Test from "@alchemy.run/test/Alchemy";

/**
 * An explicit physical name for a test about explicitly provided names:
 * `base` plus a short hash of the test stage (`test_$USER` by default), so it
 * is the same on every run and never collides with another user's run. Tests
 * that aren't about names pass no name and let the resource generate one.
 *
 * The suffix is 6 lowercase hex characters, so it fits names limited to
 * letters and digits; `separator` joins it for names that don't allow `-`.
 */
export const testName = (base: string, separator = "-"): string =>
  `${base}${separator}${stageHash(Test.defaultStage())}`;

/**
 * The short stage hash `testName` appends, for names a test assembles itself
 * (hostnames, route prefixes): the same on every run, distinct per user and
 * worktree.
 */
export const stageSuffix = (): string => stageHash(Test.defaultStage());

// FNV-1a: deterministic and dependency-free.
const stageHash = (stage: string): string => {
  let hash = 0x811c9dc5;
  for (let i = 0; i < stage.length; i++) {
    hash ^= stage.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0").slice(0, 6);
};

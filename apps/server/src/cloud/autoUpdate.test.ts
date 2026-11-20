import { expect, it } from "@effect/vitest";

import { autoUpdateTarget } from "./autoUpdate.ts";

const outcome = (status: "committed" | "rolled-back" | "failed", targetVersion: string) => ({
  id: "update-1",
  fromVersion: "0.1.10",
  targetVersion,
  status,
});

it.each([
  ["a newer release", "0.1.11", undefined, "0.1.11"],
  ["the running release", "0.1.10", undefined, undefined],
  ["an older release", "0.1.9", undefined, undefined],
  ["a release whose trial rolled back", "0.1.11", outcome("rolled-back", "0.1.11"), undefined],
  ["a release whose trial failed", "0.1.11", outcome("failed", "0.1.11"), undefined],
  [
    "a release newer than one that rolled back",
    "0.1.12",
    outcome("rolled-back", "0.1.11"),
    "0.1.12",
  ],
] as const)("moves to %s only when it can", (_, newest, lastOutcome, expected) => {
  expect(autoUpdateTarget({ current: "0.1.10", newest, lastOutcome })).toBe(expected);
});

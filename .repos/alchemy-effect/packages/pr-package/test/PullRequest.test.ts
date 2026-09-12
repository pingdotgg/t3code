import { expect, test } from "bun:test";
import {
  emptyState,
  releasePullRequests,
  tiePullRequest,
  withoutTags,
  type PackageState,
} from "../src/PackageState.ts";
import {
  formatPullRequest,
  isStillOpen,
  MAX_UNVERIFIED_MS,
  parsePullRequest,
  shouldRenewOnTtl,
} from "../src/PullRequest.ts";

test("parsePullRequest accepts owner/repo#number and GitHub URLs", () => {
  expect(parsePullRequest(undefined)).toBeUndefined();
  expect(parsePullRequest("")).toBeUndefined();
  expect(parsePullRequest("   ")).toBeUndefined();
  expect(parsePullRequest("not-a-pr")).toBe("invalid");
  expect(parsePullRequest("alchemy-run/alchemy#550")).toEqual({
    owner: "alchemy-run",
    repo: "alchemy",
    number: 550,
  });
  expect(
    parsePullRequest("https://github.com/alchemy-run/alchemy/pull/550"),
  ).toEqual({
    owner: "alchemy-run",
    repo: "alchemy",
    number: 550,
  });
  expect(parsePullRequest("alchemy-run/alchemy/550")).toEqual({
    owner: "alchemy-run",
    repo: "alchemy",
    number: 550,
  });
  expect(parsePullRequest("acme/widgets#0")).toBe("invalid");
  expect(
    formatPullRequest({ owner: "alchemy-run", repo: "alchemy", number: 550 }),
  ).toBe("alchemy-run/alchemy#550");
});

test("isStillOpen treats unknown as open only within the verification window", () => {
  const now = 1_000_000_000_000;
  expect(isStillOpen({ state: "open", verifiedAt: 0 }, now)).toBe(true);
  expect(isStillOpen({ state: "closed", verifiedAt: now }, now)).toBe(false);
  expect(isStillOpen({ state: "unknown", verifiedAt: now - 1 }, now)).toBe(
    true,
  );
  expect(
    isStillOpen({ state: "unknown", verifiedAt: now - MAX_UNVERIFIED_MS }, now),
  ).toBe(false);
});

test("shouldRenewOnTtl renews while any tied PR is open", () => {
  const now = 1_000_000_000_000;
  expect(shouldRenewOnTtl([], now)).toBe(false);
  expect(
    shouldRenewOnTtl(
      [
        { state: "closed", verifiedAt: now },
        { state: "open", verifiedAt: now },
      ],
      now,
    ),
  ).toBe(true);
  expect(shouldRenewOnTtl([{ state: "closed", verifiedAt: now }], now)).toBe(
    false,
  );
});

const prC = { owner: "alchemy-run", repo: "alchemy", number: 3 };
const prB = { owner: "alchemy-run", repo: "alchemy", number: 2 };

const sharedTarball = (): PackageState => {
  // A distilled tarball published by `main`, then tied to two PRs that pin
  // the same distilled commit.
  let state: PackageState = {
    ...emptyState,
    packageName: "@distilled.cloud/core",
    hash: "a".repeat(64),
    tags: ["main", "abc1234", "commit-c", "branch-c", "pr-3"],
  };
  state = {
    ...state,
    pullRequests: tiePullRequest(
      state,
      prC,
      ["abc1234", "commit-c", "branch-c", "pr-3"],
      1,
    ),
  };
  state = {
    ...state,
    tags: [...state.tags, "branch-b", "pr-2"],
    pullRequests: tiePullRequest(
      state,
      prB,
      ["abc1234", "commit-c", "branch-b", "pr-2"],
      2,
    ),
  };
  return state;
};

test("closing one PR keeps tags another open PR still claims", () => {
  const state = sharedTarball();
  const released = releasePullRequests(
    state,
    (binding) => binding.ref.number === prB.number,
  );
  // pr-2 and branch-b belong only to PR B; the shared commit tags stay for
  // PR C and `main` was never PR-owned.
  expect([...released.tags].sort()).toEqual(["branch-b", "pr-2"]);
  expect(Object.keys(released.state.pullRequests ?? {})).toEqual([
    "alchemy-run/alchemy#3",
  ]);
});

test("releasing every PR frees all PR-owned tags but not main", () => {
  const state = sharedTarball();
  const released = releasePullRequests(state, () => true);
  expect([...released.tags].sort()).toEqual([
    "abc1234",
    "branch-b",
    "branch-c",
    "commit-c",
    "pr-2",
    "pr-3",
  ]);
  expect(released.state.pullRequests).toBeUndefined();
  const next = withoutTags(released.state, released.tags);
  expect(next.tags).toEqual(["main"]);
});

test("withoutTags drops PR bindings that lose their last tag", () => {
  const state = sharedTarball();
  const next = withoutTags(state, ["branch-b", "pr-2", "abc1234", "commit-c"]);
  expect(Object.keys(next.pullRequests ?? {})).toEqual([
    "alchemy-run/alchemy#3",
  ]);
  expect(next.pullRequests?.["alchemy-run/alchemy#3"]?.tags).toEqual([
    "branch-c",
    "pr-3",
  ]);
  expect(withoutTags(next, next.tags).pullRequests).toBeUndefined();
});

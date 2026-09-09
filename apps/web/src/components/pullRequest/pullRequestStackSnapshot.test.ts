import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { savedPullRequestStack, pullRequestStackView } from "./pullRequestStackSnapshot";

const reference = {
  projectId: ProjectId.make("project"),
  host: "github.com",
  repository: "acme/web",
  number: 2,
};
const link: ThreadPullRequestLink = {
  host: "github.com",
  repository: "acme/web",
  number: 2,
  url: "https://github.com/acme/web/pull/2",
  source: "manual",
  linkedAt: "2026-09-09T10:00:00Z",
  snapshot: {
    title: "Top layer",
    headBranch: "top",
    baseBranch: "bottom",
    state: "open",
    isDraft: false,
    updatedAt: null,
    syncedAt: "2026-09-09T10:00:00Z",
  },
  stack: {
    kind: "native",
    id: "stack",
    number: 3,
    url: "https://github.com/acme/web/pull/3",
    base: "main",
    layers: [
      { number: 1, headBranch: "bottom", state: "open" },
      { number: 2, headBranch: "top", state: "open" },
    ],
  },
};

describe("saved stack navigation", () => {
  it("preserves all native layers even when only one has a linked snapshot, without action SHAs", () => {
    const saved = savedPullRequestStack([link], reference);
    expect(saved?.layers).toEqual([
      { number: 1, headBranch: "bottom", state: "open" },
      { number: 2, headBranch: "top", state: "open", title: "Top layer", isDraft: false },
    ]);
    expect(savedPullRequestStack([link], { ...reference, number: 1 })?.number).toBe(3);
  });
  it("does not borrow stacks across hosts or repositories", () => {
    expect(savedPullRequestStack([link], { ...reference, host: "enterprise.example" })).toBeNull();
    expect(savedPullRequestStack([link], { ...reference, repository: "other/web" })).toBeNull();
    expect(savedPullRequestStack([link], { ...reference, host: undefined })).toBeNull();
  });
  it("honors a newer saved removal across linked threads", () => {
    expect(
      savedPullRequestStack(
        [
          link,
          {
            ...link,
            stack: null,
            snapshot: { ...link.snapshot!, syncedAt: "2026-09-09T11:00:00Z" },
          },
        ],
        reference,
      ),
    ).toBeNull();
  });
  it("shows saved data during loading and marks a failed refresh stale", () => {
    const saved = savedPullRequestStack([link], reference);
    const query = { data: null, isSuccess: false, isPending: true, error: null };
    expect(pullRequestStackView(query, saved)).toMatchObject({
      data: saved,
      isFresh: false,
      notice: expect.stringContaining("Refreshing"),
    });
    expect(
      pullRequestStackView({ ...query, isPending: false, error: "Rate limited" }, saved),
    ).toMatchObject({ data: saved, isFresh: false, notice: expect.stringContaining("stale") });
  });
  it("prefers refreshed data and honors a successful absence", () => {
    const saved = savedPullRequestStack([link], reference);
    const query = { data: saved, isSuccess: true, isPending: false, error: null };
    expect(pullRequestStackView(query, null)).toEqual({ data: saved, isFresh: true, notice: null });
    expect(pullRequestStackView({ ...query, data: null }, saved)).toEqual({
      data: null,
      isFresh: true,
      notice: null,
    });
    expect(pullRequestStackView({ ...query, isPending: true }, saved).isFresh).toBe(false);
  });
});

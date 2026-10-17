import type { ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { linkedPullRequestSnapshotStatus } from "./ThreadStatusIndicators";

describe("linked pull request snapshots", () => {
  const link: ThreadPullRequestLink = {
    host: "gitlab.example.com",
    repository: "acme/web",
    number: 42,
    url: "https://gitlab.example.com/acme/web/-/merge_requests/42",
    source: "manual",
    linkedAt: "2026-01-01T00:00:00Z",
    stack: null,
    snapshot: null,
  };
  it("keeps unsynced links unknown", () => {
    expect(linkedPullRequestSnapshotStatus(link)).toBeNull();
  });
  it("uses the snapshot state and branches with the linked identity", () => {
    const result = linkedPullRequestSnapshotStatus({
      ...link,
      snapshot: {
        state: "merged",
        title: "Change",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: "2026-01-02T00:00:00Z",
        syncedAt: "2026-01-03T00:00:00Z",
      },
    });
    expect(result).toEqual({
      pr: {
        number: 42,
        url: link.url,
        title: "Change",
        state: "merged",
        isDraft: false,
        headRef: "feature",
        baseRef: "main",
        updatedAt: "2026-01-02T00:00:00Z",
      },
      sourceControlProvider: { kind: "gitlab", name: "gitlab", baseUrl: "" },
    });
  });
  it.each([
    ["https://git.cafe/owner/repo/pulls/42", "gitcafe"],
    ["https://staging.git.cafe/owner/repo/pulls/42", "gitcafe"],
    ["https://codeberg.org/owner/repo/pulls/42", "forgejo"],
    ["https://gitlab.example.com/acme/web/-/merge_requests/42", "gitlab"],
    ["https://github.com/owner/repo/pull/42", "github"],
  ])("classifies %s as %s", (url, kind) => {
    const result = linkedPullRequestSnapshotStatus({
      ...link,
      url,
      snapshot: {
        state: "open",
        title: "Change",
        headBranch: "feature",
        baseBranch: "main",
        isDraft: false,
        updatedAt: null,
        syncedAt: "2026-01-03T00:00:00Z",
      },
    });
    expect(result?.sourceControlProvider.kind).toBe(kind);
  });
});

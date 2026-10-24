import { sourceControlClients } from "@t3tools/client-runtime/source-control-clients";
import { ProjectId, type PullRequestStack, type ThreadPullRequestLink } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  pullRequestStackMerge,
  savedPullRequestStack,
  singlePullRequestMergeAllowed,
} from "./pullRequestStack";

const GITHUB = sourceControlClients.get("github").changeRequest;

const stack: PullRequestStack = {
  id: "stack",
  number: 10,
  url: "https://github.com/acme/web/pull/10",
  base: "main",
  layers: [1, 2, 3].map((number) => ({
    number,
    headSha: `sha-${number}`,
    headBranch: `layer-${number}`,
    state: "open" as const,
    isDraft: false,
  })),
};
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
  linkedAt: "2026-10-08T10:00:00Z",
  snapshot: {
    title: "Middle layer",
    headBranch: "layer-2",
    baseBranch: "layer-1",
    state: "open",
    isDraft: false,
    updatedAt: null,
    syncedAt: "2026-10-08T10:00:00Z",
  },
  stack: { ...stack, kind: "native" },
};

describe("mobile stack merge scope", () => {
  it("merges only the prefix through the selected PR, preserving host order", () => {
    const scope = pullRequestStackMerge(stack, 2, GITHUB);
    expect(scope.position).toBe(2);
    expect(scope.heads).toEqual([
      { number: 1, headSha: "sha-1" },
      { number: 2, headSha: "sha-2" },
    ]);
    expect(scope.reason).toBeNull();
    expect(pullRequestStackMerge(stack, 3, GITHUB).heads).toHaveLength(3);
  });
  it("excludes already merged layers from the expected head revisions", () => {
    const updated = {
      ...stack,
      layers: stack.layers.map((layer) =>
        layer.number === 1 ? { ...layer, state: "merged" as const, headSha: undefined } : layer,
      ),
    };
    expect(pullRequestStackMerge(updated, 2, GITHUB).heads).toEqual([
      { number: 2, headSha: "sha-2" },
    ]);
    expect(pullRequestStackMerge(updated, 2, GITHUB).reason).toBeNull();
    expect(pullRequestStackMerge(updated, 1, GITHUB).reason).toContain("no open layers");
  });
  it("blocks closed and draft dependencies, but permits them above the target", () => {
    const closed = {
      ...stack,
      layers: stack.layers.map((layer) =>
        layer.number === 2 ? { ...layer, state: "closed" as const } : layer,
      ),
    };
    expect(pullRequestStackMerge(closed, 3, GITHUB).reason).toContain("Reopen");
    expect(pullRequestStackMerge(closed, 1, GITHUB).reason).toBeNull();
    const draft = {
      ...stack,
      layers: stack.layers.map((layer) =>
        layer.number === 2 ? { ...layer, isDraft: true } : layer,
      ),
    };
    expect(pullRequestStackMerge(draft, 3, GITHUB).reason).toContain("ready for review");
    expect(pullRequestStackMerge(draft, 1, GITHUB).reason).toBeNull();
  });
  it("blocks missing revisions and a PR removed from the stack", () => {
    const unknown = {
      ...stack,
      layers: stack.layers.map((layer) => ({ ...layer, headSha: undefined })),
    };
    expect(pullRequestStackMerge(unknown, 2, GITHUB).reason).toContain("latest revisions");
    expect(pullRequestStackMerge(stack, 99, GITHUB).reason).toContain("no longer in the stack");
    expect(
      pullRequestStackMerge(stack, 99, sourceControlClients.get("gitlab").changeRequest).reason,
    ).toBe("This merge request is no longer in the stack. Refresh it.");
  });
  it("waits for successful discovery before allowing a single PR merge on modern servers", () => {
    expect(
      singlePullRequestMergeAllowed({
        supportsStackActions: true,
        hasStack: false,
        isFresh: false,
      }),
    ).toBe(false);
    expect(
      singlePullRequestMergeAllowed({ supportsStackActions: true, hasStack: false, isFresh: true }),
    ).toBe(true);
    expect(
      singlePullRequestMergeAllowed({ supportsStackActions: true, hasStack: true, isFresh: true }),
    ).toBe(false);
    expect(
      singlePullRequestMergeAllowed({
        supportsStackActions: false,
        hasStack: false,
        isFresh: false,
      }),
    ).toBe(true);
  });
});

describe("mobile saved stack navigation", () => {
  it("keeps all saved layers and enriches titles without carrying action revisions", () => {
    const saved = savedPullRequestStack([link], reference);
    expect(saved?.layers).toHaveLength(3);
    expect(saved?.layers[1]).toMatchObject({ number: 2, title: "Middle layer", isDraft: false });
    expect(saved?.layers.every((layer) => layer.headSha === undefined)).toBe(true);
    expect(pullRequestStackMerge(saved!, 2, GITHUB).reason).toContain("latest revisions");
    expect(savedPullRequestStack([link], { ...reference, number: 3 })?.number).toBe(10);
  });
  it("never borrows membership from another host or repository", () => {
    expect(savedPullRequestStack([link], { ...reference, host: "enterprise.example" })).toBeNull();
    expect(savedPullRequestStack([link], { ...reference, repository: "other/web" })).toBeNull();
    expect(savedPullRequestStack([link], { ...reference, host: undefined })).toBeNull();
  });
  it("honors a newer removal rather than reviving an old stack", () => {
    const removed = {
      ...link,
      stack: null,
      snapshot: { ...link.snapshot!, syncedAt: "2026-10-08T11:00:00Z" },
    };
    expect(savedPullRequestStack([link, removed], reference)).toBeNull();
  });
});

import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
  type PullRequestDiffResult,
  type PullRequestFilesViewedResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

const { diffAtom, pagedDiffAtom, filesViewedAtom } = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const filePatch = (path: string) =>
    [
      `diff --git a/${path} b/${path}`,
      "index 1111111..2222222 100644",
      `--- a/${path}`,
      `+++ b/${path}`,
      "@@ -1,6 +1,6 @@",
      "-before()",
      "+after()",
      " one()",
      " two()",
      " three()",
      " four()",
      " five()",
      "",
    ].join("\n");
  const firstPage: PullRequestDiffResult = {
    patch: filePatch("a.ts"),
    truncated: false,
    nextCursor: null,
  };
  const pages: Record<string, PullRequestDiffResult> = {
    first: {
      patch: Array.from({ length: 40 }, (_, index) =>
        filePatch(index === 1 ? "early-1.test.ts" : `early-${index}.ts`),
      ).join(""),
      truncated: true,
      nextCursor: "page-2",
    },
    "page-2": { patch: filePatch("late.test.ts"), truncated: false, nextCursor: null },
  };
  return {
    // An environment query whose refetch returns equal content hands back the previous value
    // itself, so a refresh publishes a new result around the very same page.
    diffAtom: Atom.make(() => AsyncResult.success(firstPage)),
    pagedDiffAtom: Atom.family((cursor: string) =>
      Atom.make(() => AsyncResult.success(pages[cursor]!)),
    ),
    filesViewedAtom: Atom.make(() =>
      AsyncResult.success<PullRequestFilesViewedResult>({
        files: [
          { path: "early-0.ts", state: "viewed" },
          { path: "early-2.ts", state: "dismissed" },
          { path: "a.ts", state: "viewed" },
        ],
        truncated: false,
      }),
    ),
  };
});

const noFilesViewedAtom = await vi.hoisted(async () => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  return Atom.make(() =>
    AsyncResult.success<PullRequestFilesViewedResult>({ files: [], truncated: false }),
  );
});

const mocks = vi.hoisted(() => ({
  paged: false,
  noFilesViewed: false,
  diffCommits: [] as Array<string | undefined>,
}));

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("~/state/pullRequests"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    pullRequestEnvironment: {
      ...actual.pullRequestEnvironment,
      diff: (({ input }: { input: { cursor?: string; commit?: string } }) => {
        mocks.diffCommits.push(input.commit);
        return mocks.paged ? pagedDiffAtom(input.cursor ?? "first") : diffAtom;
      }) as never,
      filesViewed: (() => (mocks.noFilesViewed ? noFilesViewedAtom : filesViewedAtom)) as never,
    },
  };
});

import { render } from "../../../test/render";
import PullRequestCodeTab from "./PullRequestCodeTab";

const detail: PullRequestDetailView = {
  provider: SourceControlProviderKind.make("github"),
  projectId: ProjectId.make("project"),
  projectTitle: "Project",
  workspaceRoot: "/workspace",
  repository: "owner/repo",
  number: 1,
  title: "Test pull request",
  body: "",
  url: "https://github.com/owner/repo/pull/1",
  author: { login: "author", name: null, avatarUrl: null },
  viewer: "author",
  state: "open",
  isDraft: false,
  mergeability: "mergeable",
  additions: 1,
  deletions: 1,
  changedFiles: 1,
  headBranch: "feature",
  baseBranch: "main",
  createdAt: "2026-09-01T00:00:00Z",
  updatedAt: "2026-09-01T00:00:00Z",
  mergedAt: null,
  closedAt: null,
  reviewers: [],
  labels: [],
  checks: [],
  comments: [],
  commentCount: 0,
  commentsTruncated: false,
  reviewThreads: [],
  commits: [],
  mergeCapabilities: { merge: false, squash: false, rebase: false },
  capabilities: {
    diff: true,
    comment: false,
    search: true,
    actions: [],
    mergeMethods: [],
    review: { inlineComment: false, reply: false, resolve: false, verdicts: [] },
    reviewers: { request: false, listCandidates: false },
    edit: { changeRequest: false, comment: false },
  },
  viewerPermissions: {
    actions: [],
    comment: false,
    resolve: false,
    verdicts: [],
    requestReviewers: false,
  },
};

function setup({ paged, noFilesViewed = false }: { paged: boolean; noFilesViewed?: boolean }) {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  mocks.paged = paged;
  mocks.noFilesViewed = noFilesViewed;
  mocks.diffCommits = [];
  localStorage.clear();
}

const tab = (
  refreshToken: number,
  revealRequest: { readonly path: string; readonly nonce: number } | null = null,
  revealUrl?: string,
  onRevealSettled?: (url: string) => void,
  tabDetail: PullRequestDetailView = detail,
) => (
  <PullRequestCodeTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    reference={tabDetail}
    detail={tabDetail}
    selectedCommitOid={null}
    onSelectedCommitChange={() => {}}
    onRefresh={() => {}}
    refreshToken={refreshToken}
    revealRequest={revealRequest}
    revealUrl={revealUrl}
    onRevealSettled={onRevealSettled}
  />
);

it("keeps the diff after a refresh that brings back the same page", async () => {
  setup({ paged: false });
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0), { container });
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();

  await screen.rerender(tab(1));

  await expect
    .element(screen.getByText("This pull request has no file changes."))
    .not.toBeInTheDocument();
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
});

function pagedContainer() {
  const container = document.createElement("div");
  container.className = "flex h-[500px] w-[900px]";
  return container;
}

async function expectFileHeaderShown(
  screen: Awaited<ReturnType<typeof render>>,
  container: HTMLElement,
  path: string,
) {
  const header = screen.getByText(path, { exact: true }).first();
  await expect.element(header).toBeInTheDocument();
  await vi.waitFor(() => {
    const bounds = container.querySelector(".diff-render-surface")!.getBoundingClientRect();
    const { top, bottom } = header.element().getBoundingClientRect();
    expect(top).toBeGreaterThanOrEqual(bounds.top);
    expect(bottom).toBeLessThanOrEqual(bounds.bottom);
  });
}

it("scrolls to a file asked for as the tab opens", async () => {
  setup({ paged: true });
  const container = pagedContainer();
  await using screen = await render(tab(0, { path: "early-39.ts", nonce: 1 }), { container });

  await expectFileHeaderShown(screen, container, "early-39.ts");
});

it("pages forward to a file asked for that is not loaded yet, then scrolls to it", async () => {
  setup({ paged: true });
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, diffFilesCollapsed: true });
  using _preferences = {
    [Symbol.dispose]() {
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    },
  };
  const container = pagedContainer();
  await using screen = await render(tab(0), { container });
  await expect.element(screen.getByText("early-0.ts", { exact: true }).first()).toBeVisible();
  await screen.getByRole("button", { name: "Hide test files" }).click();

  const url = `${detail.url}/files#diff-${bytesToHex(sha256(new TextEncoder().encode("late.test.ts")))}R4-R5`;
  const settled = vi.fn();
  await screen.rerender(tab(0, null, url, settled));

  await expectFileHeaderShown(screen, container, "late.test.ts");
  await expect.element(screen.getByText("three()", { exact: true })).toBeVisible();
  await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(url));
  // A settled link keeps its test file past the filter, and a later click reveals it again.
  await screen.rerender(tab(0, { path: "early-0.ts", nonce: 1 }));
  await expectFileHeaderShown(screen, container, "early-0.ts");
  await screen.rerender(tab(0, { path: "early-0.ts", nonce: 1 }, url, settled));
  await expectFileHeaderShown(screen, container, "late.test.ts");
});

it("hides viewed files but keeps one pushed to since it was viewed", async () => {
  setup({ paged: true });
  const viewedDetail = {
    ...detail,
    capabilities: { ...detail.capabilities, viewedFiles: "host" as const },
  };
  await using screen = await render(tab(0, null, undefined, undefined, viewedDetail), {
    container: pagedContainer(),
  });
  await expect.element(screen.getByText("early-0.ts", { exact: true }).first()).toBeVisible();
  const hideViewed = screen.getByRole("button", { name: "Hide viewed files" });

  await hideViewed.click();

  await expect.element(screen.getByText("early-0.ts", { exact: true })).not.toBeInTheDocument();
  await expect.element(screen.getByText("early-2.ts", { exact: true }).first()).toBeVisible();
  await hideViewed.click();
  await expect.element(screen.getByText("early-0.ts", { exact: true }).first()).toBeVisible();
});

it("keeps the Hide viewed files toggle while its saved filter is on and nothing is viewed", async () => {
  setup({ paged: true, noFilesViewed: true });
  localStorage.setItem("t3code.pullRequestHideViewedFiles", "true");
  const viewedDetail = {
    ...detail,
    capabilities: { ...detail.capabilities, viewedFiles: "host" as const },
  };
  await using screen = await render(tab(0, null, undefined, undefined, viewedDetail), {
    container: pagedContainer(),
  });
  await screen.getByRole("button", { name: "Hide viewed files" }).click();

  await vi.waitFor(() =>
    expect(localStorage.getItem("t3code.pullRequestHideViewedFiles")).toBe("false"),
  );
});

it("marks a Shift-clicked range viewed after the first file of it was hidden", async () => {
  setup({ paged: true });
  const viewedDetail = {
    ...detail,
    capabilities: { ...detail.capabilities, viewedFiles: "host" as const },
  };
  const container = document.createElement("div");
  container.className = "h-[500px] w-[400px]";
  await using screen = await render(tab(0, null, undefined, undefined, viewedDetail), {
    container,
  });
  await screen.getByRole("button", { name: "Hide viewed files" }).click();
  await expect.element(screen.getByText("early-10.ts", { exact: true }).first()).toBeVisible();

  await screen.getByRole("checkbox", { name: "Viewed" }).first().click();
  await expect.element(screen.getByText("early-10.ts", { exact: true })).not.toBeInTheDocument();
  await screen
    .getByRole("checkbox", { name: "Viewed" })
    .nth(1)
    .click({ modifiers: ["Shift"] });

  await expect.element(screen.getByText("early-11.ts", { exact: true })).not.toBeInTheDocument();
});

it("keeps conversations reachable when every file is hidden", async () => {
  setup({ paged: false });
  const threadDetail: PullRequestDetailView = {
    ...detail,
    capabilities: { ...detail.capabilities, viewedFiles: "host" },
    reviewThreads: [
      {
        id: "thread",
        path: "a.ts",
        line: 1,
        side: "right",
        isResolved: false,
        isOutdated: false,
        comments: [],
      },
    ],
  };
  const container = document.createElement("div");
  container.className = "h-[500px] w-[400px]";
  await using screen = await render(tab(0, null, undefined, undefined, threadDetail), {
    container,
  });
  await screen.getByRole("button", { name: "Hide viewed files" }).click();
  await expect.element(screen.getByText("All files are hidden.")).toBeVisible();

  await expect.element(screen.getByText("Conversations not on the current diff")).toBeVisible();
});

it("never requests the diff of a selected commit the pull request no longer has", async () => {
  setup({ paged: false });
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  // The timeline can open a commit that a force-push removed from the pull request.
  await using screen = await render(
    <PullRequestCodeTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      reference={detail}
      detail={{
        ...detail,
        commits: [
          {
            oid: "kept",
            messageHeadline: "Kept commit",
            committedDate: "2026-09-01T00:00:00Z",
          },
        ],
      }}
      selectedCommitOid="gone"
      onSelectedCommitChange={() => {}}
      onRefresh={() => {}}
    />,
    { container },
  );

  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();
  await expect
    .element(screen.getByRole("button", { name: "Diff scope: All commits" }))
    .toBeVisible();
  expect(mocks.diffCommits).not.toContain("gone");
});

it("answers a commit's diff link only once that commit's diff is shown", async () => {
  setup({ paged: false });
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  const oid = "c".repeat(40);
  const withCommit = {
    ...detail,
    commits: [{ oid, messageHeadline: "Linked commit", committedDate: "2026-09-01T00:00:00Z" }],
  };
  const url = `${detail.url}/commits/${oid}#diff-${bytesToHex(sha256(new TextEncoder().encode("a.ts")))}R2`;
  const settled = vi.fn();
  const scoped = (selectedCommitOid: string | null, revealUrl?: string) => (
    <PullRequestCodeTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      reference={detail}
      detail={withCommit}
      selectedCommitOid={selectedCommitOid}
      onSelectedCommitChange={() => {}}
      onRefresh={() => {}}
      revealUrl={revealUrl}
      onRevealSettled={settled}
    />
  );
  await using screen = await render(scoped(null), { container });
  await expect.element(screen.getByText("1 file", { exact: true })).toBeVisible();

  // The panel selects the link's commit after this tab has already seen the link.
  await screen.rerender(scoped(null, url));
  expect(settled).not.toHaveBeenCalled();
  await screen.rerender(scoped(oid, url));
  await vi.waitFor(() => expect(settled).toHaveBeenCalledWith(url));
});

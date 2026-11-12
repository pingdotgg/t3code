import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import {
  EnvironmentId,
  ProjectId,
  SourceControlProviderKind,
  type PullRequestDetailView,
  type PullRequestDiffResult,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

import "~/index.css";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { DEFAULT_CLIENT_SETTINGS } from "@t3tools/contracts/settings";

const { diffAtom, pagedDiffAtom } = await vi.hoisted(async () => {
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
  };
});

const mocks = vi.hoisted(() => ({
  paged: false,
  diffCommits: [] as Array<string | undefined>,
  viewedPaths: null as ReadonlySet<string> | null,
  viewedListeners: new Set<() => void>(),
}));

function deliverViewedPaths(paths: ReadonlySet<string> | null) {
  mocks.viewedPaths = paths;
  for (const listener of mocks.viewedListeners) listener();
}

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() => vi.fn()) as never,
}));
vi.mock(import("./usePullRequestFilesViewed"), async () => {
  const { useSyncExternalStore } = await import("react");
  const subscribe = (listener: () => void) => {
    mocks.viewedListeners.add(listener);
    return () => mocks.viewedListeners.delete(listener);
  };
  return {
    usePullRequestFilesViewed: () => {
      const viewedPaths = useSyncExternalStore(subscribe, () => mocks.viewedPaths);
      return {
        enabled: viewedPaths !== null,
        isViewed: (path: string) => viewedPaths?.has(path) === true,
        isStale: () => false,
        setViewed: () => {},
        truncated: false,
        error: null,
        refresh: () => {},
      };
    },
  };
});
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

function setup({ paged }: { paged: boolean }) {
  window.localStorage.removeItem("t3code.diffHideTestFiles");
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  mocks.paged = paged;
  mocks.diffCommits = [];
  mocks.viewedPaths = null;
  mocks.viewedListeners.clear();
}

const tab = (
  refreshToken: number,
  revealRequest: { readonly path: string; readonly nonce: number } | null = null,
  revealUrl?: string,
  onRevealSettled?: (url: string) => void,
) => (
  <PullRequestCodeTab
    scrollerRef={() => {}}
    environmentId={EnvironmentId.make("environment")}
    reference={detail}
    detail={detail}
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

// regression: #13279 a Viewed answer that lands after a link reveals a file must not fold it
it("keeps a revealed file open when its Viewed mark loads afterwards", async () => {
  setup({ paged: false });
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, diffFilesCollapsed: false });
  using _preferences = {
    [Symbol.dispose]() {
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    },
  };
  mocks.viewedPaths = new Set();
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  await using screen = await render(tab(0, { path: "a.ts", nonce: 1 }), { container });
  await expect.element(screen.getByText("three()", { exact: true })).toBeVisible();

  deliverViewedPaths(new Set(["a.ts"]));
  await expect.element(screen.getByRole("checkbox", { name: "Viewed" })).toBeChecked();

  await expect
    .element(screen.getByRole("button", { name: "Collapse diff" }))
    .toHaveAttribute("aria-expanded", "true");
  await expect.element(screen.getByText("three()", { exact: true })).toBeVisible();
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
  await expect.element(screen.getByText(path, { exact: true }).first()).toBeInTheDocument();
  await vi.waitFor(() => {
    const header = screen
      .getByText(path, { exact: true })
      .elements()
      .find((element) => element.checkVisibility());
    if (!header) throw new Error(`No visible file header for ${path}`);
    const bounds = container.querySelector(".diff-render-surface")!.getBoundingClientRect();
    const { top, bottom } = header.getBoundingClientRect();
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
      window.localStorage.removeItem("t3code.diffHideTestFiles");
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    },
  };
  window.localStorage.setItem("t3code.diffHideTestFiles", "true");
  const container = pagedContainer();
  await using screen = await render(tab(0), { container });
  await expectFileHeaderShown(screen, container, "early-0.ts");

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

it("hides a resolved conversation behind avatars on its line until they are clicked", async () => {
  setup({ paged: false });
  __setClientSettingsForTests({ ...DEFAULT_CLIENT_SETTINGS, diffFilesCollapsed: false });
  using _preferences = {
    [Symbol.dispose]() {
      __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
    },
  };
  const container = document.createElement("div");
  container.className = "flex h-[700px] w-[900px]";
  const comment = {
    author: { login: "reviewer", name: null, avatarUrl: null },
    body: "Rename this.",
    createdAt: "2026-09-01T00:00:00Z",
    url: null,
  };
  const withThread = (isResolved: boolean, oldSideToo = false) => (
    <PullRequestCodeTab
      scrollerRef={() => {}}
      environmentId={EnvironmentId.make("environment")}
      reference={detail}
      detail={{
        ...detail,
        capabilities: {
          ...detail.capabilities,
          review: { ...detail.capabilities.review, reply: true },
        },
        viewerPermissions: { ...detail.viewerPermissions, comment: true },
        reviewThreads: [
          {
            id: "thread",
            path: "a.ts",
            line: 3,
            side: "right",
            isResolved,
            isOutdated: false,
            comments: [{ id: "comment", ...comment }],
          },
          ...(oldSideToo
            ? [
                {
                  id: "old-side",
                  path: "a.ts",
                  line: 3,
                  side: "left" as const,
                  isResolved: true,
                  isOutdated: false,
                  comments: [{ id: "old-side-comment", ...comment }],
                },
              ]
            : []),
        ],
      }}
      selectedCommitOid={null}
      onSelectedCommitChange={() => {}}
      onRefresh={() => {}}
    />
  );
  await using screen = await render(withThread(true), { container });
  const marker = screen.getByRole("button", { name: "Resolved conversation", exact: true });
  const card = (state: string) => screen.getByRole("button", { name: `${state}, 1 comment` });
  const reply = () => screen.getByRole("textbox", { name: "Reply to this conversation" });

  await expect.element(marker).toHaveAttribute("aria-expanded", "false");
  await expect.element(card("Resolved")).not.toBeInTheDocument();

  await marker.click();
  await expect.element(marker).toHaveAttribute("aria-expanded", "true");
  await expect.element(card("Resolved")).toHaveAttribute("aria-expanded", "true");
  // The redesigned card keeps a reply field open instead of a Reply button.
  await reply().click();
  await reply().fill("Unsent");

  // Hidden conversations stay mounted, so the unsent reply is still there.
  await marker.click();
  await expect.element(card("Resolved")).not.toBeInTheDocument();
  await marker.click();
  await expect.element(reply()).toHaveValue("Unsent");
  await marker.click();

  // Seen open and then resolved, it stays until the avatars are clicked.
  await screen.rerender(withThread(false));
  await expect.element(card("Open")).toBeVisible();
  await screen.rerender(withThread(true));
  await expect.element(card("Resolved")).toBeVisible();

  // Stacked view draws a context row once, so both sides' conversations share the avatars.
  await screen.rerender(withThread(true, true));
  await expect
    .element(screen.getByRole("button", { name: "2 resolved conversations" }))
    .toBeVisible();
});
